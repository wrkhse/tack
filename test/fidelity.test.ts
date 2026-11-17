import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Fidelity } from "../src/fidelity/index.ts";
import { capabilities, fidelity } from "../src/fidelity/index.ts";

function sourceIsCitable(source: string): boolean {
  return (
    source.startsWith("https://") ||
    source.includes("#L") ||
    source === "spike/unagent/REALM-SPIKE.md"
  );
}

function expectCited(table: Fidelity): void {
  for (const capability of capabilities) {
    const cell = table.cells[capability];

    expect(cell.how.trim().length).toBeGreaterThan(0);
    expect(sourceIsCitable(cell.source)).toBe(true);
    expect(["native", "fallback", "unsupported"]).toContain(cell.fidelity);
  }
}

describe("fidelity tables", () => {
  it.effect("cites every OpenCode cell", () =>
    Effect.sync(() => {
      expectCited(fidelity.opencode);
    }),
  );

  it.effect("cites every Pi cell", () =>
    Effect.sync(() => {
      expectCited(fidelity.pi);
    }),
  );

  it.effect("pins the version range and the verified version", () =>
    Effect.sync(() => {
      expect(fidelity.opencode.versions).toBe(">=2.3.0 <2.4.0");
      expect(fidelity.opencode.verifiedWith).toBe("2.3.0");
      expect(fidelity.pi.versions).toBe(">=1.5.2 <1.6.0");
      expect(fidelity.pi.verifiedWith).toBe("1.5.2");
    }),
  );
});
