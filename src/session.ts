import { Effect } from "effect";

/**
 * When appended text reaches the agent: `"now"` steers at the running turn's
 * next step boundary, `"next"` waits for the turn to end, and `"wake"` starts
 * a turn on an idle session.
 */
export type AppendWhen = "now" | "next" | "wake";

/**
 * What an action did. An action never throws and never rejects, so a caller may
 * ignore the result: `"accepted"` means the agent took it, `"unsupported"`
 * that this agent has no such action, `"refused"` that the agent or its
 * harness declined, and `"ended"` that the session is over, which a plugin may
 * act on by design.
 */
export type Outcome =
  | { readonly status: "accepted" }
  | { readonly status: "unsupported" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "ended" };

/** The model a session switches to, named as both agents name it. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

/**
 * One plugin's handle on a session, live from the session's start to its end.
 *
 * The handle is the only way a plugin acts on a session. Actions from several
 * plugins are not combined: each is carried out in the order it was made.
 */
export interface Session {
  readonly id: string;

  /** Appends text as a synthetic message nobody typed. `when` defaults to `"next"`. */
  append(text: string, options?: { readonly when?: AppendWhen }): Promise<Outcome>;

  /** Asks the agent to compact the session's history. */
  compact(): Promise<Outcome>;

  /** Stops the turn the session is running. */
  interrupt(): Promise<Outcome>;

  /** Switches the model later turns use. */
  setModel(model: ModelRef): Promise<Outcome>;
}

/** What an adapter supplies so a handle reaches its agent. */
export interface SessionPort {
  readonly append: (input: {
    readonly sessionID: string;
    readonly text: string;
    readonly when: AppendWhen;
  }) => Promise<Outcome>;
  readonly compact: (sessionID: string) => Promise<Outcome>;
  readonly interrupt: (sessionID: string) => Promise<Outcome>;
  readonly setModel: (input: {
    readonly sessionID: string;
    readonly model: ModelRef;
  }) => Promise<Outcome>;
}

const DEFAULT_WHEN: AppendWhen = "next";

/**
 * Logs a failed action once. A refusal and an unsupported action name
 * something a plugin author can fix; an ended session is not a failure, so a
 * plugin that acts after it closed is not logged.
 */
function announce(action: string, sessionID: string, outcome: Outcome): Effect.Effect<Outcome> {
  if (outcome.status === "refused") {
    return Effect.logWarning(
      `tack: session ${sessionID} ${action} refused: ${outcome.reason}`,
    ).pipe(Effect.as(outcome));
  }

  if (outcome.status === "unsupported") {
    return Effect.logWarning(
      `tack: session ${sessionID} ${action} is unsupported by this agent`,
    ).pipe(Effect.as(outcome));
  }

  return Effect.succeed(outcome);
}

/**
 * Runs one port call and turns a throw or rejection into a refusal, so the
 * caller never sees an exception, then logs the outcome when it is a failure.
 */
function settle(action: string, sessionID: string, run: () => Promise<Outcome>): Promise<Outcome> {
  const attempt = Effect.tryPromise({
    try: () => Promise.resolve().then(run),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

  return Effect.runPromise(
    attempt.pipe(
      Effect.match({
        onFailure: (reason): Outcome => ({ status: "refused", reason }),
        onSuccess: (outcome) => outcome,
      }),
      Effect.flatMap((outcome) => announce(action, sessionID, outcome)),
    ),
  );
}

/**
 * Builds a handle for one call site, against the port its agent adapter
 * supplies. Every action carries the session's id and reports an outcome; a
 * failed one is logged here, so ignoring the result never hides it.
 */
export function sessionHandle(port: SessionPort, sessionID: string): Session {
  return {
    id: sessionID,
    append: (text, options) =>
      settle("append", sessionID, () =>
        port.append({ sessionID, text, when: options?.when ?? DEFAULT_WHEN }),
      ),
    compact: () => settle("compact", sessionID, () => port.compact(sessionID)),
    interrupt: () => settle("interrupt", sessionID, () => port.interrupt(sessionID)),
    setModel: (model) => settle("setModel", sessionID, () => port.setModel({ sessionID, model })),
  };
}
