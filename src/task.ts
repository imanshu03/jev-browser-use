// Deterministic text work on the task string. No network.
import type { ProfileEntry } from "./browser.js";
import type { DateFact, Span } from "./types.js";
import { LIMITS, SECRET_KEY } from "./types.js";

export const VALUE_VERBS = ["search for", "search", "look up", "type", "enter", "fill in", "fill", "write", "put",
  "find", "named", "called", "titled", "with", "as", "to", "for", "into", "query", "about"] as const;

/** A sentence dot ends a clause; a dot inside a word does not ("report.pdf", "v2.1"). A dot before a dot does ("hello...and"). */
export const CLAUSE_BREAK = /,|;|\.(?=[\s.]|$)|\bthen\b|\band then\b|\bin the\b|\bon the\b|\binto\b|\busing\b/i;
const STEP_VERBS = "save|send|submit|click|press|hit|tap|open|close|create|add|invite|assign|set|type|enter|select|choose|pick|publish|post|share|delete|remove|rename|update|change|confirm|go|return|reply|write|fill|search|find|attach|upload|mark|move|copy|paste|check|uncheck|tick|toggle|mention|tag|schedule|run|start|stop|approve|reject|archive|email|message|notify|tell|ask|make|use|put|give";
const STEP_VERB_SET = new Set(STEP_VERBS.split("|"));
/**
 * Steps of a form or settings flow that are not in STEP_VERBS: "and continue", "and verify it", "and refresh the page".
 * They also start a query, a to-do name, or a title ("how to pause and continue a download", "draft and edit the blog
 * post", "Hurry up and wait"). So only a pronoun after them, or a phrase, is a sure cut; other forms are maybe cuts.
 */
