// Read a value off the page (EXTRACT, ANSWER_FINAL) and verify a finish (VERIFY).
import type { SnapshotData } from "./browser.js";
import type { Oracle } from "./jev.js";
import { choiceOf, noulOf } from "./jev.js";
import { buildAnswerFinal, buildExtract, buildVerify } from "./questions.js";
import { parseTree, type TreeNode } from "./snapshot.js";
import type { Goal, HistoryEntry, ParsedPage, Span } from "./types.js";
import { GATES, LIMITS } from "./types.js";

const LINE_ROLES: Record<string, string> = {
  heading: "heading", cell: "cell", row: "row", link: "link", listitem: "listitem", option: "option",
  StaticText: "text", text: "text", paragraph: "paragraph", rowheader: "cell", columnheader: "cell", treeitem: "treeitem",
};

function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export function candidateLines(page: ParsedPage, full: SnapshotData | undefined, bodyText: string): Span[] {
  const texts: string[] = [];
  if (page.title.trim().length >= 2) texts.push(`title: ${page.title.trim()}`);
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      const prefix = LINE_ROLES[n.role];
      if (prefix && n.name.trim().length >= 2) texts.push(`${prefix}: ${n.name.trim()}`);
      walk(n.children);
    }
  };
  if (full) walk(parseTree(full.snapshot));
  else {
    for (const h of page.headings) if (h.length >= 2) texts.push(`heading: ${h}`);
    for (const e of page.elements) if (LINE_ROLES[e.role] && e.name.length >= 2) texts.push(`${LINE_ROLES[e.role]}: ${e.name}`);
  }
  for (const line of bodyText.split("\n")) {
    const t = line.trim();
    if (t.length >= 2) texts.push(t);
  }
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const t of texts) {
    const text = cut(t.replace(/\s+/g, " "), LIMITS.lineChars);
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: `L${out.length}`, text, source: "page_line", secret: false });
    if (out.length >= LIMITS.maxLines) break;
  }
  return out;
}

export function chunkLines(lines: Span[]): Span[][][] {
  const requests: Span[][][] = [];
  for (let r = 0; r < lines.length; r += LIMITS.linesPerRequest) {
    const slice = lines.slice(r, r + LIMITS.linesPerRequest);
    const chunks: Span[][] = [];
    for (let c = 0; c < slice.length; c += LIMITS.chunkSize) chunks.push(slice.slice(c, c + LIMITS.chunkSize));
    requests.push(chunks);
  }
  return requests;
}

/** Strip the role prefix so `heading: X` and `text: X` count as the same value. */
export function normalizeLine(text: string): string {
  return text.replace(/^[a-z]+: /, "").trim().toLowerCase();
}

export async function extractAnswer(input: { task: string; goal: Goal; page: ParsedPage; lines: Span[]; history: HistoryEntry[]; oracle: Oracle; bannedLineIds: Set<string> }): Promise<{ winners: (Span & { chunkProbability: number })[]; best: (Span & { confidence: number }) | null; requests: number }> {
  const lines = input.lines.filter((l) => !input.bannedLineIds.has(l.id));
  const winners: (Span & { chunkProbability: number })[] = [];
  let requests = 0;
  // One request per 600 lines, at most three. Stop at the first request that yields a winner.
  for (const chunks of chunkLines(lines).slice(0, 3)) {
    const { state, questions } = buildExtract({ task: input.task, goal: input.goal, page: input.page, history: input.history, chunks });
    const r = await input.oracle.ask("extract", state, questions);
    requests += 1;
    chunks.forEach((chunk, k) => {
      const ans = choiceOf(r.answers, `answer_${k}`);
      if (!ans) return;
      // The best line counts when its probability reaches the winner threshold, even when `none` was chosen.
      let bestId = ""; let p = 0;
      for (const [id, prob] of Object.entries(ans.probabilities as Record<string, number>)) if (id !== "none" && prob > p) { bestId = id; p = prob; }
      const line = chunk.find((l) => l.id === bestId);
      if (line && p >= GATES.extractWinner) winners.push({ ...line, chunkProbability: p });
    });
    if (winners.length > 0) break;
  }
  if (winners.length === 0) return { winners, best: null, requests };
  if (winners.length === 1) {
    const w = winners[0] as Span & { chunkProbability: number };
    return { winners, best: { ...w, confidence: w.chunkProbability }, requests };
  }
  const { state, questions } = buildAnswerFinal({ task: input.task, page: input.page, winners });
  const r = await input.oracle.ask("answer_final", state, questions);
  requests += 1;
  const ans = choiceOf(r.answers, "answer_final");
  if (!ans || ans.choice === "none") return { winners, best: null, requests };
  const w = winners.find((x) => x.id === ans.choice);
  if (!w) return { winners, best: null, requests };
  // Winners that state the same value with another role prefix support the choice.
  let merged = 0;
  for (const [id, p] of Object.entries(ans.probabilities as Record<string, number>)) {
    const other = winners.find((x) => x.id === id);
    if (other && normalizeLine(other.text) === normalizeLine(w.text)) merged += p;
  }
  const confidence = Number(Math.max(ans.confidence, merged).toFixed(4));
  if (confidence < GATES.extractFinal) return { winners, best: null, requests };
  return { winners, best: { ...w, confidence }, requests };
}

export async function verify(input: { task: string; goal: Goal; page: ParsedPage; textExcerpt: string; lines: Span[]; history: HistoryEntry[]; candidate: Span | null; oracle: Oracle }): Promise<{ doneFinal: number; answerOk: number | null; evidence: string[]; requests: number }> {
  const chunks = chunkLines(input.lines.slice(0, LIMITS.linesPerRequest))[0] ?? [];
  const { state, questions } = buildVerify({ task: input.task, goal: input.goal, page: input.page, textExcerpt: input.textExcerpt, history: input.history, chunks, candidate: input.candidate });
  const r = await input.oracle.ask("verify", state, questions);
  const evidence: string[] = [];
  chunks.forEach((chunk, k) => {
    const ans = choiceOf(r.answers, `evidence_${k}`);
    if (!ans || ans.choice === "none") return;
    const p = (ans.probabilities as Record<string, number>)[ans.choice] ?? 0;
    const line = chunk.find((l) => l.id === ans.choice);
    if (line && p >= GATES.evidenceLine && evidence.length < LIMITS.evidenceLines) evidence.push(line.text);
  });
  return { doneFinal: noulOf(r.answers, "done_final"), answerOk: input.candidate ? noulOf(r.answers, "answer_ok") : null, evidence, requests: 1 };
}
