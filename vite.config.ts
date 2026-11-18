import { defineConfig } from "vite-plus";

// Vendored lint policy keeps upstream formatting and is not linted as our code.
const vendored = ["tools/oxlint/anti-slop/**", "tools/oxlint/landmines/**"];

// tsc and effect-tsgo are Go binaries. Automatic file tracking missed a new
// source file for them, replaying a stale pass, so their inputs are explicit.
const typeInputs = ["**/*.ts", "**/tsconfig*.json", "bun.lock", "!node_modules/**"];

export default defineConfig({
  fmt: {
    // spike/ is research evidence kept as written (AGENTS.md); oxfmt rewrites its code samples.
    ignorePatterns: [...vendored, "spike/**"],
  },
  lint: {
    ignorePatterns: vendored,
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
      { name: "landmines-testing", specifier: "./tools/oxlint/landmines/index.ts" },
    ],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    rules: {
      "max-lines-per-function": ["error", { max: 70, skipBlankLines: true, skipComments: true }],
      "oxc/no-accumulating-spread": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",

      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",

      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",

      "landmines-testing/no-fixed-sleep": "error",
      // Two real child-process tests bound their own elapsed time on purpose: duplex proves a
      // SIGKILL escalation after a 200 ms grace, and opencode-server proves a readiness fallback
      // when no listening line arrives. Each keeps one per-test timeout, and this list may only
      // shrink: the rule reports a stale entry once a file no longer carries one.
      "landmines-testing/no-flake-masking": [
        "error",
        { allow: { "test/duplex.test.ts": 1, "test/opencode-server.test.ts": 1 } },
      ],
      "landmines-testing/no-unsignaled-poll": "error",
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "anti-slop",
          include: ["tools/oxlint/anti-slop/**/*.test.ts"],
          setupFiles: ["tools/vitest/rule-tester.ts"],
        },
      },
      {
        test: {
          name: "landmines",
          include: ["tools/oxlint/landmines/**/*.test.ts"],
          setupFiles: ["tools/vitest/rule-tester.ts"],
        },
      },
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        // Starts real agent CLIs and a stand-in model: CI or a disposable container only.
        test: {
          name: "conformance",
          include: ["conformance/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
  run: {
    tasks: {
      // `vp check` type-checks only linted files; this covers the whole project, vendored code included.
      types: { command: "tsc -p tsconfig.json --noEmit", cache: { input: typeInputs, output: [] } },
      effect: {
        // The same project, through the Effect language service's stricter diagnostics.
        command: "effect-tsgo diagnostics --project tsconfig.json --strict",
        cache: { input: typeInputs, output: [] },
      },
      // Compares against the merge base, so a cached result could be stale.
      health: { command: "fallow audit", cache: false },
      // Reads the live advisory database. One advisory is ignored, by the owner's decision on
      // 2026-11-18: GHSA-fc5q-39xc-vjpf, a ReDoS in picomatch <= 4.0.7 with no patched release
      // (npm's latest is still 4.0.7). It reaches us only through dev chains - vitest's globbing
      // via tinyglobby/fdir, and @opencode/plugin's pacote - and `bun audit --production` is clean,
      // because effect is tack's only production dependency; tack globs only its own patterns.
      // Remove the --ignore when picomatch > 4.0.7 is published, and re-check on every dependency
      // bump. Nothing else may be ignored.
      audit: { command: "bun audit --ignore=GHSA-fc5q-39xc-vjpf", cache: false },
    },
  },
});
