import { it } from "@effect/vitest";
import { Effect } from "effect";

import { runOpenCodeScenario } from "./harness/opencode.ts";
import { cliVersion } from "./harness/run.ts";
import { pinnedVersion, sandbox } from "./harness/sandbox.ts";
import { assertVersion, scenarios } from "./scenarios.ts";

const AGENT = "opencode";
const PACKAGE = "@opencode/cli";

it.live(AGENT + " reports the pinned version", () =>
  Effect.gen(function* () {
    const box = yield* sandbox;
    const pin = yield* pinnedVersion(PACKAGE);
    const output = yield* cliVersion(box.opencode.bin, box.opencode.env, box.dir);

    assertVersion(AGENT, output, pin);
  }),
);

for (const scenario of scenarios) {
  it.live(AGENT + ": " + scenario.name, () =>
    Effect.gen(function* () {
      const run = yield* runOpenCodeScenario(scenario);

      yield* Effect.sync(() => {
        scenario.check({ agent: AGENT, ...run });
      });
    }),
  );
}
