import { it } from "@effect/vitest";

import { runPiScenario } from "./harness/pi.ts";
import { runPiSessionScenario } from "./harness/t2-pi.ts";
import { scenarios } from "./scenarios.ts";
import { sessionScenariosFor } from "./session-scenarios.ts";
import { checkPinnedVersion, checkScenario, checkSessionScenario } from "./suite.ts";

const AGENT = "pi";
const PACKAGE = "@earendil-works/pi-coding-agent";

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.pi),
);

for (const scenario of scenarios) {
  it.live(AGENT + ": " + scenario.name, () => checkScenario(AGENT, runPiScenario, scenario));
}

for (const scenario of sessionScenariosFor(AGENT)) {
  it.live(AGENT + ": " + scenario.name, () =>
    checkSessionScenario(AGENT, runPiSessionScenario, scenario),
  );
}
