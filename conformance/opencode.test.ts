import { it } from "@effect/vitest";

import { runOpenCodeScenario } from "./harness/opencode.ts";
import { runOpenCodeSessionScenario } from "./harness/t2-opencode.ts";
import { scenarios } from "./scenarios.ts";
import { sessionScenarios } from "./session-scenarios.ts";
import { checkPinnedVersion, checkScenario, checkSessionScenario } from "./suite.ts";

const AGENT = "opencode";
const PACKAGE = "@opencode/cli";

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.opencode),
);

for (const scenario of scenarios) {
  it.live(AGENT + ": " + scenario.name, () => checkScenario(AGENT, runOpenCodeScenario, scenario));
}

for (const scenario of sessionScenarios) {
  it.live(AGENT + ": " + scenario.name, () =>
    checkSessionScenario(AGENT, runOpenCodeSessionScenario, scenario),
  );
}
