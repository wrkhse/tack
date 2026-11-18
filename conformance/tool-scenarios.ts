import assert from "node:assert/strict";

import { Effect, Option, Predicate, Schema } from "effect";

import type { ChatRequest, StandInOptions } from "./model/stand-in.ts";
import { monitorInput } from "./plugins/tool-create.ts";
import type { Evidence, Scenario } from "./scenarios.ts";
import { describeRun, textFor } from "./scenarios.ts";
import type { SessionEvidence, SessionScenario } from "./session-scenarios.ts";
import { describeSession } from "./session-scenarios.ts";

const TOOL = "monitor_create";
const DESCRIPTION = "Start watching a Jira issue";
const KEY = "PROJ-1";
const WATCHING = `watching ${KEY}`;
const RECORDED = `tack-tool ${TOOL} ${KEY}`;
const DENY_REASON = "tack-conformance: monitor denied";
const REWRITTEN_KEY = "PROJ-2";
const REWRITTEN_RECORDED = `tack-tool ${TOOL} ${REWRITTEN_KEY}`;
const PUSH = "push it";

/** One scripted turn that calls the tool with the given arguments. */
const callWith = (input: Schema.Json): StandInOptions => ({ call: { name: TOOL, input } });

const call = callWith({ key: KEY });
const missingKey = callWith({});

/** The tools one request declared, as an OpenAI-compatible provider sends them. */
const DeclaredToolSchema = Schema.Struct({
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Unknown),
  }),
});

type DeclaredTool = Schema.Schema.Type<typeof DeclaredToolSchema>;

type ChatMessage = ChatRequest["messages"][number];

const isDeclaredTool = Schema.is(DeclaredToolSchema);

/** One part of a tool message's content, as an OpenAI-compatible provider sends it. */
const TextPartSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

/** A tool message's content: one string, or parts whose text is joined. */
const ToolContentSchema = Schema.Union([Schema.String, Schema.Array(TextPartSchema)]);

/** The text one message carries, whatever shape its content arrived in. */
function messageText(message: ChatMessage): string {
  const decoded = Schema.decodeUnknownOption(ToolContentSchema)(message.content);

  return Option.match(decoded, {
    onNone: () => "",
    onSome: (value) =>
      Predicate.isString(value) ? value : value.map((part) => part.text ?? "").join(""),
  });
}

/** The exact text of the tool messages in the last request that carried one. */
function toolTexts(requests: ReadonlyArray<ChatRequest>): ReadonlyArray<string> {
  const carrier = requests.findLast((request) =>
    request.messages.some((message) => message.role === "tool"),
  );

  if (carrier === undefined) {
    return [];
  }

  return carrier.messages.flatMap((message) =>
    message.role === "tool" ? [messageText(message)] : [],
  );
}

/** Every tool the first tool-bearing request declared. */
function declaredTools(requests: ReadonlyArray<ChatRequest>): ReadonlyArray<DeclaredTool> {
  const request = requests.find((candidate) => (candidate.tools ?? []).length > 0);

  return request === undefined ? [] : (request.tools ?? []).filter(isDeclaredTool);
}

/** The one declared tool every T3 row expects. */
function declared(evidence: Evidence): DeclaredTool {
  const details = describeRun(evidence);
  const found = declaredTools(evidence.requests).find((entry) => entry.function.name === TOOL);

  assert.ok(found !== undefined, `the first request must declare ${TOOL}\n` + details);

  return found;
}

/** Every tool name one request declared. */
function declaredIn(request: ChatRequest): ReadonlyArray<string> {
  return (request.tools ?? []).flatMap((entry) => {
    const decoded = Schema.decodeUnknownOption(DeclaredToolSchema)(entry);

    return Option.match(decoded, {
      onNone: () => [],
      onSome: (tool) => [tool.function.name],
    });
  });
}

/** A request that starts a turn: tools, and the person's prompt last. */
function startsTurn(request: ChatRequest): boolean {
  const last = request.messages.at(-1);

  return (
    (request.tools ?? []).length > 0 &&
    last?.role === "user" &&
    JSON.stringify(last.content ?? "").includes(PUSH)
  );
}

/** The last tool message's text in a request at or after `start`. */
function lastToolTextFrom(requests: ReadonlyArray<ChatRequest>, start: number): string {
  const carrier = requests
    .slice(start)
    .findLast((request) => request.messages.some((message) => message.role === "tool"));

  const message = carrier?.messages.findLast((candidate) => candidate.role === "tool");

  return message === undefined ? "" : messageText(message);
}

const list: Scenario = {
  name: "t3 list",
  plugins: ["tool-create"],
  standIn: call,
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);

    const found = declared(evidence);

    assert.equal(
      found.function.description,
      DESCRIPTION,
      "the declaration must carry its description\n" + details,
    );
    // Both agents hand a plain JSON Schema header to the provider unchanged, so
    // there is no normalisation to allow for: the declaration is the header.
    assert.deepEqual(
      found.function.parameters,
      monitorInput,
      "the declaration must carry the header unchanged\n" + details,
    );
  },
};

const callRow: Scenario = {
  name: "t3 call",
  plugins: ["tool-create"],
  standIn: call,
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [RECORDED],
      "the handler must run inside the agent and record its own call\n" + details,
    );
  },
};

