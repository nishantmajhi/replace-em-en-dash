/**
 * Deciding which files to touch, which characters to replace in them, and what
 * to say afterwards.
 *
 * Nothing here imports `vscode`. That is deliberate, and it is the point of the
 * file: the original had all of this inlined between a `readFile` and a
 * `writeFile` inside a progress callback, which is why none of it had ever been
 * run outside a live editor. Everything below is a pure function over a buffer
 * or a string, so `tests/dash.test.js` can drive it under plain Node.
 */

/** Em dash, U+2014. */
export const EM_DASH = "\u2014";
/** En dash, U+2013. */
export const EN_DASH = "\u2013";

/** UTF-8 encodings of the two characters, used to pre-screen files as bytes. */
const EM_DASH_BYTES = [0xe2, 0x80, 0x94];
const EN_DASH_BYTES = [0xe2, 0x80, 0x93];

export type DashKind = "em" | "en";

/** One dash found in a document, at an offset in UTF-16 code units. */
export interface DashHit {
  offset: number;
  kind: DashKind;
}

/** What each kind of dash is replaced with. */
export interface Replacements {
  em: string;
  en: string;
}

/** The defaults, which are what the extension has always done. */
export const DEFAULT_REPLACEMENTS: Replacements = { em: "-", en: "-" };

/**
 * Every em and en dash in `text`, in order.
 *
 * Offsets rather than a rewritten string: the caller turns each one into a
 * `vscode.Range` and puts it in a `WorkspaceEdit`, which is what makes the run
 * undoable and leaves the document's encoding and line endings to VS Code.
 */
export function findDashes(text: string): DashHit[] {
  const hits: DashHit[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === EM_DASH) {
      hits.push({ offset: i, kind: "em" });
    } else if (c === EN_DASH) {
      hits.push({ offset: i, kind: "en" });
    }
  }
  return hits;
}

/** Counts of each kind, without building the list of hits. */
export function countDashes(text: string): { em: number; en: number } {
  let em = 0;
  let en = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === EM_DASH) {
      em++;
    } else if (text[i] === EN_DASH) {
      en++;
    }
  }
  return { em, en };
}

export function replacementFor(kind: DashKind, replacements: Replacements): string {
  return kind === "em" ? replacements.em : replacements.en;
}

/**
 * Apply `replacements` to `text`. The extension does not use this - it edits
 * through VS Code so the change can be undone - but it is the definition the
 * offsets from `findDashes` are expected to agree with, and the tests check
 * that they do.
 */
export function replaceDashes(text: string, replacements: Replacements): string {
  let out = "";
  let last = 0;
  for (const hit of findDashes(text)) {
    out += text.slice(last, hit.offset) + replacementFor(hit.kind, replacements);
    last = hit.offset + 1;
  }
  return out + text.slice(last);
}

/**
 * Does the buffer contain a NUL byte anywhere?
 *
 * The original looked at the first 8000 bytes only, so a file whose binary
 * content began after that was decoded as text and rewritten. Scanning the
 * whole buffer costs nothing worth measuring - by this point the file has
 * already been read into memory and capped at `maxFileSizeKB`.
 */
export function containsNul(bytes: Uint8Array): boolean {
  return bytes.indexOf(0) !== -1;
}

/**
 * Is the buffer well-formed UTF-8?
 *
 * This is the guard that replaced the original's unconditional
 * `Buffer.from(bytes).toString("utf8")`. That decode is lossy - every byte it
 * cannot interpret becomes U+FFFD - and the original wrote the decoded string
 * straight back, so a file that was not valid UTF-8 but did contain a UTF-8 em
 * dash had every other non-ASCII byte in it destroyed. A file that cannot be
 * decoded losslessly is one this extension has no business rewriting.
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Does the buffer contain the UTF-8 encoding of either dash? */
export function hasDashBytes(bytes: Uint8Array): boolean {
  return indexOfBytes(bytes, EM_DASH_BYTES) !== -1 || indexOfBytes(bytes, EN_DASH_BYTES) !== -1;
}

function indexOfBytes(haystack: Uint8Array, needle: number[]): number {
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }
  return -1;
}

/**
 * What to do with a file, decided from its bytes alone.
 *
 * `candidate` is the only verdict that leads to the file being opened as a
 * document. Everything else is counted and skipped, and every skip has its own
 * name so the summary can say which it was.
 */
export type Verdict = "too-large" | "binary" | "undecodable" | "no-dashes" | "candidate";

export function screenBytes(bytes: Uint8Array, maxSizeBytes: number): Verdict {
  if (bytes.length > maxSizeBytes) {
    return "too-large";
  }
  if (containsNul(bytes)) {
    return "binary";
  }
  if (!isValidUtf8(bytes)) {
    return "undecodable";
  }
  return hasDashBytes(bytes) ? "candidate" : "no-dashes";
}

