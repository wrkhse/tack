import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Schema } from "effect";

/** The prefix and suffix every T2 plugin marker file carries. */
const PREFIX = "t2-marker-";
const SUFFIX = ".json";

const ValueSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);

const ObservationSchema = Schema.Record(Schema.String, ValueSchema);

/** Every observation a marker file holds, in the order the plugin wrote them. */
export const MarkerObservations = Schema.Array(ObservationSchema);

/** A marker file's whole text, decoded as the observations it holds. */
export const MarkerFile = Schema.fromJsonString(MarkerObservations);

/** One thing a plugin observed, as its marker file records it. */
export type MarkerObservation = Schema.Schema.Type<typeof ObservationSchema>;

/** The marker path one plugin writes: `t2-marker-<name>.json` in `dir`. */
export const markerFile = (dir: string, name: string): string => join(dir, PREFIX + name + SUFFIX);

const decode = (text: string): ReadonlyArray<MarkerObservation> =>
  Schema.decodeUnknownSync(MarkerObservations)(JSON.parse(text));

/**
 * Appends one observation to a plugin's marker file, creating it. The write
 * publishes the whole array in one rename, so a reader polling the file sees
 * either the observations before this one or the ones after it, never half of
 * a write.
 */
const mark = (dir: string, name: string, observation: MarkerObservation): void => {
  const file = markerFile(dir, name);
  const prior = existsSync(file) ? decode(readFileSync(file, "utf8")) : [];
  const writing = file + ".writing";

  writeFileSync(writing, JSON.stringify([...prior, observation]));
  renameSync(writing, file);
};

/** Records an observation in the working directory the plugin runs in. */
export const markHere = (name: string, observation: MarkerObservation): void => {
  mark(process.cwd(), name, observation);
};

const isMarkerFile = (name: string): boolean => name.startsWith(PREFIX) && name.endsWith(SUFFIX);

const nameOf = (file: string): string => file.slice(PREFIX.length, -SUFFIX.length);

/** Every marker file a finished run left in `dir`, by the name it records. */
export const markersIn = (dir: string): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.sync(() => {
    const files = readdirSync(dir).filter(isMarkerFile).toSorted();

    const entries = files.map((file): readonly [string, string] => [
      nameOf(file),
      readFileSync(join(dir, file), "utf8"),
    ]);

    return new Map(entries);
  });
