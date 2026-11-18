import type { Context, ESTree } from "vite-plus/lint/plugins";

export const allowlistSchema = [
  {
    type: "object" as const,
    properties: {
      allow: {
        type: "object" as const,
        additionalProperties: { type: "integer" as const, minimum: 1 },
      },
    },
    additionalProperties: false,
  },
];

interface AllowlistOption {
  readonly allow: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowlistOption(value: unknown): value is AllowlistOption {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);

  if (keys.length !== 1 || keys[0] !== "allow") {
    return false;
  }

  const { allow } = value;

  return (
    isRecord(allow) &&
    Object.values(allow).every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 1,
    )
  );
}

// Oxlint validates rule options against allowlistSchema; this keeps the read typed without
// zod, refuses what upstream's zod tuple refused and every extra key the schema's
// additionalProperties: false refuses, and fails loudly if anything bypasses that
// validation. Exported for lib/allowlist.test.ts.
export function allowlistOption(options: readonly unknown[]): AllowlistOption {
  const [option, ...extra] = options;

  if (extra.length > 0) {
    throw new Error(
      'this rule takes at most one option: { allow: { "<path>": <count> } }',
    );
  }

  if (option === undefined) {
    return { allow: {} };
  }

  if (!isAllowlistOption(option)) {
    throw new Error(
      'this rule takes one option: { allow: { "<path>": <count> } } with counts of 1 or more',
    );
  }

  return option;
}

function allowance(context: Context) {
  const filename = context.physicalFilename.replaceAll("\\", "/");
  const options = allowlistOption(context.options);

  return Object.entries(options.allow).find(
    ([path]) => filename === path || filename.endsWith(`/${path}`),
  );
}

export function reportAllowed(
  context: Context,
  program: ESTree.Program,
  violations: readonly ESTree.Node[],
  messageId: string,
) {
  const [path, count] = allowance(context) ?? ["", 0];

  if (violations.length < count) {
    context.report({
      node: program,
      messageId: "stale",
      data: { path, count: String(violations.length) },
    });

    return;
  }

  if (violations.length === count) {
    return;
  }

  for (const node of violations) {
    context.report({ node, messageId });
  }
}
