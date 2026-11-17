import { afterEach, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import type { AppendWhen, ModelRef, Outcome, SessionPort } from "../src/session.ts";
import { sessionHandle } from "../src/session.ts";
import { quietConsole } from "./helpers.ts";

const SESSION_ID = "session-1";

type PortCall =
  | {
      readonly action: "append";
      readonly input: {
        readonly sessionID: string;
        readonly text: string;
        readonly when: AppendWhen;
      };
    }
  | { readonly action: "compact"; readonly sessionID: string }
  | { readonly action: "interrupt"; readonly sessionID: string }
  | {
      readonly action: "setModel";
      readonly input: { readonly sessionID: string; readonly model: ModelRef };
    };

interface RecordingPort {
  readonly port: SessionPort;
  readonly calls: PortCall[];
}

/** A port that records every call and answers with one chosen outcome. */
function recordingPort(answer: Outcome = { status: "accepted" }): RecordingPort {
  const calls: PortCall[] = [];

  const record = (call: PortCall): Promise<Outcome> => {
    calls.push(call);

    return Promise.resolve(answer);
  };

  return {
    calls,
    port: {
      append: (input) => record({ action: "append", input }),
      compact: (sessionID) => record({ action: "compact", sessionID }),
      interrupt: (sessionID) => record({ action: "interrupt", sessionID }),
      setModel: (input) => record({ action: "setModel", input }),
    },
  };
}

/** A port whose every action rejects, as a harness call can. */
function rejectingPort(message: string): SessionPort {
  const reject = (): Promise<Outcome> => Promise.reject(new Error(message));

  return { append: reject, compact: reject, interrupt: reject, setModel: reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it.effect("calls the port with each action's arguments and the default when", () =>
  Effect.gen(function* () {
    const recorded = recordingPort();
    const session = sessionHandle(recorded.port, SESSION_ID);
    const model: ModelRef = { providerID: "anthropic", id: "claude-sonnet-4-5" };

    const outcomes = [
      yield* Effect.promise(() => session.append("note")),
      yield* Effect.promise(() => session.append("steer now", { when: "now" })),
      yield* Effect.promise(() => session.compact()),
      yield* Effect.promise(() => session.interrupt()),
      yield* Effect.promise(() => session.setModel(model)),
    ];

    expect(session.id).toBe(SESSION_ID);
    expect(recorded.calls).toEqual([
      { action: "append", input: { sessionID: SESSION_ID, text: "note", when: "next" } },
      { action: "append", input: { sessionID: SESSION_ID, text: "steer now", when: "now" } },
      { action: "compact", sessionID: SESSION_ID },
      { action: "interrupt", sessionID: SESSION_ID },
      { action: "setModel", input: { sessionID: SESSION_ID, model } },
    ]);
    expect(outcomes).toEqual([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);
  }),
);

it.effect("refuses a port call that rejects, naming its message", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const session = sessionHandle(rejectingPort("session is gone"), SESSION_ID);

    const outcome = yield* Effect.promise(() => session.append("note"));

    expect(outcome).toEqual({ status: "refused", reason: "session is gone" });
    expect(
      observed.lines().filter((line) => line.includes("append refused: session is gone")),
    ).toHaveLength(1);
  }),
);

it.effect("keeps an ended outcome without logging it", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const session = sessionHandle(recordingPort({ status: "ended" }).port, SESSION_ID);

    const outcome = yield* Effect.promise(() => session.interrupt());

    expect(outcome).toEqual({ status: "ended" });
    expect(observed.lines()).toEqual([]);
  }),
);

it.effect("logs a refusal once and keeps the outcome", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const refused: Outcome = { status: "refused", reason: "nothing to compact" };
    const session = sessionHandle(recordingPort(refused).port, SESSION_ID);

    const outcome = yield* Effect.promise(() => session.compact());

    expect(outcome).toEqual(refused);
    expect(
      observed.lines().filter((line) => line.includes("compact refused: nothing to compact")),
    ).toHaveLength(1);
  }),
);

it.effect("logs an unsupported action once and keeps the outcome", () =>
  Effect.gen(function* () {
    const observed = quietConsole();
    const session = sessionHandle(recordingPort({ status: "unsupported" }).port, SESSION_ID);

    const outcome = yield* Effect.promise(() => session.setModel({ providerID: "pi", id: "m" }));

    expect(outcome).toEqual({ status: "unsupported" });
    expect(
      observed.lines().filter((line) => line.includes("setModel is unsupported by this agent")),
    ).toHaveLength(1);
  }),
);
