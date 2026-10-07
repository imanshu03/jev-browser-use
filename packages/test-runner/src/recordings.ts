// Recorded steps: one JSON file per suite, kept in git. Each plain-language step has the replay steps that Jev found.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Step } from "@imanshu03/jev-browser-use";
import * as z from "zod";

export const RecordingEntry = z.strictObject({
  text: z.string(),
  steps: z.array(Step),
  recorded_at: z.string(),
  healed: z.array(z.strictObject({ at: z.string(), reason: z.string() })).optional(),
});
export type RecordingEntry = z.infer<typeof RecordingEntry>;

export const RecordingFile = z.strictObject({
  format: z.literal(1),
  suite: z.string(),
  entries: z.record(z.string(), RecordingEntry),
});
export type RecordingFile = z.infer<typeof RecordingFile>;

/** The key of a plain-language step: its scope, a hash of its text, and its count when the same text shows again in the scope. */
export function entryKey(scope: string, text: string, occurrence: number): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${scope}/${hash}${occurrence > 1 ? `.${occurrence}` : ""}`;
}

/** The recording file path of a suite: the suite key with ".json" in the recordings directory. */
export function recordingPath(dir: string, suiteKey: string): string {
  return path.join(dir, suiteKey.replace(/\.suite\.yaml$/, "") + ".json");
}

export class RecordingStore {
  private file: RecordingFile;
  private changed = false;

  private constructor(readonly path: string, file: RecordingFile) {
    this.file = file;
  }

  static open(dir: string, suiteKey: string): RecordingStore {
    const p = recordingPath(dir, suiteKey);
    if (!fs.existsSync(p)) return new RecordingStore(p, { format: 1, suite: suiteKey, entries: {} });
    const parsed = RecordingFile.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
    if (!parsed.success) throw new Error(`${p}: not a valid recording file: ${parsed.error.issues[0]?.message ?? "unknown"}. Delete it to record again`);
    return new RecordingStore(p, parsed.data);
  }

  get(key: string, text: string): RecordingEntry | null {
    const e = this.file.entries[key];
    return e && e.text === text ? e : null;
  }

  put(key: string, entry: RecordingEntry): void {
    this.file.entries[key] = entry;
    this.changed = true;
  }

  get dirty(): boolean {
    return this.changed;
  }

  /** Write the file, sorted by key so that a diff shows only the changed steps. `to` writes a copy elsewhere (CI heals). */
  save(to: string = this.path): string {
    const entries = Object.fromEntries(Object.entries(this.file.entries).sort(([a], [b]) => a.localeCompare(b)));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, JSON.stringify({ ...this.file, entries }, null, 2) + "\n");
    if (to === this.path) this.changed = false;
    return to;
  }
}
