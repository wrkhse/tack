import { it } from "@effect/vitest";

import { runPiScenario } from "./harness/pi.ts";
import { runPiSessionScenario } from "./harness/t2-pi.ts";
import { scenarios } from "./scenarios.ts";
import { sessionScenariosFor } from "./session-scenarios.ts";
import { toolScenarios, toolSessionScenarios } from "./tool-scenarios.ts";
import {
  checkPinnedVersion,
  checkScenario,
  checkSessionScenario,
  iterations,
  requireSelection,
  selectedRows,
} from "./suite.ts";

const AGENT = "pi";
const PACKAGE = "@earendil-works/pi-coding-agent";

const scenarioRows = selectedRows(scenarios);
const sessionRows = selectedRows(sessionScenariosFor(AGENT));
const toolRows = selectedRows(toolScenarios);
const toolSessionRows = selectedRows(toolSessionScenarios);

requireSelection(AGENT, [scenarioRows, sessionRows, toolRows, toolSessionRows]);

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.pi),
);

for (const scenario of scenarioRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkScenario(AGENT, runPiScenario, scenario),
    );
  }
}

for (const scenario of toolRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkScenario(AGENT, runPiScenario, scenario),
    );
  }
}

for (const scenario of toolSessionRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkSessionScenario(AGENT, runPiSessionScenario, scenario),
    );
  }
}

for (const scenario of sessionRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkSessionScenario(AGENT, runPiSessionScenario, scenario),
    );
  }
}
