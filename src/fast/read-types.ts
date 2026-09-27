// The output of the page reader (Page.read, READ_SCRIPT in read.ts). Types, limits, and one shared text rule.
//
// The reader reads the whole document, not only the viewport: tables, record groups (repeated cards), form values, and
// visible text blocks. Code uses it to extract rows; Claude and the scraper LLM read it as untrusted page data. Every
// string in it comes from the page.

/** Caps of one read. A set or a text over its cap is cut, and `truncated` says so. */
export const READ_LIMITS = {
  tables: 24,            // tables and ARIA grids per read
  groups: 24,            // record groups per read
  rows: 500,             // rows per table, records per group
  columns: 40,           // columns per table, after the width fix
  cellChars: 200,        // characters per cell, slot, or form value
  slots: 40,             // slots per record
  headings: 30,          // h1-h3 texts in `meta.headings`
  formValues: 40,        // entries in `meta.selected`
  textBlocks: 400,       // entries in `text`
  textChars: 20_000,     // characters of all text blocks together
  blockChars: 500,       // characters per text block
  minRecords: 3,         // a record group has at least this many records
} as const;

export interface ReadOptions {
  /** Read the visible text blocks too. Default true. */
  text?: boolean;
  /** Override one or more caps of READ_LIMITS (tests, a smaller MCP read). */
  limits?: Partial<Record<keyof typeof READ_LIMITS, number>>;
}

/** One form value that the page shows: a select, a checked radio or checkbox, or a text or search input. */
export interface FormValue {
  kind: "select" | "radio" | "checkbox" | "input";
  /** The name attribute, else the id, else "". */
  name: string;
  /** The accessible label, else "". */
  label: string;
  /** The value attribute of the selected option or the control. */
  value: string;
  /** The visible text: the label of the selected option, the label of a radio or checkbox, the input value. */
  text: string;
}

export interface PageMeta {
  /** The texts of h1, h2, and h3 elements (and role=heading level 1-3), in document order. */
  headings: string[];
  /**
   * The values of form controls, in document order: every select (its selected option), checked radios and checkboxes,
   * and text or search inputs with a value. Never a password, hidden, or file input, nor a field whose name or label is
   * a credential (CREDENTIAL_NAME in types.ts). The NECC egg price page gives ddlMonth and ddlYear here.
   */
  selected: FormValue[];
  /** document.documentElement.lang, else "". */
  lang: string;
}

/** What a table looks like, to find it again on a later read. Only normalized header names and shape; no row text. */
export interface TableSignature {
  kind: "table";
  /** normKey of each header, in column order. */
  headers: string[];
  width: number;
  /** normKey of the caption and of the nearest heading before the table. */
  caption: string;
  heading: string;
}

export interface TableRow {
  /** The text of the last full-width section row above this row (see TableRead.sections), else null. */
  section: string | null;
  /** One text per column, width long. A spanned cell repeats its text in each column it spans. */
  cells: string[];
  /** Column index -> absolute href of the first link in that cell. Absent when the row has no link. */
  links?: Record<number, string>;
}

export interface TableRead {
  /** "t1", "t2", ... in document order. Stable only inside one read. */
  id: string;
  kind: "html" | "aria";
  caption: string;
  /** The text of the nearest heading (h1-h6, role=heading) before the table in document order, else "". */
  heading: string;
  /**
   * One label per column: the texts of the header rows in that column, unique, joined with " / ". A column with no
   * header text is "col<N>" (1-based).
   */
  headers: string[];
  /** How many leading rows are header rows (thead rows, leading rows of only th or columnheader cells, or row 1 by the number rule). */
  header_rows: number;
  /**
   * The column count: the widest row whose cells all have colspan 1; else the widest expanded row. NECC declares
   * colspan="302" in a 32-column table: its width is 32.
   */
  width: number;
  /** Data rows (header rows and section rows left out), at most READ_LIMITS.rows. */
  rows: TableRow[];
  /** The texts of the section rows, in order: a row with one cell that spans the whole width. */
  sections: string[];
  /** Data rows before the cap. */
  row_count: number;
  truncated: boolean;
  /** The table is inside another table. */
  nested: boolean;
  signature: TableSignature;
}

