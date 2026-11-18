import { vi } from "@effect/vitest";
import { Logger } from "effect";

import type { ResolvedPlugin } from "../src/plugin.ts";
import type { Outcome, Session, SessionPort } from "../src/session.ts";
import { sessionHandle } from "../src/session.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import { createToolRegistry } from "../src/tools/registry.ts";

/** Runs a call that must throw and returns what it threw. */
export function thrownBy(thunk: () => void): Error | undefined {
  try {
    thunk();

    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause : undefined;
  }
}

/** What an action reports when the agent took it. */
function accepted(): Outcome {
  return { status: "accepted" };
}

/** A port that accepts every action: the hook-runner tests never act on it. */
const accepting: SessionPort = {
  append: () => Promise.resolve(accepted()),
  compact: () => Promise.resolve(accepted()),
  interrupt: () => Promise.resolve(accepted()),
  setModel: () => Promise.resolve(accepted()),
};

/** The session a runner test's hook context carries; it only passes it through. */
export function sessionFor(sessionID: string): Session {
  return sessionHandle(accepting, sessionID);
}

/** A registry over no namespace, for a hook test that never adds a tool. */
export function noTools(): ToolRegistry {
  return createToolRegistry(
    {
      plugin: "test",
      scope: "test",
      source: "test",
      hasSession: true,
      port: {
        install: () => undefined,
        withdraw: () => undefined,
        settled: () => Promise.resolve(),
      },
    },
    [],
  );
}

interface QuietConsole {
  readonly lines: () => string[];
}

/** Silences Effect's default console logger and keeps the lines it wrote. */
export function quietConsole(): QuietConsole {
  const spy = vi.spyOn(console, "log").mockReturnValue(undefined);

  return { lines: () => spy.mock.calls.map((args) => args.map(String).join(" ")) };
}

/** A resolved plugin with tack's defaults, overridden by the case's own fields. */
export function resolvedPlugin(
  definition: Partial<ResolvedPlugin> & { readonly name: string },
): ResolvedPlugin {
  return {
    priority: 100,
    budgetMs: 5000,
    toolBeforeOnError: "deny",
    permissionAskedOnError: "leave",
    toolBefore: undefined,
    promptSent: undefined,
    toolAfter: undefined,
    sessionCreated: undefined,
    sessionEnded: undefined,
    responseFinished: undefined,
    sessionIdle: undefined,
    permissionAsked: undefined,
    tools: [],
    ...definition,
  };
}

interface LogCapture {
  readonly logger: Logger.Logger<unknown, void>;
  readonly lines: () => string[];
}

/** A logger that keeps every line the effect logs, for a case to inspect. */
export function logCapture(): LogCapture {
  const lines: string[] = [];

  const logger = Logger.make<unknown, void>(({ message }) => {
    lines.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
  });

  return { logger, lines: () => lines };
}
