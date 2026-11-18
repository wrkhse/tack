import { serveMcp } from "../../../src/index.ts";
import { markLoaded } from "../loaded.ts";
import { mcpMonitor } from "../mcp-monitor.ts";

markLoaded("mcp-monitor");

await serveMcp(mcpMonitor, { timeoutMs: 30_000 });
