import assert from "node:assert/strict";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { recorded } from "./harness/recorder.ts";
import type { CommandResult } from "./harness/run.ts";
import { readOptionalText, type Sandbox } from "./harness/sandbox.ts";
import type { ChatRequest, StandIn } from "./model/stand-in.ts";
import { parseLoaded } from "./plugins/loaded.ts";

/** The agent a scenario ran against. */
export type AgentName = "opencode" | "pi";

/** Every tack plugin the suite loads, by file name. */
export type PluginName =
  | "deny-push"
  | "throws"
  | "throws-allowed"
  | "safe-push"
  | "signed-push"
  | "push-note"
  | "observe"
  | "append-wake"
  | "append-outside"
  | "append-now"
  | "append-next"
  | "permission-deny"
  | "idle-note"
  | "finished-note"
  | "lifecycle-note"
  | "interrupt-action"
  | "model-switch"
  | "compact-action";

/** What one CLI run left behind. */
export interface AgentRun {
  readonly command: CommandResult;
  readonly recorded: ReadonlyArray<string>;
  readonly requests: ReadonlyArray<ChatRequest>;
  readonly observedText: string | null;
  readonly loaded: ReadonlyArray<string>;
}

/** One CLI run plus the agent that made it. */
export interface Evidence extends AgentRun {
  readonly agent: AgentName;
}

/**
 * Reads what a finished CLI run left in its sandbox: the git log, the requests,
 * the loaded names, and the observed file.
 */
export const collectEvidence = (
  box: Sandbox,
  model: StandIn,
  command: CommandResult,
): Effect.Effect<AgentRun> =>
  Effect.gen(function* () {
    const requests = yield* model.requests;
    const recorderLines = yield* recorded(box.recorderFile);
    const observedText = yield* readOptionalText(join(box.projectDir, "tack-observed.json"));
    const loadedText = yield* readOptionalText(box.loadedFile);

    return {
      command,
      recorded: recorderLines,
      requests,
      observedText,
      loaded: loadedText === null ? [] : parseLoaded(loadedText),
    };
  });

/** One row of the conformance table: what loads, and what must be true after. */
export interface Scenario {
  readonly name: string;
  readonly plugins: ReadonlyArray<PluginName>;
  readonly check: (evidence: Evidence) => void;
}

const DENY_REASON = "tack-conformance: push denied";
const FAILURE_REASON = "tack-conformance: boom";
const NOTE = "tack-conformance-note: dry runs only.";
const REWRITTEN = "push origin main --dry-run";
const REWRITTEN_SIGNED = "push origin main --dry-run --signed";
const OBSERVED_COMMAND = "git push origin main --dry-run";

const TAIL_CHARS = 4000;

const ObservedSchema = Schema.Struct({
  command: Schema.String,
  output: Schema.String,
  isError: Schema.Boolean,
});

const tail = (text: string): string =>
  text.length > TAIL_CHARS ? "..." + text.slice(-TAIL_CHARS) : text;

/** The exit code and both output tails, for the message of a failed assertion. */
export const describeRun = (evidence: Evidence): string =>
  [
    "agent: " + evidence.agent,
    "exit code: " + evidence.command.exitCode,
    "stdout tail:",
    tail(evidence.command.stdout),
    "stderr tail:",
    tail(evidence.command.stderr),
  ].join("\n");

/** Names each once and sorted, so a marker written twice still names one plugin. */
const loadedNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(names)).toSorted();

/** Names for a failure message, where an empty list says so. */
const listed = (names: ReadonlyArray<string>): string =>
  names.length === 0 ? "none" : names.join(", ");

/** A run's loaded names, however the run was driven. */
export interface LoadedEvidence {
  readonly loaded: ReadonlyArray<string>;
}

/**
 * Asserts that the run loaded exactly the scenario's plugins: a plugin that
 * silently failed to load leaves its assertion about absence resting on
 * nothing. `details` names what the run saw when the sets differ.
 */
export const assertLoaded = (
  evidence: LoadedEvidence,
  plugins: ReadonlyArray<PluginName>,
  details: string,
): void => {
  const expected = loadedNames(plugins);
  const loaded = loadedNames(evidence.loaded);

  const message =
    "plugins that must load: " +
    listed(expected) +
    "\nplugins that loaded: " +
    listed(loaded) +
    "\n" +
    details;

  assert.deepEqual(loaded, expected, message);
};

