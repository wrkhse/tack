/**
 * The text a tool result shows the model: its text parts, joined in order.
 * Every other part carries no text of its own.
 */
export function joinTextParts(
  parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  const texts: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && part.text !== undefined) {
      texts.push(part.text);
    }
  }

  return texts.join("\n");
}