/** One text leaf of a record: an element with its own text, or an image with alt text. */
export interface Slot {
  /**
   * The path from the record root to the element: one `tag` or `tag.class` part per level (at most 2 class tokens, digit
   * runs as "#"), joined with ">". A second slot with the same path in one record gets "@2", the third "@3". Records of
   * one template give their slots the same keys, also when a slot is missing in some records.
   */
  key: string;
  /** The element's own text nodes, joined and squashed; "" for an image slot. At most READ_LIMITS.cellChars. */
  text: string;
  /** Line-through text: inside s, del, or strike, or text-decoration line-through on the way up to the record root (an MRP). */
  struck?: true;
  /** Inside a button or role=button in the record (ADD, Notify me). */
  button?: true;
  /** Inside a disabled control, or aria-disabled="true" (Out of stock). */
  disabled?: true;
  /** Inside h1-h6 or role=heading. */
  heading?: true;
  /** The absolute href of the nearest a[href] around the slot, inside the record. */
  href?: string;
  /** The alt text of an image slot. */
  alt?: string;
}

export interface RecordRead {
  /** The slots in document order, at most READ_LIMITS.slots. */
  slots: Slot[];
  /** The absolute href of the record: the root is a link, or one link covers the record. */
  href?: string;
}

/** One slot key of a group, for a reader of the group (Claude, the LLM, L1 re-anchor). */
export interface SlotInfo {
  key: string;
  /** Records of the group that have this slot. */
  filled: number;
  /** Up to 3 distinct texts (or alts), each at most 60 characters. */
  samples: string[];
  /** Records in which the slot is struck, is in a button, or is a heading. */
  struck: number;
  button: number;
  heading: number;
}

/** What a record group looks like, to find it again on a later read. No record text. */
export interface GroupSignature {
  kind: "records";
  /** The shape key of a record root: `tag` + up to 2 class tokens (digit runs as "#"), plus `[testid=...]` when set. */
  shape: string;
  /** The shape key of the records' container (their parent; for a merged group, the parent of the first record). */
  parent: string;
  /** The data-testid (or data-test-id, data-qa) value that all records share, else null. */
  testid: string | null;
  /** The slot keys that at least half of the records have, sorted. */
  slot_keys: string[];
}

export interface RecordGroup {
  /** "g1", "g2", ... in document order of the first record. Stable only inside one read. */
  id: string;
  /** The shape key of the records (see GroupSignature.shape). */
  shape: string;
  testid: string | null;
  /** The nearest heading before the first record, else "". */
  heading: string;
  /** Records before the cap. */
  count: number;
  records: RecordRead[];
  /** The slot keys of the group, in order of first appearance. */
  slots: SlotInfo[];
  truncated: boolean;
  signature: GroupSignature;
}

/** A visible text block in reading order: the text of one block-level element (its text nodes outside child blocks). */
export interface TextBlock {
  text: string;
  /** The lower-case tag of the block element. */
  tag: string;
  /** 1-6 for a heading. */
  level?: number;
  /** The block is inside a table or a record group of this read ("t2", "g1"). */
  in?: string;
}

export interface PageRead {
  version: 1;
  url: string;
  title: string;
  meta: PageMeta;
  tables: TableRead[];
  groups: RecordGroup[];
  /** Empty when ReadOptions.text is false. */
  text: TextBlock[];
  stats: {
    /** Milliseconds of the evaluation, measured in Node. */
    ms: number;
    /** Tables and groups found before the caps. */
    tables_seen: number;
    groups_seen: number;
    /** Elements the reader visited, open shadow roots included. */
    nodes: number;
    /** (document.scrollingElement || document.documentElement).scrollHeight, and innerHeight. */
    scroll_height: number;
    viewport_height: number;
    /** A cap cut a set, a row, or the text. */
    truncated: boolean;
  };
}

/** The scroll position after Page.wheel. */
export interface ScrollState {
  y: number;
  height: number;
  viewport: number;
  /** Elements in the document (getElementsByTagName("*")). The loader counts growth by it too. Absent: height only. */
  nodes?: number;
}

/**
 * The key form of a header name, a caption, or a heading: NFKC, lower case, whitespace runs as one space, trimmed, and
 * a trailing ":" or "*" removed. READ_SCRIPT applies the same rule in the page for the signatures; code applies it
 * when it compares a scraper's header names with a new read.
 */
export function normKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/\s*[:*]+$/, "").trim();
}
