import { serveMcp } from "../../../src/index.ts";
import { mcpBroken } from "../mcp-broken.ts";

await serveMcp(mcpBroken, { timeoutMs: 30_000 });
