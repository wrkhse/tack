# landmines

Vendored from [interfere-inc/landmines](https://github.com/interfere-inc/landmines) `packages/landmines/` at commit `92084b12872103b0f9245c0325ab571df00a574b` (2026-11-17), MIT licence; `LICENSE` retained verbatim.

This copy is project policy, maintained here. Local changes are recorded below so a later update can merge upstream fixes without losing them.

## Vendored

- `LICENSE`
- `lib/allowlist.ts`
- `rules/no-fixed-sleep.ts`
- `rules/no-flake-masking.ts`
- `rules/no-unsignaled-poll.ts`
- `index.ts` (upstream `src/plugins/testing.ts`)

The plugin `landmines-testing` enables `no-fixed-sleep`, `no-flake-masking` and `no-unsignaled-poll` in the lint gate.

## Local changes

| File | Change | Reason |
|---|---|---|
| `rules/*.ts`, `index.ts` (edit a) | `@oxlint/plugins` imports `vite-plus/lint/plugins`; import lines only | Vite+ 1.7.0 bundles Oxlint 1.94.0 and re-exports its authoring API, so the plugin always matches the linter that loads it |
| `lib/allowlist.ts` (edit b) | Drops zod; `allowlistSchema` is unchanged, and `allowlistOption` reads and validates the option explicitly, refuses what upstream's zod tuple refused and every extra key `allowlistSchema` refuses, and is exported for `lib/allowlist.test.ts` | This trial adds no dependency, so zod is replaced by an explicit read of the same option shape |
| `rules/*.ts` (edit c) | The `stale` message points at the lint rules in `vite.config.ts` | tack configures Oxlint in `vite.config.ts`, not in an `.oxlintrc` |
| `index.ts` (edit d) | Registers only `no-fixed-sleep`, `no-flake-masking` and `no-unsignaled-poll` | Only the three testing rules are part of this trial |
| `index.ts` (move) | Rule imports are `./rules/...` | The plugin sits at the package root, one level above upstream's `src/plugins/` |
| `index.ts` (suppression) | The upstream `oxlint-disable-next-line import/no-default-export` comment is removed | This copy is excluded from tack's lint, so the comment suppressed nothing here and was reported as an unexplained suppression |

## Not vendored

`no-test-doubles` and `strict-msw` are evaluated and reported rather than enabled. `lib/test-owner.ts` and the structure/style rules (`colocated-tests`, `test-file-names`, `package-exports`, `no-comments`, `no-explicit-return-types`) are Landmines' other policy and outside this trial.

The structure rules need `@babel/parser`, `@babel/types` and `oxc-resolver`. Upstream, four files import zod at runtime: `lib/allowlist.ts` (which every testing rule uses), `no-comments.ts`, `colocated-tests.ts` and `package-exports.ts`; a fifth, `package-exports.test.ts`, imports only its types. This copy removes that need entirely: the five testing rules need nothing beyond the Oxlint authoring API, and `@babel/parser`, `@babel/types` and `oxc-resolver` arrive only with the structure rules that are not vendored.

## Verification

The vendored rule tests run in the Vitest project `landmines`: the three rules' upstream case lists as RuleTester cases, the option reader's own refusals in `lib/allowlist.test.ts`, and, in `gate.test.ts`, the gate itself. That test runs the Oxlint the repository already installed (`bunx --no-install`, never a download) and pins it at exactly 1.94.0, the version Vite+ 1.7.0 bundles, so a Vite+ bump fails the test until someone re-reads the rules against the new Oxlint; the rules need Oxlint >= 1.81.0. It also proves each enabled rule fails a fixture through the real CLI, and that `vite.config.ts` enables exactly these three rule ids.
