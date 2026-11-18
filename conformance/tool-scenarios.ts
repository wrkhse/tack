import assert from "node:assert/strict";

import { Schema } from "effect";

import type { ChatRequest, StandInOptions } from "./model/stand-in.ts";
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

const isDeclaredTool = Schema.is(DeclaredToolSchema);

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
    assert.ok(
      JSON.stringify(found.function.parameters).includes('"key"'),
      "the declaration must carry its input schema\n" + details,
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
    assert.ok(
      textFor(evidence.requests, "tool").includes(WATCHING),
      "the next request must carry the content the handler returned\n" + details,
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
