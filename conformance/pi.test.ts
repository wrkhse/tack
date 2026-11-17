import { it } from "@effect/vitest";

import { runPiScenario } from "./harness/pi.ts";
import { scenarios } from "./scenarios.ts";
import { checkPinnedVersion, checkScenario } from "./suite.ts";

const AGENT = "pi";
const PACKAGE = "@earendil-works/pi-coding-agent";

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.pi),
);

for (const scenario of scenarios) {
  it.live(AGENT + ": " + scenario.name, () => checkScenario(AGENT, runPiScenario, scenario));
}
