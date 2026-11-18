import { Buffer } from "node:buffer";

import {
  Duration,
  Effect,
  JsonSchema,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  SchemaRepresentation,
} from "effect";

import type { Session } from "../session.ts";
import type { ToolRegistry } from "./registry.ts";

/**
 * The most UTF-8 bytes one result's content may hold. A result over the limit
 * is refused, never truncated: a partial answer the model cannot tell is
 * partial is worse than a failure the tool can page around.
 */
export const MAX_RESULT_BYTES = 262_144;

/** How long a handler may run when its definition names no `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A tool name every transport can carry unquoted, unchanged and unnamespaced. */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * What one call sees beside its input: the call's id, the transport's abort
 * signal when it has one, the session the agent runs the call in when it has
 * one, and the registry the plugin's tools live in.
 */
export interface ToolContext {
  readonly callId: string;
  readonly signal: AbortSignal | undefined;
  readonly session: Session | undefined;
  readonly tools: ToolRegistry;
}

/**
 * What a handler returns. `content` is what the model reads, one entry per
 * message; `details` is data for the plugin and the harness UI, never the
 * model; `isError` reports a failure the model reads as a result.
 */
const ToolCallResultSchema = Schema.Struct({
  content: Schema.Array(Schema.String),
  details: Schema.optional(Schema.JsonObject),
  isError: Schema.optional(Schema.Boolean),
});

export type ToolCallResult = Schema.Schema.Type<typeof ToolCallResultSchema>;

/**
 * One tool as its author writes it. The header is plain JSON Schema, so one
 * definition serves every agent and a later core in another language; `run`
 * is the only behaviour, and the generic names the input it receives.
 */
export interface ToolDefinition<Input extends Schema.Json = Schema.Json> {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema.JsonSchema;
  /** Whether the handler needs the agent's session; a transport without one refuses it. */
  readonly needsSession?: boolean;
  /** The longest the handler may run; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * A method, not a property, so a definition of a narrower input is still
   * assignable to the erased one: every transport decodes the call's input
   * against the header before `run` sees it.
   */
  run(input: Input, ctx: ToolContext): ToolCallResult | Promise<ToolCallResult>;
}

/**
 * One call's input as the agent supplied it, before tack trusts it. It is a
 * record rather than a bare parameter so the untrusted value stays a field at
 * the boundary; the tool's header decodes it before any handler sees it.
 */
export interface ToolCallInput {
  readonly input: unknown;
}

/**
 * A definition tack refuses to load. The message names the plugin, the tool
 * and the rule it broke.
 */
export class InvalidTool extends Schema.TaggedError<
  InvalidTool,
  { readonly brand: unique symbol }
>()("InvalidTool", {
  plugin: Schema.String,
  tool: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `tack: tool "${this.tool}" in plugin "${this.plugin}" is invalid: ${this.reason}`;
  }
}

/**
 * A definition after its load check: the header compiled once into the schema
 * every call decodes with, and the handler erased to the JSON every transport
 * can carry.
 */
export interface CompiledTool {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema.JsonSchema;
  readonly needsSession: boolean;
  readonly timeoutMs: number;
  readonly schema: Schema.Constraint;
  run(input: Schema.Json, ctx: ToolContext): ToolCallResult | Promise<ToolCallResult>;
}

/** One definition built, or the rule that refused it. */
type Build =
  | { readonly ok: true; readonly tool: CompiledTool }
  | { readonly ok: false; readonly error: InvalidTool };

/**
 * Declares one tool. The generic names the handler's input; `input` is the
 * header the model reads and every agent validates against.
 */
export function tool<Input extends Schema.Json>(
  definition: ToolDefinition<Input>,
): ToolDefinition<Input> {
  return definition;
}

/** A failure's message, whether it is an Error or a value thrown in its place. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A result the model reads as a failure, with one message. */
function failed(message: string): ToolCallResult {
  return { content: [message], isError: true };
}

/**
 * Reads one header once, as JSON Schema draft 2020-12, and turns it into the
 * schema every call decodes with. The importer names the keyword or reference
 * it cannot translate, so a refused header says what to change.
 */
function readHeader(
  plugin: string,
  name: string,
  header: JsonSchema.JsonSchema,
): Schema.Constraint | InvalidTool {
  try {
    return SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(header));
  } catch (cause) {
    return new InvalidTool({ plugin, tool: name, reason: messageOf(cause) });
  }
}

/** The formatter every refused input is reported through, so the message names the field. */
const formatIssue = SchemaIssue.makeFormatterDefault();

/** The UTF-8 bytes one result's content holds, summed over its entries. */
function contentBytes(content: ReadonlyArray<string>): number {
  let total = 0;

  for (const part of content) {
    total += Buffer.byteLength(part, "utf8");
  }

  return total;
}

/**
 * Checks one definition and compiles its header. The map key is the name the
 * plugin lists the tool under, which must be the tool's own name so every
 * transport spells it the same way.
 */
export function compileDefinition(
  plugin: string,
  key: string,
  definition: ToolDefinition,
  hasSession: boolean,
): Build {
  const { name } = definition;

  if (!TOOL_NAME.test(name)) {
    return {
      ok: false,
      error: new InvalidTool({ plugin, tool: name, reason: "name must match [a-z][a-z0-9_]*" }),
    };
  }

  if (key !== name) {
    return {
      ok: false,
      error: new InvalidTool({
        plugin,
        tool: name,
        reason: `the tools entry "${key}" must hold the tool named "${name}"`,
      }),
    };
  }

  if (definition.needsSession === true && !hasSession) {
    return {
      ok: false,
      error: new InvalidTool({
        plugin,
        tool: name,
        reason: "needsSession is true, but this transport has no agent session",
      }),
    };
  }

  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return {
      ok: false,
      error: new InvalidTool({
        plugin,
        tool: name,
        reason: "timeoutMs must be a positive integer",
      }),
    };
  }

  const schema = readHeader(plugin, name, definition.input);

  if (schema instanceof InvalidTool) {
    return { ok: false, error: schema };
  }

  return {
    ok: true,
    tool: {
      name,
      description: definition.description,
      input: definition.input,
      needsSession: definition.needsSession === true,
      timeoutMs,
      schema,
      run: (input, ctx) => definition.run(input, ctx),
    },
  };
}