const result: Scenario = {
  name: "t3 result",
  plugins: ["tool-create"],
  standIn: call,
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      toolTexts(evidence.requests),
      [WATCHING],
      "the next request must carry exactly the content the handler returned\n" + details,
    );
  },
};

/**
 * Asserts a refused call never reached its handler and that the model read an
 * error naming the field.
 */
const assertRefusedWithField = (evidence: Evidence, message: string): void => {
  const details = describeRun(evidence);
  const error = textFor(evidence.requests, "tool");

  assert.equal(evidence.command.exitCode, 0, details);
  assert.deepEqual(evidence.recorded, [], message + "\n" + details);
  assert.ok(error.includes("key"), "the model must receive an error naming the field\n" + details);
};

/**
 * Each agent validates a call's arguments against the same header before the
 * tool runs, so the error the model reads is the agent's own, naming the field:
 * OpenCode's `Invalid arguments for tool "monitor_create"` list, or Pi's
 * pi-schema message. Tack's own decode still guards every transport that
 * validates nothing.
 */
const badInput: Scenario = {
  name: "t3 bad input",
  plugins: ["tool-create"],
  standIn: missingKey,
  check: (evidence) => {
    assertRefusedWithField(evidence, "a call the header rejects must not reach the handler");
  },
};

const toolDeny: Scenario = {
  name: "t3 tool deny",
  plugins: ["tool-deny", "tool-create"],
  standIn: call,
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(evidence.recorded, [], "a denied tool must not reach its handler\n" + details);
    assert.ok(
      textFor(evidence.requests, "tool").includes(DENY_REASON),
      "the model must receive the deny reason\n" + details,
    );
  },
};

const toolRewrite: Scenario = {
  name: "t3 tool rewrite",
  plugins: ["tool-rewrite", "tool-create"],
  standIn: call,
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [REWRITTEN_RECORDED],
      "the rewritten input must reach the handler\n" + details,
    );
  },
};

const rewriteRejected: Scenario = {
  name: "t3 rewrite rejected",
  plugins: ["tool-rewrite-bad", "tool-create"],
  standIn: call,
  check: (evidence) => {
    assertRefusedWithField(evidence, "a rewrite the schema rejects must not reach the handler");
  },
};

/**
 * Pi refuses a tack tool named after its built-in `read` at the first session
 * start. Print mode reports that refusal as `Extension error`, and the refused
 * plugin's slot entry is gone before the next plugin reports the session, so
 * the witness marker proves the other plugin still leads.
 */
const collision: Scenario = {
  name: "t3 pi tool collision",
  plugins: ["tool-collide", "tool-witness"],
  only: "pi",
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.ok(
      evidence.command.stderr.includes('tack: two tools named "read" are registered in pi'),
      "the person must see the refusal\n" + details,
    );
    assert.deepEqual(
      evidence.observedText,
      '{"event":"created"}',
      "the refused plugin must not stop the other plugin's session start\n" + details,
    );
    assert.deepEqual(
      evidence.recorded,
      ["push origin main"],
      "the run must continue after the refusal\n" + details,
    );
  },
};

/**
 * The withdrawal row runs long-lived: after the plugin removes the tool, the
 * next request must declare it nowhere, and a scripted call to its name must
 * answer an error rather than a stale success. The marker proves the removal
 * was requested before the second prompt.
 */
const withdraw: SessionScenario = {
  name: "t3 withdraw",
  plugins: ["tool-withdraw"],
  standIn: { ...call, callOnPrompt: true },
  run: (driver) =>
    Effect.gen(function* () {
      yield* driver.prompt(PUSH);
      yield* driver.settle();
      yield* driver.waitMarker("tool-withdraw");
      yield* driver.prompt(PUSH);
      yield* driver.settle();
    }),
  check: (evidence: SessionEvidence) => {
    const details = describeSession(evidence);

    const prompts = evidence.requests.flatMap((request, index) =>
      startsTurn(request) ? [index] : [],
    );

    const second = prompts[1];

    assert.ok(second !== undefined, "the row must send a second prompt\n" + details);

    const next = evidence.requests.find(
      (request, index) => index >= second && (request.tools ?? []).length > 0,
    );

    assert.ok(next !== undefined, "the second prompt must reach the model\n" + details);
    assert.ok(
      !declaredIn(next).includes(TOOL),
      "the request after the withdrawal must not declare the withdrawn tool\n" + details,
    );
    assert.deepEqual(
      evidence.recorded,
      [RECORDED],
      "a call to the withdrawn name must not reach the handler\n" + details,
    );

    const error = lastToolTextFrom(evidence.requests, second);

    assert.ok(
      error.includes(TOOL) && !error.includes(WATCHING),
      "the withdrawn call must answer an error naming the tool, not a stale success\n" + details,
    );
  },
};

/** T3's one-shot rows: the tool contract, proven in both agents. */
export const toolScenarios: ReadonlyArray<Scenario> = [
  list,
  callRow,
  result,
  badInput,
  toolDeny,
  toolRewrite,
  rewriteRejected,
  collision,
];

/** T3's long-lived row: a withdrawal needs a second request after the removal. */
export const toolSessionScenarios: ReadonlyArray<SessionScenario> = [withdraw];
