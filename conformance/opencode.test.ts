import { it } from "@effect/vitest";

import { runOpenCodeScenario } from "./harness/opencode.ts";
import { runOpenCodeResumedScenario, runOpenCodeSessionScenario } from "./harness/t2-opencode.ts";
import { scenarios } from "./scenarios.ts";
import { sessionScenariosFor } from "./session-scenarios.ts";
import {
  checkPinnedVersion,
  checkScenario,
  checkSessionScenario,
  iterations,
  requireSelection,
  selectedRows,
} from "./suite.ts";
import { toolScenarios, toolSessionScenarios } from "./tool-scenarios.ts";

const AGENT = "opencode";
const PACKAGE = "@opencode/cli";

const scenarioRows = selectedRows(scenarios);
const sessionRows = selectedRows(sessionScenariosFor(AGENT));
const toolRows = selectedRows(toolScenarios);
const toolSessionRows = selectedRows(toolSessionScenarios);

requireSelection(AGENT, [scenarioRows, sessionRows, toolRows, toolSessionRows]);

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.opencode),
);

for (const scenario of scenarioRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkScenario(AGENT, runOpenCodeScenario, scenario),
    );
  }
}

for (const scenario of toolRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkScenario(AGENT, runOpenCodeScenario, scenario),
    );
  }
}

for (const scenario of toolSessionRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkSessionScenario(AGENT, runOpenCodeSessionScenario, scenario),
    );
  }
}

for (const scenario of sessionRows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkSessionScenario(
        AGENT,
        scenario.beforePlugin === true ? runOpenCodeResumedScenario : runOpenCodeSessionScenario,
        scenario,
      ),
    );
  }
}