/**
 * Split the comma-separated `excludeGlob` setting into a pattern `findFiles`
 * will accept, or `undefined` when the setting is empty.
 *
 * The original always wrapped the result in braces, including when there was
 * one pattern or none, which made `{}` out of an empty setting. A single
 * pattern is now passed through as itself and an empty one as `undefined`,
 * which is what the API documents for "exclude nothing".
 */
export function splitExcludeGlob(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildExcludePattern(raw: string): string | undefined {
  const parts = splitExcludeGlob(raw);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return "{" + parts.join(",") + "}";
}

/** One file that had dashes in it. */
export interface FileResult {
  path: string;
  emDashCount: number;
  enDashCount: number;
}

export interface RunSummary {
  filesScanned: number;
  filesChanged: number;
  totalReplacements: number;
  emDashTotal: number;
  enDashTotal: number;
  results: FileResult[];
  skippedBinary: number;
  skippedTooLarge: number;
  skippedUndecodable: number;
  errors: number;
  cancelled: boolean;
  editFailed: boolean;
}

export function emptySummary(): RunSummary {
  return {
    filesScanned: 0,
    filesChanged: 0,
    totalReplacements: 0,
    emDashTotal: 0,
    enDashTotal: 0,
    results: [],
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedUndecodable: 0,
    errors: 0,
    cancelled: false,
    editFailed: false
  };
}

/** Fold one file's counts into the running summary. */
export function recordChange(summary: RunSummary, result: FileResult): void {
  summary.filesChanged++;
  summary.emDashTotal += result.emDashCount;
  summary.enDashTotal += result.enDashCount;
  summary.totalReplacements += result.emDashCount + result.enDashCount;
  summary.results.push(result);
}

/**
 * The one-line message shown in the notification.
 *
 * The wording of the ordinary cases is the original's, unchanged. What is new
 * is that files which errored or could not be decoded are named. The original
 * counted neither, so a run in which every file failed to read reported "No em
 * dashes or en dashes were found. Nothing to do." - and, because it only
 * offered "Show Details" when something had changed, the errors it had written
 * to the output channel were unreachable from that message.
 */
export function headline(summary: RunSummary, dryRun: boolean): string {
  if (summary.editFailed) {
    return "Dash Replacer: the edit could not be applied, so nothing was changed.";
  }

  const verb = dryRun ? "found in" : "replaced in";
  const trailer = [
    summary.skippedUndecodable > 0
      ? `${summary.skippedUndecodable} file(s) were skipped as not valid UTF-8`
      : "",
    summary.errors > 0 ? `${summary.errors} file(s) could not be read` : ""
  ]
    .filter(Boolean)
    .join("; ");

  const cancelled = summary.cancelled ? " Cancelled before the end; nothing was changed." : "";

  if (summary.filesChanged === 0) {
    const base = "Dash Replacer: No em dashes or en dashes were found.";
    const tail = trailer ? ` ${capitalise(trailer)}.` : summary.cancelled ? "" : " Nothing to do.";
    return `${base}${tail}${cancelled}`;
  }

  const base =
    `Dash Replacer: ${summary.totalReplacements} dash(es) ${verb} ${summary.filesChanged} file(s) ` +
    `(scanned ${summary.filesScanned} text file(s); skipped ${summary.skippedBinary} binary, ` +
    `${summary.skippedTooLarge} oversized).`;

  return trailer ? `${base} ${capitalise(trailer)}.${cancelled}` : `${base}${cancelled}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The block written to the output channel. */
export function summaryLines(summary: RunSummary, dryRun: boolean, when: string): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(60));
  lines.push(`Dash Replacer ${dryRun ? "preview" : "run"} - ${when}`);
  lines.push(
    `Em dashes (U+2014): ${summary.emDashTotal}   En dashes (U+2013): ${summary.enDashTotal}   ` +
      `Total: ${summary.totalReplacements}`
  );
  lines.push(
    `Skipped: ${summary.skippedBinary} binary, ${summary.skippedTooLarge} oversized, ` +
      `${summary.skippedUndecodable} not valid UTF-8, ${summary.errors} unreadable.`
  );
  if (summary.cancelled) {
    lines.push("Cancelled before the end; no file was changed.");
  }
  lines.push("-".repeat(60));
  for (const r of summary.results) {
    lines.push(
      `${r.path}  em:${r.emDashCount}  en:${r.enDashCount}  total:${r.emDashCount + r.enDashCount}`
    );
  }
  lines.push("=".repeat(60));
  return lines;
}
