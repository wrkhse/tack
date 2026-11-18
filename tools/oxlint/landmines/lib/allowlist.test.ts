import assert from "node:assert/strict";

import { it } from "vite-plus/test";

import { allowlistOption } from "./allowlist.ts";

it("accepts no options and one allowlist option", () => {
  assert.deepEqual(allowlistOption([]), { allow: {} });
  assert.deepEqual(allowlistOption([{ allow: { "a.test.ts": 1 } }]), {
    allow: { "a.test.ts": 1 },
  });
});

it("refuses more than one option", () => {
  assert.throws(
    () => allowlistOption([{ allow: {} }, { allow: {} }]),
    /at most one option/u,
  );
});

it("refuses an option that is not an object holding only allow", () => {
  const refused = [[], "allow", 1, null, {}, { allow: {}, extra: true }, { allow: [] }];

  for (const option of refused) {
    assert.throws(() => allowlistOption([option]), /takes one option/u);
  }
});

it("refuses counts that are not safe integers of 1 or more", () => {
  const refused = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1"];

  for (const count of refused) {
    assert.throws(
      () => allowlistOption([{ allow: { "a.test.ts": count } }]),
      /takes one option/u,
    );
  }
});
