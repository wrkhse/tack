import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noFlakeMasking } from "./no-flake-masking.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const retry = { messageId: "retry" };
const timeout = { messageId: "timeout" };
const stale = { messageId: "stale" };

tester.run("landmines-testing/no-flake-masking", noFlakeMasking, {
  valid: [
    "test(\"loads\", async () => {});",
    "test(\"loads\", { tags: [\"slow\"] }, async () => {});",
    "test(\"loads\", { concurrent: true }, function load() {});",
    "test.each([1, 2])(\"loads %i\", async () => {});",
    "beforeAll(async () => { await server.listen(); }, 60_000);",
    "afterAll(() => server.close(), 30_000);",
    "await expect.poll(() => count(), { timeout: 5_000 }).toBe(1);",
    "await vi.waitFor(() => expect(count()).toBe(1), { timeout: 5_000 });",
    "const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });",
    "queue.retry({ delaySeconds: 30 });",
    "const policy = { retry: { maxAttempts: 1 } };",
    "export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });",
    "vi.setConfig({ fakeTimers: { now: 0 } });",
    {
      code: "test(\"builds\", async () => {}, 120_000);",
      filename: "src/slow/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
    },
    {
      code: "test(\"builds\", { timeout: 120_000 }, async () => {});",
      filename: "src/slow/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
    },
  ],
  invalid: [
    {
      code: "test(\"loads\", { retry: 2 }, async () => {});",
      errors: [retry],
    },
    {
      code: "it(\"loads\", { retry: 2 }, async () => {});",
      errors: [retry],
    },
    {
      code: "describe(\"loader\", { retry: 3 }, () => {});",
      errors: [retry],
    },
    {
      code: "test.concurrent(\"loads\", { retry: 1 }, async () => {});",
      errors: [retry],
    },
    {
      code: "test.each([1, 2])(\"loads %i\", { retry: 1 }, async () => {});",
      errors: [retry],
    },
    {
      code: "test(\"loads\", async () => {}, { retry: 2 });",
      errors: [retry],
    },
    {
      code: "vi.setConfig({ retry: 2 });",
      errors: [retry],
    },
    {
      code: "export default defineConfig({ test: { retry: 2 } });",
      errors: [retry],
    },
    {
      code: "export default defineConfig({ test: { retry: process.env.CI ? 2 : 0 } });",
      errors: [retry],
    },
    {
      code: "export default defineConfig({ test: { projects: [{ test: { name: 'node', retry: 1 } }] } });",
      errors: [retry],
    },
    {
      code: "test(\"loads\", async () => {}, 60_000);",
      errors: [timeout],
    },
    {
      code: "it(\"loads\", async () => {}, 30000);",
      errors: [timeout],
    },
    {
      code: "test(\"loads\", async () => {}, LONG_TIMEOUT);",
      errors: [timeout],
    },
    {
      code: "test(\"loads\", async () => {}, 2 * 60_000);",
      errors: [timeout],
    },
    {
      code: "test(\"loads\", { timeout: 60_000 }, async () => {});",
      errors: [timeout],
    },
    {
      code: "test(\"loads\", async () => {}, { timeout: 60_000 });",
      errors: [timeout],
    },
    {
      code: "test.each([1])(\"loads %i\", async () => {}, 20_000);",
      errors: [timeout],
    },
    {
      code: "test.skipIf(ci)(\"loads\", async () => {}, 20_000);",
      errors: [timeout],
    },
    {
      code: "describe(\"loader\", { timeout: 60_000 }, () => {});",
      errors: [timeout],
    },
    {
      code: "vi.setConfig({ testTimeout: 45_000 });",
      errors: [timeout],
    },
    {
      code: "vi.setConfig({ hookTimeout: 45_000 });",
      errors: [timeout],
    },
    {
      // A retry is never allowlisted. This file has no timeouts, so its allowlist
      // entry is also stale: the rule tracks retries and timeouts separately.
      code: "test(\"builds\", { retry: 2 }, async () => {});",
      filename: "src/slow/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
      errors: [stale, retry],
    },
    {
      code: "test(\"builds\", async () => {}, 120_000);",
      filename: "src/fast/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
      errors: [timeout],
    },
    {
      code: "test(\"builds\", async () => {});",
      filename: "src/slow/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
      errors: [stale],
    },
    {
      code: "test(\"builds\", async () => {}, 120_000); test(\"links\", async () => {}, 120_000);",
      filename: "src/slow/build.test.ts",
      options: [{ allow: { "src/slow/build.test.ts": 1 } }],
      errors: [timeout, timeout],
    },
  ],
});
