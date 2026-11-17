import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAgentPlugin } from "../../src/index.ts";

/** Writes what the shell tool ran, and its output, into the working directory. */
export const observe = createAgentPlugin(() => ({
  name: "observe",

  toolAfter: (call, result) => {
    if (call.tool !== "shell") return;

    writeFileSync(
      join(process.cwd(), "tack-observed.json"),
      JSON.stringify({
        command: call.input.command,
        output: result.output,
        isError: result.isError,
      }),
    );
  },
}));
