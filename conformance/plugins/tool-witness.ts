import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAgentPlugin } from "../../src/index.ts";

/**
 * Records the session it was told about, so the collision row proves the
 * refused plugin's session start did not stop the next plugin's report.
 */
export const toolWitness = createAgentPlugin(() => ({
  name: "tool-witness",

  sessionCreated: () => {
    writeFileSync(join(process.cwd(), "tack-observed.json"), JSON.stringify({ event: "created" }));
  },
}));
