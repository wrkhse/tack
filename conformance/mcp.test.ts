import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runBrokenMcpScenario, runMcpScenario } from "./harness/mcp.ts";
import { monitorInput } from "./plugins/tool-create.ts";
import { iterations, requireSelection, selectedRows } from "./suite.ts";

const rows = selectedRows([{ name: "mcp stdio" }, { name: "mcp load refusal" }]);

requireSelection("mcp", [rows]);

for (const row of rows) {
  for (const iteration of iterations()) {
    it.live(iteration.name(row.name), () =>
      Effect.gen(function* () {
        if (row.name === "mcp load refusal") {
          const refused = yield* runBrokenMcpScenario();

          expect(refused.exitCode).toBe(1);
          expect(refused.stderr).toContain('tool "monitor_session"');
          expect(refused.stderr).toContain("needsSession is true");

          return;
        }

        const evidence = yield* runMcpScenario();

        expect(evidence.era).toBe("modern");
        expect(evidence.discover.supportedVersions).toEqual(["2026-07-28"]);
        expect(evidence.listed.tools).toEqual([
          {
            name: "monitor_create",
            description: "Start watching a Jira issue",
            inputSchema: monitorInput,
          },
        ]);
        expect(evidence.called.content).toEqual([{ type: "text", text: "watching PROJ-1" }]);
        expect(evidence.called.isError).toBeUndefined();
        expect(evidence.recorded).toEqual(["tack-tool monitor_create PROJ-1"]);
        expect(Array.from(new Set(evidence.loaded)).toSorted()).toEqual(["mcp-monitor"]);
        expect(evidence.exitCode).toBe(0);
        expect(evidence.stderr).toBe("");
      }),
    );
  }
}
