/// <reference types="node" />

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { it } from "vite-plus/test";

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
  readonly message: string;
}

// Oxlint's JSON names a js plugin rule "plugin(rule)"; the config ids use "plugin/rule".
function ruleId(diagnostic: Diagnostic) {
  const match = /^(?<plugin>[^()]+)\((?<rule>[^()]+)\)$/u.exec(diagnostic.code);

  assert.ok(match?.groups, `unexpected Oxlint rule code: ${diagnostic.code}`);

  return `${match.groups.plugin}/${match.groups.rule}`;
}

it("reports each Landmines testing rule through the Oxlint CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "landmines-gate-"));
  const config = join(root, "oxlint.json");

  try {
    // The rules need Oxlint >= 1.81.0. This pins the exact version Vite+ 1.7.0 bundles, so a
    // Vite+ bump fails here until someone re-reads the rules against the new Oxlint.
    const pinned = "1.94.0";
    // --no-install keeps both Oxlint runs on the binary the repository already installed.
    const version = spawnSync("bunx", ["--no-install", "oxlint", "--version"], {
      encoding: "utf8",
    });
    const versionOutput = `${version.stdout ?? ""}${version.stderr ?? ""}`;

    assert.equal(version.status, 0, versionOutput);

    const versionMatch = /(\d+)\.(\d+)\.(\d+)/u.exec(version.stdout ?? "");

    assert.ok(versionMatch, `no x.y.z version in: ${versionOutput}`);

    assert.equal(
      versionMatch[0],
      pinned,
      `expected Oxlint ${pinned}, the version Vite+ 1.7.0 bundles, but ${versionOutput.trim()} ran`,
    );

    writeFileSync(
      config,
      JSON.stringify({
        categories: {
          correctness: "off",
          suspicious: "off",
          pedantic: "off",
          perf: "off",
          style: "off",
          restriction: "off",
          nursery: "off",
        },
        jsPlugins: [
          {
            name: "landmines-testing",
            specifier: fileURLToPath(new URL("./index.ts", import.meta.url)),
          },
        ],
        rules: {
          "landmines-testing/no-fixed-sleep": "error",
          "landmines-testing/no-unsignaled-poll": "error",
          "landmines-testing/no-flake-masking": "error",
        },
      }),
    );

    const fixtures = {
      "fixed-sleep.test.ts": `test("x", async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });`,
      "unsignaled-poll.test.ts": `test("x", async () => { await vi.waitFor(() => expect(fake.calls).toHaveLength(1)); });`,
      "retry.test.ts": `test("x", { retry: 2 }, async () => {});`,
      "timeout.test.ts": `test("x", async () => {}, 60_000);`,
      "clean.test.ts": `test("x", async () => { const ready = Promise.withResolvers(); await ready.promise; expect(ready).toBeDefined(); });`,
    };
    for (const [file, code] of Object.entries(fixtures)) {
      writeFileSync(join(root, file), `${code}\n`);
    }

    const files = Object.keys(fixtures);

    const result = spawnSync(
      "bunx",
      [
        "--no-install",
        "oxlint",
        "--config",
        config,
        "--format",
        "json",
        ...files.map((file) => join(root, file)),
      ],
      { encoding: "utf8" },
    );
    const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.equal(result.status, 1, raw);

    const parsed = JSON.parse(result.stdout) as { readonly diagnostics?: readonly Diagnostic[] };
    const diagnostics = parsed.diagnostics ?? [];

    assert.equal(diagnostics.length, 4, raw);

    const expected = [
      ["fixed-sleep.test.ts", "landmines-testing/no-fixed-sleep"],
      ["unsignaled-poll.test.ts", "landmines-testing/no-unsignaled-poll"],
      ["retry.test.ts", "landmines-testing/no-flake-masking"],
      ["timeout.test.ts", "landmines-testing/no-flake-masking"],
    ] as const;

    for (const [file, id] of expected) {
      const reported = diagnostics.filter(
        (diagnostic) => diagnostic.filename === join(root, file),
      );

      assert.equal(reported.length, 1, `${file}: ${raw}`);

      const [diagnostic] = reported;

      assert.ok(diagnostic, `${file}: ${raw}`);
      assert.equal(ruleId(diagnostic), id, `${file}: ${raw}`);
    }

    assert.equal(
      diagnostics.filter(
        (diagnostic) => diagnostic.filename === join(root, "clean.test.ts"),
      ).length,
      0,
      raw,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface GatePlugin {
  readonly name: string;
  readonly specifier: string;
}

// OxlintConfig.rules is Oxlint's generated map of built-in rule ids, so a JavaScript plugin's ids
// have no type there. This names only the two lint fields this gate reads.
interface GateLintConfig {
  readonly jsPlugins?: null | readonly (string | GatePlugin)[];
  readonly rules?: Readonly<Record<string, unknown>>;
}

// effect-tsgo reports `asyncFunction` as an error project-wide, so the config import waits at
// module scope instead of inside an async test.
const { default: config } = await import("../../../vite.config.ts");

it("enables exactly the three Landmines testing rules in the gate config", () => {
  const lint: GateLintConfig | undefined = config.lint;
  const rules = lint?.rules ?? {};
  const ids = Object.keys(rules)
    .filter((id) => id.startsWith("landmines-testing/"))
    .sort();

  assert.deepEqual(ids, [
    "landmines-testing/no-fixed-sleep",
    "landmines-testing/no-flake-masking",
    "landmines-testing/no-unsignaled-poll",
  ]);

  for (const id of ids) {
    const configured = rules[id];

    assert.equal(Array.isArray(configured) ? configured[0] : configured, "error", id);
  }

  assert.ok(
    lint?.jsPlugins?.some(
      (plugin) =>
        typeof plugin === "object" &&
        plugin.name === "landmines-testing" &&
        plugin.specifier === "./tools/oxlint/landmines/index.ts",
    ),
    "the gate config registers the landmines-testing plugin",
  );
});
