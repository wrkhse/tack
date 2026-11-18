import assert from "node:assert/strict";

import { Option, Predicate, Schema } from "effect";

import type { ChatRequest, StandInOptions } from "./model/stand-in.ts";
import { monitorInput } from "./plugins/tool-create.ts";
import type { Evidence, Scenario } from "./scenarios.ts";
import { describeRun, textFor } from "./scenarios.ts";

const TOOL = "monitor_create";
const DESCRIPTION = "Start watching a Jira issue";
const KEY = "PROJ-1";
const WATCHING = `watching ${KEY}`;
const RECORDED = `tack-tool ${TOOL} ${KEY}`;

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
    // OpenCode hands a plain JSON Schema header to the provider unchanged, so
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
 * OpenCode validates a call's arguments against the same header before it
 * reaches `execute`, so the error the model reads is OpenCode's
 * `Invalid arguments for tool "monitor_create"` list, not tack's. Tack's own
 * decode still guards every transport that validates nothing.
 */
const badInput: Scenario = {
  name: "t3 bad input",
  plugins: ["tool-create"],
  standIn: missingKey,
  check: (evidence) => {
    const details = describeRun(evidence);
    const error = textFor(evidence.requests, "tool");

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [],
      "a call the header rejects must not reach the handler\n" + details,
    );
    assert.ok(
      error.includes(TOOL) && error.includes("key"),
      "the model must receive an error naming the tool and the field\n" + details,
    );
  },
};

/** T3's rows: the tool contract, proven only where an adapter registers tools. */
export const toolScenarios: ReadonlyArray<Scenario> = [list, callRow, result, badInput];
