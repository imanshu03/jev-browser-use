import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { RecordingStore, recordingPath } from "../src/recordings.js";

it("keeps recordings of suites outside the project inside the recording directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-recordings-"));
  const dir = path.join(root, ".jev", "recordings");
  try {
    const store = RecordingStore.open(dir, "../../shared/a.suite.yaml");
    store.put("step", { text: "Open", steps: [], recorded_at: "now" });
    const file = store.save();
    expect(path.relative(dir, file).startsWith("..")).toBe(false);
    expect(file).toBe(recordingPath(dir, "../../shared/a.suite.yaml"));
    expect(RecordingStore.open(dir, "../../shared/a.suite.yaml").get("step", "Open")).not.toBeNull();
    expect(file).not.toBe(recordingPath(dir, "../shared/a.suite.yaml"));
    expect(recordingPath(dir, "suites/notes.suite.yaml")).toBe(path.join(dir, "suites", "notes.json"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
