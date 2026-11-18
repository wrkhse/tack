import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noUnsignaledPoll } from "./no-unsignaled-poll.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const poll = { messageId: "poll" };
const stale = { messageId: "stale" };

tester.run("landmines-testing/no-unsignaled-poll", noUnsignaledPoll, {
  valid: [
    "const request = Promise.withResolvers(); await request.promise;",
    "await expect.poll(() => result.current.items.length).toBe(2);",
    "await vi.waitFor(() => expect(result.current.pendingReplies).toHaveLength(1));",
    "await expect.poll(() => curves('overlaid-area').length).toBe(3);",
    "await expect.poll(() => rows.elements().length).toBe(6);",
    "await expect.poll(() => document.title).toBe('Slack');",
    "await expect.poll(rowLabels).toStrictEqual(['a']);",
    "await expect.poll(() => entered, { timeout: 5000 }).toBe(true);",
    "await expect.poll(() => clients.at(-1)).toBeDefined();",
    "await expect.poll(() => client.isFetching()).toBe(0);",
    "await expect.poll(() => network.snapshot().pending.length).toBe(1);",
    "await vi.waitFor(() => expect(screen.getByText('Saved')).toBeVisible());",
    "await vi.waitFor(() => expect(status).toBe('ready'));",
    "await vi.waitFor(() => { const count = requests.length; expect(count).toBe(1); });",
    "expect(requests).toHaveLength(1); expect(onComplete).toHaveBeenCalledOnce();",
    {
      code: "await expect.poll(() => requests.length).toBe(1); await expect.poll(() => requests.length).toBe(1);",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 2 } }],
    },
  ],
  invalid: [
    { code: "await expect.poll(() => requests.length).toBe(1);", errors: [poll] },
    {
      code: "await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);",
      errors: [poll],
    },
    { code: "await expect.poll(() => traffic.requests.length).toBe(1);", errors: [poll] },
    { code: "await expect.poll(() => requestedChunks.size).toBeGreaterThan(0);", errors: [poll] },
    { code: "await expect.poll(() => { return sent.length; }).toBe(2);", errors: [poll] },
    { code: "await expect.poll(() => received).toHaveLength(1);", errors: [poll] },
    { code: "await expect.poll(() => replayUploads.uploads).toHaveLength(2);", errors: [poll] },
    {
      code: "await expect.poll(() => onComplete.mock.calls.length).toBe(1);",
      errors: [poll],
    },
    {
      code: "await expect.poll(() => reload.mock.settledResults[0]?.type).toBe('rejected');",
      errors: [poll],
    },
    {
      code: "await expect\n  .poll(() => mutate.mock.calls.length)\n  .toBe(1);",
      errors: [poll],
    },
    { code: "await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(2));", errors: [poll] },
    { code: "await vi.waitFor(() => expect(state.post).toHaveBeenCalledOnce());", errors: [poll] },
    {
      code: "await vi.waitFor(() => expect(cancel).not.toHaveBeenCalledWith(1));",
      errors: [poll],
    },
    { code: "await vi.waitFor(() => expect(requests).toHaveLength(1));", errors: [poll] },
    {
      code: "await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));",
      errors: [poll],
    },
    {
      code: "await vi.waitFor(() => expect(cancel.mock.calls.length).toBeGreaterThan(0));",
      errors: [poll],
    },
    { code: "await vi.waitFor(() => { expect(fetcher).toHaveBeenCalled(); });", errors: [poll] },
    { code: "await vi.waitFor(() => workers.size, { timeout: 2000 });", errors: [poll] },
    {
      code: "await vi.waitFor(() => expect(fake.calls).toHaveLength(1));",
      errors: [poll],
    },
    {
      code: "await expect.poll(() => requests.length).toBe(1); await expect.poll(() => requests.length).toBe(1);",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 1 } }],
      errors: [poll, poll],
    },
    {
      code: "await expect.poll(() => requests.length).toBe(1);",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "0/fixture.test.ts": 3 } }],
      errors: [stale],
    },
    {
      code: "await expect.poll(() => requests.length).toBe(1);",
      filename: "cases/0/fixture.test.ts",
      options: [{ allow: { "ixture.test.ts": 1 } }],
      errors: [poll],
    },
  ],
});
