import { it } from "@effect/vitest";

import { runOpenCodeScenario } from "./harness/opencode.ts";
import { scenarios } from "./scenarios.ts";
import { checkPinnedVersion, checkScenario } from "./suite.ts";

const AGENT = "opencode";
const PACKAGE = "@opencode/cli";

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.opencode),
);

for (const scenario of scenarios) {
  it.live(AGENT + ": " + scenario.name, () => checkScenario(AGENT, runOpenCodeScenario, scenario));
}
