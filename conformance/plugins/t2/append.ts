import type { AppendWhen, Session } from "../../../src/index.ts";
import { markHere } from "../../harness/markers.ts";

/** Appends one synthetic message and records its outcome or failure. */
export const appendAndMark = (
  name: string,
  session: Session,
  text: string,
  when: AppendWhen,
): void => {
  void session
    .append(text, { when })
    .then((outcome) => markHere(name, { event: "append", outcome: outcome.status }))
    .catch((cause: Error) => markHere(name, { event: "append", error: String(cause) }));
};
