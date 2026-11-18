import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noFixedSleep } from "./no-fixed-sleep.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const sleep = { messageId: "sleep" };
const stale = { messageId: "stale" };

tester.run("landmines-testing/no-fixed-sleep", noFixedSleep, {
  valid: [
    "test('x', async () => { await operation(); });",
    "test('x', async () => { const ready = Promise.withResolvers(); await ready.promise; });",
    "test('x', async () => { vi.useFakeTimers(); await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
    "test('x', async () => { serve(async () => { await scheduler.wait(10); return new Response(); }); });",
    "async function backoff(attempt) { await scheduler.wait(2 ** attempt); } test('x', async () => { await backoff(1); });",
    "test('x', async () => { await Promise.race([work, new Promise((resolve) => { setTimeout(() => resolve('pending'), 0); })]); });",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 10); queueMicrotask(resolve); }); });",
    "test('x', async () => { await new Promise((resolve) => { emitter.once('done', resolve); }); });",
    "import { setImmediate } from \"node:timers/promises\"; test(\"x\", async () => { await setImmediate(); });",
    "test('x', async () => { const timer = setTimeout(cancel, 10); await work(); clearTimeout(timer); });",
    {
      code: "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); }); test('y', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 2 } }],
    },
  ],
  invalid: [
    {
      code: "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
      errors: [sleep],
    },
    {
      code: "test('x', async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });",
      errors: [sleep],
    },
    {
      code: "test('x', async () => { await new Promise<void>((done) => globalThis.setTimeout(() => done(), 31_000)); });",
      errors: [sleep],
    },
    {
      code: "it('x', async () => { await new Promise((resolve) => window.setTimeout(resolve, 600)); });",
      errors: [sleep],
    },
    {
      code: "import { setTimeout as sleep } from \"node:timers/promises\"; test(\"x\", async () => { await sleep(500); });",
      errors: [sleep],
    },
    {
      code: "import { setTimeout } from \"timers/promises\"; afterEach(async () => { await setTimeout(20); });",
      errors: [sleep],
    },
    {
      code: "beforeEach(async () => { await scheduler.wait(10); });",
      errors: [sleep],
    },
    {
      code: "test('x', async () => { await Bun.sleep(100); });",
      errors: [sleep],
    },
    {
      code: "test.each([1])('x %s', async () => { await scheduler.wait(1); });",
      errors: [sleep],
    },
    {
      code: "test.concurrent('x', async () => { await scheduler.wait(1); });",
      errors: [sleep],
    },
    {
      code: "it.skipIf(ci)('x', async function () { await scheduler.wait(1); });",
      errors: [sleep],
    },
    {
      code: "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); }); test('y', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 1 } }],
      errors: [sleep, sleep],
    },
    {
      code: "test('x', async () => { await operation(); });",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 1 } }],
      errors: [stale],
    },
  ],
});
