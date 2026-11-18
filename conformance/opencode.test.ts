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
  selectedRows,
} from "./suite.ts";

const AGENT = "opencode";
const PACKAGE = "@opencode/cli";

it.live(AGENT + " reports the pinned version", () =>
  checkPinnedVersion(AGENT, PACKAGE, (box) => box.opencode),
);

for (const scenario of selectedRows(scenarios)) {
  for (const iteration of iterations()) {
    it.live(iteration.name(AGENT + ": " + scenario.name), () =>
      checkScenario(AGENT, runOpenCodeScenario, scenario),
    );
  }
}

for (const scenario of selectedRows(sessionScenariosFor(AGENT))) {
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