/** The content of every message with one role, stringified into one searchable string. */
export const textFor = (requests: ReadonlyArray<ChatRequest>, role: string): string =>
  requests
    .flatMap((request) => request.messages)
    .flatMap((message) => (message.role === role ? [JSON.stringify(message.content)] : []))
    .join("\n");

const observed = (text: string) => Schema.decodeUnknownSync(ObservedSchema)(JSON.parse(text));

/** Asserts a denied call never reached git and that the model received the reason. */
const assertDenied = (evidence: Evidence): void => {
  const details = describeRun(evidence);

  assert.equal(evidence.command.exitCode, 0, details);
  assert.deepEqual(evidence.recorded, [], "a denied push must not reach git\n" + details);
  assert.ok(
    textFor(evidence.requests, "tool").includes(DENY_REASON),
    "the model must receive the deny reason\n" + details,
  );
};

const deny: Scenario = {
  name: "deny",
  plugins: ["deny-push"],
  check: assertDenied,
};

const denyAfter: Scenario = {
  name: "deny after",
  plugins: ["deny-push", "observe"],
  check: (evidence) => {
    assertDenied(evidence);
    assert.equal(
      evidence.observedText,
      null,
      "toolAfter must not run for a denied call\n" + describeRun(evidence),
    );
  },
};

const failClosed: Scenario = {
  name: "fail closed",
  plugins: ["throws"],
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(evidence.recorded, [], "a failed guard must not reach git\n" + details);
    assert.ok(
      textFor(evidence.requests, "tool").includes(FAILURE_REASON),
      "the model must receive the failure reason\n" + details,
    );
  },
};

const optOut: Scenario = {
  name: "opt out",
  plugins: ["throws-allowed", "safe-push"],
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [REWRITTEN],
      "a guard that opted into allow must not stop the next rewrite\n" + details,
    );
  },
};

const rewrite: Scenario = {
  name: "rewrite",
  plugins: ["safe-push"],
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(evidence.recorded, [REWRITTEN], "the rewrite must reach git\n" + details);
  },
};

const combine: Scenario = {
  name: "combine",
  plugins: ["safe-push", "signed-push"],
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [REWRITTEN_SIGNED],
      "both rewrites must reach git\n" + details,
    );
  },
};

const combineReversed: Scenario = {
  name: "combine reversed",
  plugins: ["signed-push", "safe-push"],
  check: (evidence) => {
    const details = describeRun(evidence);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.deepEqual(
      evidence.recorded,
      [REWRITTEN_SIGNED],
      "both rewrites must reach git in either load order\n" + details,
    );
  },
};

const append: Scenario = {
  name: "append",
  plugins: ["push-note"],
  check: (evidence) => {
    const details = describeRun(evidence);
    const firstWithTools = evidence.requests.find((request) => (request.tools ?? []).length > 0);

    assert.equal(evidence.command.exitCode, 0, details);
    assert.ok(
      firstWithTools !== undefined,
      "the model must receive a request with tools\n" + details,
    );
    assert.ok(
      textFor([firstWithTools], "user").includes(NOTE),
      "the prompt must carry the appended note\n" + details,
    );
  },
};

const after: Scenario = {
  name: "after",
  plugins: ["safe-push", "observe"],
  check: (evidence) => {
    const details = describeRun(evidence);
    const text = evidence.observedText;

    assert.equal(evidence.command.exitCode, 0, details);
    assert.ok(text !== null, "observe must write tack-observed.json\n" + details);

    const result = observed(text);

    assert.equal(
      result.command,
      OBSERVED_COMMAND,
      "observe must see the rewritten command\n" + details,
    );
    assert.ok(result.output.includes("recorded"), "observe must see the tool output\n" + details);
    assert.equal(result.isError, false, "the run must not be an error\n" + details);
  },
};

/** The conformance table: every scenario in both agents. */
export const scenarios: ReadonlyArray<Scenario> = [
  deny,
  denyAfter,
  failClosed,
  optOut,
  rewrite,
  combine,
  combineReversed,
  append,
  after,
];

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;

/** Asserts that a CLI reports the version its package is pinned to. */
export const assertVersion = (label: string, output: string, pin: string): void => {
  const match = VERSION_PATTERN.exec(output);

  assert.ok(match !== null, label + " printed no version: " + output);
  assert.equal(match[1], pin, label + " does not match the pinned " + pin + ": " + output);
};