/**
 * Compiles every tool a definition lists, in entry order, and refuses a name
 * two entries share. A header the importer cannot read fails the load, naming
 * the tool.
 */
export function compileTools(
  plugin: string,
  tools: Readonly<Record<string, ToolDefinition>> | undefined,
  hasSession: boolean,
): Effect.Effect<ReadonlyArray<CompiledTool>, InvalidTool> {
  return Effect.suspend(() => {
    const entries = Object.entries(tools ?? {});
    const keys = new Map<string, string>();
    const compiled: Array<CompiledTool> = [];

    for (const [key, definition] of entries) {
      const seen = keys.get(definition.name);

      if (seen !== undefined) {
        return Effect.fail(
          new InvalidTool({
            plugin,
            tool: definition.name,
            reason: `the tools entries "${seen}" and "${key}" share this name`,
          }),
        );
      }

      keys.set(definition.name, key);
    }

    for (const [key, definition] of entries) {
      const built = compileDefinition(plugin, key, definition, hasSession);

      if (!built.ok) {
        return Effect.fail(built.error);
      }

      compiled.push(built.tool);
    }

    return Effect.succeed(compiled);
  });
}

/**
 * Decodes the call's input against the tool's header. The header's schema is
 * made, not decoded, so it needs no services and no encoded form: an imported
 * JSON Schema has one representation on both sides.
 */
function decodeInput(
  compiled: CompiledTool,
  call: ToolCallInput,
): Effect.Effect<Result.Result<Schema.Json, ToolCallResult>> {
  const reject = (reason: string): Result.Result<Schema.Json, ToolCallResult> =>
    Result.fail(failed(`tack: tool "${compiled.name}" rejected its input: ${reason}`));

  return SchemaParser.makeEffect(compiled.schema)(call.input).pipe(
    Effect.match({
      onFailure: (issue) => reject(formatIssue(issue)),
      onSuccess: (value) => {
        const json = Schema.decodeUnknownResult(Schema.Json)(value);

        return Result.isFailure(json)
          ? reject("the header admitted a non-JSON value")
          : Result.succeed(json.success);
      },
    }),
  );
}

/**
 * The handler's context, with one signal that fires when the transport stops
 * the call or tack's timeout passes. Racing the handler interrupts tack's
 * fiber, not the promise a handler already started, so the signal is how a
 * handler that checks it learns to stop.
 */
function stoppable(ctx: ToolContext, stop: AbortSignal): ToolContext {
  const signals = ctx.signal === undefined ? [stop] : [ctx.signal, stop];

  return { ...ctx, signal: AbortSignal.any(signals) };
}

/** Runs the handler with the decoded input, under the tool's timeout. */
function runHandler(
  compiled: CompiledTool,
  input: Schema.Json,
  ctx: ToolContext,
): Effect.Effect<ToolCallResult> {
  const stop = new AbortController();

  const attempt = Effect.tryPromise({
    try: () => Promise.resolve(compiled.run(input, stoppable(ctx, stop.signal))),
    catch: (cause) => `tack: tool "${compiled.name}" failed: ${messageOf(cause)}`,
  }).pipe(
    Effect.match({ onFailure: failed, onSuccess: (result) => result }),
    // A finished call stops watching both signals, so a long-lived transport
    // signal collects no listener from a handler that already answered.
    Effect.ensuring(Effect.sync(() => stop.abort())),
  );

  const timeout = Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(compiled.timeoutMs));
    yield* Effect.sync(() => stop.abort());

    return failed(`tack: tool "${compiled.name}" timed out after ${compiled.timeoutMs} ms`);
  });

  return Effect.raceFirst(attempt, timeout);
}

/** Validates what the handler returned and refuses a result over the size limit. */
function checkedResult(compiled: CompiledTool, value: ToolCallResult): ToolCallResult {
  const decoded = Schema.decodeResult(ToolCallResultSchema)(value);

  if (Result.isFailure(decoded)) {
    return failed(`tack: tool "${compiled.name}" returned an invalid result`);
  }

  const result = decoded.success;
  const size = contentBytes(result.content);

  if (size > MAX_RESULT_BYTES) {
    return failed(
      `tack: tool "${compiled.name}" returned ${size} bytes of content, over the ${MAX_RESULT_BYTES}-byte limit`,
    );
  }

  return result;
}

/**
 * Runs one call: the input is decoded against the header, the handler runs
 * under its timeout, and a failure of any kind becomes an error result the
 * model reads instead of an exception the harness has to invent a message for.
 */
export function invokeTool(
  compiled: CompiledTool,
  call: ToolCallInput,
  ctx: ToolContext,
): Effect.Effect<ToolCallResult> {
  return Effect.gen(function* () {
    const decoded = yield* decodeInput(compiled, call);

    if (Result.isFailure(decoded)) {
      return decoded.failure;
    }

    const returned = yield* runHandler(compiled, decoded.success, ctx);

    return checkedResult(compiled, returned);
  });
}