const FLOW_VERBS = new Set(["continue", "proceed", "finish", "apply", "cancel", "verify", "ensure", "refresh", "reload", "wait", "download", "export", "edit"]);
/** Two-word steps: "and sign out", "and log in", "and make sure it is saved". */
const FLOW_PHRASE = /^(?:(?:sign|log)\s+(?:in|out|off)|make\s+sure)\b/;
/** Verbs that start a next step after the first "and" of a long value: its words before the "and" stay a value ("Priya and leave a note ..."). */
const NEXT_STEP_VERBS = new Set([...STEP_VERB_SET, ...FLOW_VERBS, "leave", "navigate", "take", "switch", "view", "note", "let", "look", "scroll", "observe", "sign", "log"]);
/** Words after "and <verb>" that end a step: the task or a clause ends. */
const STEP_END = /^\s*(?:$|[,.;:!?])/;
const PRONOUN = /^(?:it|them|him|her|me|us|this|that|these|those)$/;
const ARTICLE = /^(?:the|a|an|my|your|our|their|his|its|all|everything)$/;
/** Lower-case names of controls and keys: "and click save", "and press enter". */
const CONTROL_WORD = /^(?:save|send|enter|return|tab|escape|esc|space|submit|done|ok|next|continue|create|update|confirm|add|apply|post|publish|search|go|delete|cancel|close|reply|comment|share|upload|attach)$/i;
/** A key chord in any case: "ctrl+enter", "Cmd+S". */
const CHORD = /^(?:ctrl|control|cmd|command|meta|alt|option|shift)(?:[+-]|$)/i;
/** After "press the" or "hit the": a key name, or up to two words and then key, button, arrow, or icon ("the Enter key", "the Send button", "the down arrow"). */
const KEY_AFTER_THE = /^\s+(?:(?:enter|return|tab|escape|esc|space|backspace|delete|send|submit|post|search)(?=\s*(?:$|[,.;:!?]))|(?:[\w+-]+\s+){1,2}(?:key|keys|button|arrow|icon)\b)/i;
/** A lower-case task field that the next step sets: "and set priority to High", "and change status to Done". */
const FIELD_SET = /^\s+(?:priority|status|assignee|owner|severity|stage|column|due\s+date|estimate|milestone|sprint)\s+(?:to|as)\s+\S/;
/** A step verb before one or two lower-case words and "to" or "as": "and move card to Done", "and paste text to Excel". */
const OBJECT_TO = /^\s+[a-z]+(?:\s+[a-z]+)?\s+(?:to|as)\s+\S/;
/** A label or tag with one word at the end: "and add label bug". */
const LABEL_ADD = /^\s+(?:label|labels|tag|tags)\s+[^\s,.;:!?]+\s*(?:$|[,.;:!?])/;
const PEOPLE_VERBS = new Set(["invite", "assign", "tell", "email", "message", "mention", "ask", "notify", "add"]);
const SEND_VERBS = new Set(["send", "post", "reply", "save", "publish", "submit"]);
const PICK_VERBS = new Set(["select", "choose", "pick"]);
const TEXT_NOUN_END = /^\s+the\s+(?:message|reply|comment|note|post|email|form|text|answer|response|changes)\s*(?:$|[,.;:!?])/;
/** The object of a send verb in a message: "it to Ann", "the message to the team", "it now". */
const SEND_OBJECT = /^(?:\s+(?:it|them|this|that|the\s+(?:message|reply|comment|note|post|email|text|answer|response)))?\s+(?:to\s+([^\s,.;:!?]+)|(now)\b)/;
/** A determiner and a kind of text after a send verb: "the draft", "your message", "this chat message". */
const SEND_TEXT_OBJECT = /^\s+(?:the|your|this|that|my|our)\s+(?:[a-z]+\s+)?(?:message|reply|comment|note|post|email|text|draft|answer|response)\b/;
/** Verbs whose object is a message: its words stay together, up to a step that sends it ("type we will review and approve it"). */
const MESSAGE_VERBS = new Set(["type", "write", "enter", "fill", "fill in", "put"]);
/** Message verbs whose object can also be a value for a list: "type Berlin and select the first suggestion". */
const PICK_AFTER = new Set(["type", "enter", "fill", "fill in", "put"]);
/** A subject pronoun: the value is a sentence ("we will review and approve it", "thanks I will read and share it"). */
const SUBJECT_START = /^(?:I|I['’]m|I['’]ll|we|you|they|he|she)\b/i;
/** A subject pronoun anywhere in the words before an "and": a message there keeps a send step ("thanks I will read and send it to the team"). */
const SUBJECT_WORD = /(?:^|\s)(?:I|I['’]m|I['’]ll|I['’]d|we|we['’]ll|we['’]re|they|he|she)(?=\s|$)/;
/** A subject pronoun before a helping verb: a sentence ("thanks I will read", "Sure we can", "OK I'll"). A title has none ("Issues I reported", "Phase I plan"). */
const SUBJECT_AUX = /(?:^|\s)(?:I|we|they|he|she)(?:\s+(?:will|would|can|could|should|shall|must|may|might|am|are|was|were|have|had|do|did|think|hope)|['’](?:m|ll|d|ve|re))(?=\s|$)/;
/**
 * A step that watches the page after a typed message goes in: "and wait for the response", "and check that the bot
 * replies". "and wait" at the end is sure. Wait, check, verify, confirm, ensure, see, or make sure before a word for the
 * page's reply, after only small words, is sure when the reply word ends the clause or a verb or a preposition follows
 * it; before another noun it is a maybe cut ("check the answer key"). Other "wait for" or "wait until" is a maybe cut
 * ("please restart and wait for the update to finish" can be the message). Other watch words stay in the message
 * ("thanks and confirm the meeting time").
 */
const OBSERVE = /^(wait|check|verify|confirm|ensure|see|make\s+sure)\b/;
const REPLY_WORD = /^(?:\s+(?:for|until|that|if|whether|the|a|an|its|their|it|they))*\s+(?:repl(?:y|ies|ied)|respon(?:se|ses|ds|ded)|answers?|answered|results?|output|bot|chatbot|assistant|agent)\b/i;
const REPLY_NOUN = /^\s+(?!(?:is|are|was|were|has|have|had|appears?|shows?|says?|contains?|matches|includes?|mentions?|comes?|arrives?|loads?|replies|responds|answers|to|in|from|within|before|after|and|or|then|with|by|on|at|for)\b)[a-z]/;

function observeStep(after: string): "sure" | "maybe" | null {
  const m = after.match(OBSERVE);
  if (!m) return null;
  const tail = after.slice(m[0].length);
  if (m[1] === "wait" && STEP_END.test(tail)) return "sure";
  const reply = tail.match(REPLY_WORD)?.[0];
  if (reply !== undefined) return REPLY_NOUN.test(tail.slice(reply.length)) ? "maybe" : "sure";
  return m[1] === "wait" && /^\s+(?:for|until)\s/.test(tail) ? "maybe" : null;
}

type Mode = "value" | "message" | "typed";

/**
 * How sure an "and" before `after` (the words after "and ") starts the next step of the task. `query` is true after a
 * search verb, and `before` holds the words of the value before this "and".
 * - "sure": the value ends there ("and click Save", "and press Enter", "and save it", "and invite Ann Lee", "and set
 *   priority to High", "and sign out").
 * - "maybe": a step verb before a capitalized word can start a step or belong to the value ("and open Licious",
 *   "how to install and run Python", "Review and approve Q3 budget", "and move card to Done", "and continue"). Both
 *   values are offered as a pair: the cut first, then the longer value.
 * - null: the "and" belongs to the value: a title in title case ("Show and Tell"), a noun after a word that looks like a
 *   verb ("closed and open issues", "Media and press releases"), or a message word ("we will review and approve it").
 * The word after the verb is read without the marks around it: "and click \"Save\"", "and click `Save`", and "and press
 * **Enter**" read as Save and Enter. A word of marks only is skipped ("and press ⏎ Enter").
 * In a message (after type, write, enter, fill, or put, or a sentence after "with" or "as"), only a step that sends the
 * message or acts on the page is sure. After type, enter, fill, or put, a pick from a list or a step that watches the reply
 * is sure too ("type Berlin and select the first suggestion", "type hello and wait for the response"), unless the value
 * is a sentence.
 */
function stepAfterAnd(after: string, mode: Mode, query: boolean, before: string): "sure" | "maybe" | null {
  const verb = after.match(/^([a-z]+)\b/)?.[1] ?? "";
  if (mode === "typed" && !SUBJECT_WORD.test(before)) {
    const watch = observeStep(after);
    if (watch !== null) return watch;
  }
  const flow = mode === "value" && (FLOW_VERBS.has(verb) || FLOW_PHRASE.test(after));
  if (!STEP_VERB_SET.has(verb) && !flow) return null;
  const tail = after.slice(verb.length);
  const end = STEP_END.test(tail);
  const next = (tail.match(/^\s+(?:[^\p{L}\p{N}\s,.;:!?]+\s+)?([^\s,.;:!?]+)/u)?.[1] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const rest = next === "" ? "" : tail.slice(tail.indexOf(next) + next.length);
  const cap = /^[A-Z]/.test(next);
  const pron = PRONOUN.test(next);
  const control = CONTROL_WORD.test(next);
  if (mode !== "value") {
    if (verb === "click" || verb === "tap") return end || cap || control || next === "the" || next === "on" ? "sure" : null;
    if (verb === "press" || verb === "hit") return end || cap || control || CHORD.test(next) || (next === "the" && KEY_AFTER_THE.test(rest)) ? "sure" : null;
    if (SEND_VERBS.has(verb) || verb === "share") {
      const sendEnd = end || (pron && STEP_END.test(rest)) || TEXT_NOUN_END.test(tail);
      if (sendEnd && verb !== "share") return "sure";
      // "and send it to Ann", "and send it to the team", "and post it to #general", and "and send it now" can be the next
      // step. "and reply to you soon", "and send it to you tomorrow", and a sentence before the "and" stay in the message.
      const obj = tail.match(SEND_OBJECT);
      if (SUBJECT_START.test(before) || SUBJECT_WORD.test(before)) return null;
      // Share is not a send verb: "and share" and "and share it" at the end can be words of the message ("Like and share").
      if (sendEnd) return "maybe";
      // "and send it right away", "and post it in #general", "and save the draft", "and send your message".
      if (obj === null) return pron || SEND_TEXT_OBJECT.test(tail) || /^(?:with|by|using|via)$/.test(next) ? "maybe" : null;
      const to = obj[1] ?? "";
      if (/^[A-Z]/.test(to)) return SUBJECT_START.test(to) ? null : "maybe";
      return verb !== "reply" && (obj[2] !== undefined || !/^(?:you|me|us|him|her|them)\b/i.test(to)) ? "maybe" : null;
    }
    // "and use the Send button", "and use the Enter key".
    if (verb === "use" && next === "the" && KEY_AFTER_THE.test(rest)) return "maybe";
    if (mode === "typed" && PICK_VERBS.has(verb) && (cap || pron || next === "the" || next === "a" || next === "an")) return "sure";
    return null;
  }
  if (verb === "click" || verb === "tap") return end || cap || pron || control || ARTICLE.test(next) || next === "on" ? "sure" : null;
  if (flow) {
    // A two-word step is sure only at the end of a clause or before a pronoun ("and sign out", "and make sure it is
    // saved"), and only when the value before it holds no sign or log step ("User can sign up and log in"). Other
    // forms are maybe cuts: the pair offers the cut and the longer value ("Pack bags and make sure passports are ready").
    const phrase = after.match(FLOW_PHRASE)?.[0];
    if (phrase !== undefined) {
      const ptail = after.slice(phrase.length);
      const pnext = ptail.match(/^\s+([a-z]+)\b/)?.[1] ?? "";
      const sure = (STEP_END.test(ptail) || PRONOUN.test(pnext)) && !/\b(?:sign|log)\s+(?:up|in|out|off)\b/i.test(before);
      return sure && !query ? "sure" : "maybe";
    }
    if (pron && FLOW_VERBS.has(verb)) return query ? "maybe" : "sure";
    return end || cap || ARTICLE.test(next) ? "maybe" : null;
  }
  if (verb === "press" || verb === "hit") return end || cap || control || CHORD.test(next) || next === "the" || next === "on" ? "sure" : null;
  if (verb === "submit") return end || cap || pron || ARTICLE.test(next) ? "sure" : null;
  if (PEOPLE_VERBS.has(verb) && cap) return "sure";
  if (end || pron || ARTICLE.test(next) || /^(?:to|with|then)$/.test(next)) return "sure";
  // "and go back to the list" and "and save changes to the profile" are steps; "approve changes to pricing" can be a title.
  if (/^(?:back|now|changes)$/.test(next)) return STEP_END.test(rest) || (/^\s+to\b/.test(rest) && next === "back" && !SEND_VERBS.has(verb)) ? "sure" : "maybe";
  // "and set priority to High" is a step; in a query it can be words of the query ("how to set and change status to away").
  if (FIELD_SET.test(tail)) return query ? "maybe" : "sure";
  if (OBJECT_TO.test(tail) || LABEL_ADD.test(tail)) return "maybe";
  return cap ? "maybe" : null;
}

/**
 * The first sure "and" cut in `rest` and the first maybe cut before it, outside quotes. -1 when there is none.
 */
function andCuts(rest: string, mode: Mode, query: boolean): { sure: number; maybe: number } {
  const masked = maskApostrophes(rest);
  let maybe = -1;
  for (const m of masked.matchAll(/\s(?:and|&)\s+/g)) {
    const i = m.index ?? 0;
    if ((masked.slice(0, i).match(/["“”‘’']/g) ?? []).length % 2 !== 0) continue;
    const kind = stepAfterAnd(masked.slice(i + m[0].length), mode, query, unmaskApostrophes(masked.slice(0, i)));
    if (kind === "sure") return { sure: i, maybe };
    if (kind === "maybe" && maybe < 0) maybe = i;
  }
  return { sure: -1, maybe };
}

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
/** Quote marks, after `maskApostrophes`. */
const QUOTE_MARK = /["“”‘’']/;
const OUTER_QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;
/** A fragment that starts with a quoted value and adds words after it: '"machine learning" jobs in Berlin'. */
const LEADING_QUOTE = /^["“‘']([^"“”‘’']+)["”’'](\s+[^"“”‘’']+)$/;
/**
 * The words after a quoted query that can extend it: lower-case words only ('"machine learning" jobs'). A word that
 * starts another instruction or names the field or the site ('and open the matching workflow', 'for this step',
 * 'on Wikipedia', 'now') ends that form.
 */
const QUERY_TAIL = /^(?:\s+[a-z][a-z'’-]*)+$/;
const TAIL_BREAK = /\b(?:and|or|then|as|to|for|into|with|so|but|before|after|when|if|via|using|on|at|from|by|now|please|here|there|today)\b/i;
/** Two or more capitalized words, with name particles between them: a name ("Sarah Connor", "Ludwig van Beethoven"). */
const NAME = /^[A-Z0-9][\w'’-]*(?:\s+(?:(?:van|von|de|der|den|da|di|du|la|le|bin|al|el|del|della|dos|das)\s+)*[A-Z0-9][\w'’-]*)+$/;
/**
 * The words after a complete name in a longer fragment: a qualifier of a person ("from the Berlin office", "who
 * leads QA"), or a preposition before lower-case words ("with the leads"). Capitalized words after "for", "with",
 * "on", or "and" go on with a title ("Weekly Sync with Design Team"): the name is then a cut.
 */
const PERSON_AFTER = /^(?:from|at|by|who|that|which)\b/i;
const QUALIFIER_AFTER = /^(?:with|for|of|on|in|to|and|or|as)\s+[a-z]/;
const endsName = (name: string, after: string): boolean => NAME.test(name) && (after === "" || PERSON_AFTER.test(after) || QUALIFIER_AFTER.test(after));

/** Verbs whose object can be a longer query that starts with a quoted value. */
const SEARCH_VERBS = new Set(["search for", "search", "look up", "find", "query"]);
const APOS_MASK: Record<string, string> = { "'": "\u0001", "’": "\u0002" };
const APOS_UNMASK: Record<string, string> = { "\u0001": "'", "\u0002": "’" };

/**
 * Hide apostrophes (it's, O'Brien, Macy’s, kids’ shoes) so that only quote marks stay. A ' or ’ is an apostrophe when a
 * letter comes before it and a letter comes after it, or when a letter comes before it and no single quote is open.
 * ‘ and a ' with no letter before it open a quote; the next ' or ’ that no letter follows closes it.
 */
function maskApostrophes(t: string): string {
  let open = false;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (c !== "'" && c !== "’" && c !== "‘") { out += c; continue; }
    const before = /[\p{L}\p{N}]/u.test(t.charAt(i - 1));
    const after = /\p{L}/u.test(t.charAt(i + 1));
    if (c === "‘" || (c === "'" && !before)) open = true;
    else if (before && after) { out += APOS_MASK[c] ?? c; continue; }
    else if (before && !open) { out += APOS_MASK[c] ?? c; continue; }
    else open = false;
    out += c;
  }
  return out;
}

const unmaskApostrophes = (t: string): string => t.replace(/[\u0001\u0002]/g, (m) => APOS_UNMASK[m] ?? m);
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|co|dev|app|gov|edu|uk|in|de|fr|sh)(?:\/[^\s"'<>)]*)?\b/gi;
const SECRET_LEAD = /password|passcode|pin|otp|secret/i;
/** A URL or a domain that starts a value, and "and" after it: the value is the site ("Go to amazon.com and search for shoes"). */
const SITE_AND = new RegExp(`^(?:https?:\\/\\/[^\\s"'<>)]+|${DOMAIN_RE.source})(?=\\s+(?:and|&)\\s)`, "i");

/** One word of a person's name: a capital letter, then lower-case letters ("Ann", "O'Brien", "McKay", "Mary-Jane"). "Q3" and "AI" are not. */
const NAME_WORD = String.raw`(?:[A-Z]['’])?[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:-[A-Z]?[a-z]+)*(?![\p{L}\p{N}])`;
/**
 * An @handle that is not part of an email address or a URL: "@ann.lee", or "@" before one to three name words ("@Research
 * Agent").
 */
const HANDLE = String.raw`(?<![\p{L}\p{N}_.+/-])@(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:\s${NAME_WORD}){0,2}(?![\p{L}\p{N}_.@-])|[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)`;
/** One name after a mention verb: an @handle, a quoted name, or one to three name words. */
const MENTION_ITEM = String.raw`(?:${HANDLE}|"[^"]{1,60}"|“[^”]{1,60}”|${NAME_WORD}(?:\s${NAME_WORD}){0,2})`;
/** A mention verb and its list of names: "mention Ann Lee", "Tag @ann.lee and Bob Roy", "ping Ann, Bob and Cleo". */
const MENTION_LIST = new RegExp(String.raw`(?<![\p{L}\p{N}@-])(?:[Mm]ention|[Tt]ag|[Pp]ing|@-?[Mm]ention|[Aa]t-[Mm]ention)\s+(${MENTION_ITEM}(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+)${MENTION_ITEM})*)`, "gu");
const MENTION_ONE = new RegExp(MENTION_ITEM, "gu");
const HANDLE_RE = new RegExp(HANDLE, "gu");

/**
 * The names that the task asks to mention, in task order: the names after a mention verb (mention, tag, ping, @-mention,
 * at-mention), and every @handle. A handle keeps its "@" ("@ann.lee", "@Research Agent"); a quoted name loses its quote
 * marks. "mention the delay to Ann" and "tag it with urgent" have none: a lower-case word follows the verb.
 */
export function mentionNames(task: string): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = [];
  for (const m of task.matchAll(MENTION_LIST)) {
    const list = m[1] ?? "";
    const start = (m.index ?? 0) + m[0].length - list.length;
    for (const item of list.matchAll(MENTION_ONE)) found.push({ text: item[0].replace(/^["“]|["”]$/g, ""), at: start + (item.index ?? 0) });
  }
  for (const m of task.matchAll(HANDLE_RE)) if (!/^@-?mention$/i.test(m[0])) found.push({ text: m[0], at: m.index ?? 0 });
  found.sort((a, b) => a.at - b.at);
  return found.filter((f, i) => f.text.trim() !== "" && found.findIndex((g) => g.text.toLowerCase() === f.text.toLowerCase()) === i);
}

function stripTrailing(s: string): string {
  return s.replace(/[.,;:!?)'"]+$/, "");
}

export function extractUrls(task: string): string[] {
  const found: { at: number; url: string }[] = [];
  for (const m of task.matchAll(URL_RE)) found.push({ at: m.index ?? 0, url: stripTrailing(m[0]) });
  for (const m of task.matchAll(DOMAIN_RE)) {
    const at = m.index ?? 0;
    const inside = found.some((f) => at >= f.at && at < f.at + f.url.length);
    if (inside) continue;
    const bare = stripTrailing(m[0]);
    if (/^[\d.]+$/.test(bare) || /\.(?:\d+)$/.test(bare)) continue;   // numbers such as 3.14 are not domains
    found.push({ at, url: `https://${bare}` });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) if (!out.some((u) => u.toLowerCase() === f.url.toLowerCase())) out.push(f.url);
  return out;
}

function isSecretAt(task: string, index: number): boolean {
  const before = task.slice(Math.max(0, index - 60), index);
  const words = before.split(/\s+/).filter(Boolean).slice(-4);
  return words.some((w) => SECRET_LEAD.test(w));
}

export function extractSpans(task: string, exclude: string[] = []): Span[] {
  const ex = new Set(exclude.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: Span[] = [];
  const seen = new Map<string, string>();
  /** The task position at which each span was first claimed. */
  const startOf = new Map<string, number>();
  /** The id of the span with this text (new or already added), or null when the text is not a span. */
  const add = (text: string, source: Span["source"], at: number, verb?: string, parent?: string | null, longCut = false): string | null => {
    let t = text.trim().replace(/\s+/g, " ");
    // A fragment around a quoted value ('"QA Plan', 'projects for "QA Plan"') is never the value to type. The quoted
    // span already holds the exact text, so the fragment loses its outer quote marks, and one with a mark inside goes.
    if (source === "after_verb" || source === "clause") {
      const m = maskApostrophes(t);
      const lead = m.match(LEADING_QUOTE);
      // After a search verb, a quoted value with more words after it can be the whole query ('"machine learning" jobs
      // in Berlin'). It stays without its quote marks. Words that start another instruction end that form.
      const tail = unmaskApostrophes(lead?.[2] ?? "");
      if (lead && source === "after_verb" && SEARCH_VERBS.has(verb ?? "") && QUERY_TAIL.test(tail) && !TAIL_BREAK.test(tail)) t = unmaskApostrophes(`${lead[1] ?? ""}${lead[2] ?? ""}`).trim();
      else {
        const inner = m.replace(OUTER_QUOTES, "").trim();
        if (QUOTE_MARK.test(inner)) return null;
        t = unmaskApostrophes(inner);
      }
    }
    if (t.length < 1 || t.length > LIMITS.spanChars) return null;
    const k = t.toLowerCase();
    const known = seen.get(k);
    if (known !== undefined) {
      // A topic after "about" that the task also gives as a value ("type Rust") or a name ("Alan Turing") takes that
      // source: the topic rule hides a topic from fields that take new text, and the task states this text word for word.
      // A name that is the topic itself (the same position) stays a topic for multiline fields (`Span.topic`).
      const prev = out.find((x) => x.id === known);
      if (prev && prev.source === "after_verb" && prev.verb === "about" && ((source === "after_verb" && verb !== "about") || source === "proper_noun")) {
        const itself = source === "proper_noun" && startOf.get(known) === at;
        prev.source = source;
        if (source === "after_verb" && verb) prev.verb = verb; else delete prev.verb;
        if (parent && parent !== known) prev.parent = parent; else delete prev.parent;
        if (longCut && !itself) prev.longCut = true; else delete prev.longCut;
        if (itself) prev.topic = true; else delete prev.topic;
        if (isSecretAt(task, at)) prev.secret = true;
      }
      return known;
    }
    if (ex.has(k) || out.length >= LIMITS.spans) return null;
    const span: Span = { id: `s${out.length + 1}`, text: t, source, secret: isSecretAt(task, at) };
    if (verb) span.verb = verb;
    if (parent) span.parent = parent;
    if (longCut) span.longCut = true;
    seen.set(k, span.id);
    startOf.set(span.id, at);
    out.push(span);
    return span.id;
  };
  // R0 mentions. They come first, so a name to mention keeps the source "mention" when it is also quoted or a proper noun.
  for (const m of mentionNames(task)) add(m.text, "mention", m.at);
  // R1 quoted. A single quote mark next to a letter is an apostrophe (it's, O'Brien); inside the quote it can be one
  // when a letter follows it (‘Macy’s’).
  for (const m of task.matchAll(/"([^"]{1,120})"|(?<![\p{L}\p{N}])'((?:[^']|'(?=\p{L})){1,120})'(?![\p{L}\p{N}])|“([^”]{1,120})”|‘((?:[^’]|’(?=\p{L})){1,120})’(?!\p{L})/gu)) {
    add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", "quoted", m.index ?? 0);
  }
  // R2 tokens
  for (const m of task.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) add(m[0], "email", m.index ?? 0);
  for (const m of task.matchAll(URL_RE)) add(stripTrailing(m[0]), "url", m.index ?? 0);
  for (const m of task.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,? \d{4})?\b/gi)) {
    add(m[0], "date", m.index ?? 0);
  }
  for (const m of task.matchAll(/(?:[$€£]\s?)?\b\d+(?:[.,]\d+)*(?:\s?(?:%|usd|eur|gbp|kg|km|mb|gb))?\b/gi)) {
    if (/\d/.test(m[0])) add(m[0], "number", m.index ?? 0);
  }
  // R3 after_verb. The value ends at a clause break, or at "and" before the next step (in a message, only before a
  // step that sends it: a message keeps its words together). The cut before a preposition
  // names the span it was cut from: a head that hides a long fragment hides its first words too ("a short description
  // of the follow-up", "a short description"). A cut that is a name stays on its own ("Sarah Connor from the Berlin office").
  const verbRe = new RegExp(`\\b(${VALUE_VERBS.map((v) => v.replace(/ /g, "\\s+")).join("|")})\\s+`, "gi");
  const starts = new Map<number, { id: string | null; text: string; andAt: number }>();
  for (const m of task.matchAll(verbRe)) {
    const start = (m.index ?? 0) + m[0].length;
    const rest = task.slice(start);
    const verb = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ");
    // "About" in capitals is a page or link name ("Click About"), and "about 10 minutes" is an approximation: no topic.
    if (verb === "about" && (m[1] !== "about" || /^\d/.test(rest))) continue;
    const brkAt = rest.search(CLAUSE_BREAK);
    const own = brkAt >= 0 ? rest.slice(0, brkAt) : rest;
    // A sentence after "with" or "as" is a message: a subject pronoun starts it, or one with a helping verb comes before
    // its first "and" ("Reply with thanks I will read and share it"). "Issues I reported" is a title.
    const sentence = SUBJECT_START.test(rest) || SUBJECT_AUX.test(own.split(/\s(?:and|&)\s/)[0] ?? "");
    const mode: Mode = PICK_AFTER.has(verb) && !SUBJECT_START.test(rest) ? "typed" : MESSAGE_VERBS.has(verb) || ((verb === "with" || verb === "as") && sentence) ? "message" : "value";
    // A value that starts with a URL or a domain ends at the "and" after it: "Go to amazon.com and search for shoes".
    const site = own.match(SITE_AND)?.[0];
    const cuts = site !== undefined ? { sure: site.length, maybe: -1 } : andCuts(own, mode, SEARCH_VERBS.has(verb));
    const clause = stripTrailing((cuts.sure >= 0 ? own.slice(0, cuts.sure) : own).trim());
    // A value of more than 10 words is not a span. Its first words are still cut from it, with `longCut`.
    const long = clause.split(/\s+/).length > 10;
    const whole = !long && clause.length > 0 ? add(clause, "after_verb", start, verb) : null;
    // VERIFY8-2: in a long value, a cut that ends before the first "and" before a lower-case word is not a long cut.
    // Only when the word after that "and" is a verb that starts a next step: "Priya and leave a note", not "Crash and data loss".
    const firstAnd = long && mode === "value" ? maskApostrophes(clause).match(/\s(?:and|&)\s+([a-z]+)/) : null;
    const andAt = firstAnd && NEXT_STEP_VERBS.has(firstAnd[1] ?? "") ? firstAnd.index ?? -1 : -1;
    if ((whole !== null || long) && !starts.has(start)) starts.set(start, { id: whole, text: clause, andAt });
    // A maybe cut and its longer value are a pair: a head shows both when one of them passes its hide rules. The cut
    // comes first, so a search box lists "Q3 Roadmap" before "Q3 Roadmap and open Licious".
    if (whole !== null && cuts.maybe >= 0) {
      const n = out.length;
      const cut = add(stripTrailing(own.slice(0, cuts.maybe).trim()), "after_verb", start, verb);
      const w = out.findIndex((x) => x.id === whole);
      if (cut !== null && out.length > n && w >= 0) {
        const c = out[out.length - 1] as Span;
        const full = out[w] as Span;
        c.pair = whole;
        if (full.pair === undefined) full.pair = c.id;
        out.splice(w, 0, ...out.splice(out.length - 1, 1));
      }
    }
    // A maybe cut whose longer value holds a quote mark after the "and" ('Fix login bug and choose
    // "High"'). The longer value is not a span, so the cut is offered alone.
    if (whole === null && !long && cuts.maybe >= 0 && QUOTE_MARK.test(maskApostrophes(own).slice(cuts.maybe))) {
      add(stripTrailing(own.slice(0, cuts.maybe).trim()), "after_verb", start, verb);
    }
    // A maybe cut of a value of more than 10 words: the longer value is not a span, so the cut is offered alone.
    if (whole === null && long && mode === "value" && cuts.maybe >= 0) {
      add(stripTrailing(own.slice(0, cuts.maybe).trim()), "after_verb", start, verb);
    }
    // A lead word or text noun after a message verb ("type in hello world", "type the message Hello
    // team", "enter the text Looks good") is a maybe cut: the value without it and the longer value are a pair.
    const lead = MESSAGE_VERBS.has(verb) ? clause.match(/^(?:in|out(?!\s+of\b)|the\s+(?:message|text|reply|comment|note|following(?:\s+(?:message|text))?))\s*:?\s+(?=\S)/)?.[0] : undefined;
    if (whole !== null && lead !== undefined) {
      const n = out.length;
      const cut = add(clause.slice(lead.length), "after_verb", start, verb);
      const w = out.findIndex((x) => x.id === whole);
      if (cut !== null && out.length > n && w >= 0) {
        const c = out[out.length - 1] as Span;
        const full = out[w] as Span;
        c.pair = whole;
        if (full.pair === undefined) full.pair = c.id;
        out.splice(w, 0, ...out.splice(out.length - 1, 1));
      }
    }
    // The cut before the first preposition. One that goes past a maybe "and" is neither value ("hello and send it" of
    // "hello and send it to the team"), so it is not a span.
    const noPrep = clause.replace(/\s+(?:in|on|at|from|of|by|with|for|to)\s+.*$/i, "");
    const name = endsName(noPrep, clause.slice(noPrep.length).trim());
    if (noPrep !== clause && noPrep.length > 0 && (cuts.maybe < 0 || noPrep.length <= cuts.maybe)) add(noPrep, "after_verb", start, verb, name ? null : whole, !name && long && !(andAt >= 0 && noPrep.length <= andAt));
  }
  // R4 proper nouns. A proper noun that starts an after_verb span and cuts a value short is a cut of it ("My Quarterly
  // Report Draft" of "My Quarterly Report Draft 2026"). A name that the span only goes on after is not.
  // Letters of any script: "Gödel’s" is one word, not "G". A curly apostrophe belongs to the word as a straight one does.
  for (const m of task.matchAll(/(?:^|[^.!?]\s+)((?:\p{Lu}[\p{L}\p{N}_'’-]*)(?:\s+\p{Lu}[\p{L}\p{N}_'’-]*){0,5})/gu)) {
    const at = (m.index ?? 0) + m[0].length - (m[1] ?? "").length;
    const noun = stripTrailing(m[1] ?? "");
    const from = starts.get(at);
    const after = from ? from.text.slice(noun.length).trim() : "";
    const cut = from !== undefined && !endsName(noun, after);
    if (at > 0) add(noun, "proper_noun", at, undefined, cut ? from.id : null, cut && from.id === null && !(from.andAt >= 0 && noun.length <= from.andAt));
  }
  // R5 clauses
  let pos = 0;
  for (const part of task.split(/,|;|\.(?=[\s.]|$)|\bthen\b|\band\b/i)) {
    const at = task.indexOf(part, pos);
    pos = at + part.length;
    const stripped = part.trim().replace(/^(?:open|go to|visit|search(?: for)?|click|type|read|check|tell me|get|find)\s+/i, "");
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 8) add(stripped, "clause", Math.max(0, at));
  }
  // R6 whole task
  add(task, "whole_task", 0);
  markDates(task, out);
  return out;
}

/** A --var key that names the start or the end of a date range: "start", "from_date", "check_in", "end_date", "to". */
const VAR_START = /(?:^|[_-])(?:start|from|begin|check_?in)(?:[_-]|$)/i;
const VAR_END = /(?:^|[_-])(?:end|to|until|check_?out)(?:[_-]|$)/i;

export function varSpans(vars: Record<string, string>): Span[] {
  return Object.entries(vars).map(([k, v]) => {
    const span: Span = { id: `v_${k}`, text: v, source: "var" as const, secret: SECRET_KEY.test(k) };
    const date = span.secret ? null : parseDate(v);
    if (date) {
      span.date = date;
      if (VAR_START.test(k) !== VAR_END.test(k)) span.dateRole = VAR_START.test(k) ? "start" : "end";
    }
    return span;
  });
}

/** A month name, its short form, or "Sept", with an optional dot. Group 1 is the name. */
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A day number with an optional ordinal suffix. Group 1 is the number. */
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const WEEKDAY = /^(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\.?,?\s+/i;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MONTH = new RegExp(`^${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?$`, "i");
const MONTH_DAY = new RegExp(`^${MONTH}\\s+${DAY}(?:,?\\s+(\\d{4}))?$`, "i");

/** The number of days in month `m` (1-12) of year `y`. */
export function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A real calendar date with a four-digit year. */
export function isDate(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

/** A month and a day without a year ("Sep 1", "1st of September"), or null. */
function dayMonth(text: string): { m: number; d: number } | null {
  const t = text.trim().replace(/\s+/g, " ").replace(WEEKDAY, "");
  const a = t.match(DAY_MONTH);
  const b = a ? null : t.match(MONTH_DAY);
  if ((a && a[3] !== undefined) || (b && b[3] !== undefined)) return null;
  const m = MONTHS.indexOf(((a ? a[2] : b?.[1]) ?? "").slice(0, 3).toLowerCase()) + 1;
  const d = Number(a ? a[1] : b?.[2]);
  return (a || b) && m > 0 && d >= 1 && d <= daysIn(2024, m) ? { m, d } : null;
}

/**
 * The date that `text` names as a whole, or null. It reads:
 * - ISO dates, and dates that start with the year ("2026-09-01", "2026/9/1");
 * - numeric dates with "/", ".", or "-" and a four-digit year ("9/15/2026", "15.9.2026");
 * - month names, short names, and "Sept" in either order, with an ordinal, "of", a weekday, and commas ("1 September
 *   2026", "September 1st, 2026", "Tuesday, September 1st, 2026", "1st of September 2026").
 * A date that does not exist ("31 September 2026"), a wrong weekday, a two-digit year, and a date without a year give
 * null. A numeric date whose first two numbers can both be a month ("9/1/2026") is `ambiguous`: see DateFact.
 */
export function parseDate(text: string): DateFact | null {
  let t = text.trim().replace(/\s+/g, " ").replace(/[.,;]$/, "");
  const ymd = t.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
  if (ymd) {
    const [y, m, d] = [Number(ymd[1]), Number(ymd[3]), Number(ymd[4])];
    return isDate(y, m, d) ? { y, m, d } : null;
  }
  const num = t.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/);
  if (num) {
    const [a, sep, b, y] = [Number(num[1]), num[2] as string, Number(num[3]), Number(num[4])];
    if (a > 12 && isDate(y, b, a)) return { y, m: b, d: a };
    if (b > 12 && isDate(y, a, b)) return { y, m: a, d: b };
    if (a === b && isDate(y, a, b)) return { y, m: a, d: b };
    // Both numbers can be a month: 9/1/2026 is 1 September or 9 January. Only a field of the same shape reads it.
    return a <= 12 && b <= 12 && isDate(y, a, b) && isDate(y, b, a) ? { y, m: a, d: b, ambiguous: sep } : null;
  }
  const wd = t.match(WEEKDAY);
  if (wd) t = t.slice(wd[0].length);
  const a = t.match(DAY_MONTH);
  const b = a ? null : t.match(MONTH_DAY);
  const year = a ? a[3] : b?.[3];
  if ((!a && !b) || year === undefined) return null;
  const y = Number(year);
  const m = MONTHS.indexOf(((a ? a[2] : b?.[1]) ?? "").slice(0, 3).toLowerCase()) + 1;
  const d = Number(a ? a[1] : b?.[2]);
  if (!isDate(y, m, d)) return null;
  if (wd && WEEKDAYS.indexOf((wd[1] ?? "").slice(0, 3).toLowerCase()) !== new Date(Date.UTC(y, m - 1, d)).getUTCDay()) return null;
  return { y, m, d };
}

const RANGE_WORD = /^(?:to|until|till|through|thru|-|\u2013|\u2014)$/;
const START_WORDS = /\b(?:start(?:s|ing)?|begin(?:s|ning)?|check-?in|from)(?:\s+(?:date|day|on|at|to|as|is|=|:))*\s*$/;
const END_WORDS = /\b(?:end(?:s|ing)?|check-?out|until)(?:\s+(?:date|day|on|at|to|as|is|=|:))*\s*$/;
const before = (a: DateFact, b: DateFact): boolean => a.y * 10_000 + a.m * 100 + a.d <= b.y * 10_000 + b.m * 100 + b.d;

/**
 * Date facts on the spans whose whole text is a date, and range roles. "from A to B", "between A and B", "A – B", and
 * "A until B" make A the start and B the end. So do "start" and "end" (or "check-in" and "check-out") in the words just
 * before two dates. A start or an end without a year takes the year of the other one ("between Sep 1 and Sep 15, 2026").
 * No span is added or removed: new spans would change typed_values and the operation head.
 */
function markDates(task: string, spans: Span[]): void {
  for (const s of spans) {
    const date = s.secret || s.source === "whole_task" ? null : parseDate(s.text);
    if (date) s.date = date;
  }
  const low = task.toLowerCase();
  const found = spans
    .filter((s) => !s.secret && s.source !== "whole_task" && s.source !== "clause" && (s.date !== undefined || dayMonth(s.text) !== null))
    .map((s) => ({ s, at: low.indexOf(s.text.toLowerCase()) }))
    .filter((f) => f.at >= 0)
    .sort((x, y) => x.at - y.at || y.s.text.length - x.s.text.length);
  // A date inside a longer date ("September 1" in "September 1, 2026") is not a date of its own.
  const dates = found.filter((f, i) => !found.some((g, j) => j !== i && g.at <= f.at && g.at + g.s.text.length >= f.at + f.s.text.length && g.s.text.length > f.s.text.length));
  const pair = (start: Span, end: Span): void => {
    // A date without a year takes the year of its partner: the start is not after the end.
    const sd = start.date ?? null;
    const ed = end.date ?? null;
    if (!sd && ed && !ed.ambiguous) { const dm = dayMonth(start.text); if (dm) { const y = dm.m * 100 + dm.d > ed.m * 100 + ed.d ? ed.y - 1 : ed.y; if (isDate(y, dm.m, dm.d)) start.date = { y, m: dm.m, d: dm.d }; } }
    if (!ed && sd && !sd.ambiguous) { const dm = dayMonth(end.text); if (dm) { const y = dm.m * 100 + dm.d < sd.m * 100 + sd.d ? sd.y + 1 : sd.y; if (isDate(y, dm.m, dm.d)) end.date = { y, m: dm.m, d: dm.d }; } }
    if (!start.date || !end.date) return;
    if (!start.date.ambiguous && !end.date.ambiguous && !before(start.date, end.date)) return;
    start.dateRole = "start";
    end.dateRole = "end";
  };
  for (let i = 0; i + 1 < dates.length; i++) {
    const p = dates[i] as { s: Span; at: number };
    const q = dates[i + 1] as { s: Span; at: number };
    if (p.s.dateRole || q.s.dateRole) continue;
    // Quote marks around the dates do not count: 'from "1 September 2026" to "15 September 2026"'.
    const between = low.slice(p.at + p.s.text.length, q.at).replace(/["\u201c\u201d\u2018\u2019']/g, "").trim();
    const lead = low.slice(Math.max(0, p.at - 40), p.at).replace(/["\u201c\u201d\u2018\u2019']/g, "");
    if (RANGE_WORD.test(between) || (between === "and" && /\bbetween\s*$/.test(lead))) pair(p.s, q.s);
  }
  // "start date 1 Sep 2026 and end date 15 Sep 2026": one start word and one end word.
  const starts = dates.filter((f) => !f.s.dateRole && START_WORDS.test(low.slice(Math.max(0, f.at - 40), f.at)));
  const ends = dates.filter((f) => !f.s.dateRole && END_WORDS.test(low.slice(Math.max(0, f.at - 40), f.at)));
  if (starts.length === 1 && ends.length === 1 && starts[0] !== ends[0]) pair((starts[0] as { s: Span }).s, (ends[0] as { s: Span }).s);
}

const KEY_WORD = /\b(Enter|Return|Escape|Esc|Tab|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|F\d{1,2})\b/g;
const KEY_CHORD = /\b(Ctrl|Control|Cmd|Meta|Alt|Shift)\+([A-Za-z0-9]+)\b/g;
const KEY_NORMAL: Record<string, string> = { esc: "Escape", return: "Enter", cmd: "Meta", ctrl: "Control" };

function normKey(k: string): string {
  const low = k.toLowerCase();
  if (KEY_NORMAL[low]) return KEY_NORMAL[low] as string;
  return k.length === 1 ? k.toLowerCase() : k.charAt(0).toUpperCase() + k.slice(1);
}

export function extractKeys(task: string): { label: string; key: string }[] {
  const out: { label: string; key: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: `k${out.length + 1}`, key });
  };
  for (const m of task.matchAll(KEY_CHORD)) push(`${normKey(m[1] ?? "")}+${(m[2] ?? "").length === 1 ? (m[2] ?? "").toLowerCase() : normKey(m[2] ?? "")}`);
  for (const m of task.replace(KEY_CHORD, " ").matchAll(KEY_WORD)) push(normKey(m[1] ?? ""));
  return out;
}

export function extractProfileMentions(task: string, profiles: ProfileEntry[]): ProfileEntry[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return profiles.filter((p) => {
    const names = [p.name, p.directory].filter((n) => n.length >= 2);
    return names.some((n) => new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, "i").test(task));
  });
}

export function mentionsProfileWord(task: string): boolean {
  return /\bprofile\b|\bchrome\b|\baccount\b/i.test(task);
}

export function redact(text: string, spans: Span[]): string {
  let out = text;
  for (const s of spans.filter((s) => s.secret && s.text.length > 0).sort((a, b) => b.text.length - a.text.length)) {
    out = out.split(s.text).join("***");
  }
  return out;
}

/** Copy JSON data and redact string values before JSON escaping. Preserve option ids and object keys. */
export function redactData<T>(value: T, redactor: (text: string) => string): T {
  if (typeof value === "string") return redactor(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactData(v, redactor)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v, redactor)])) as T;
  }
  return value;
}
