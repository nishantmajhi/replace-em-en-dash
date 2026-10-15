/* Unit tests for the decision logic in src/dash.ts.
 *
 *   npm test
 *
 * These drive out/dash.js - the compiled output - because that is what ships.
 * Nothing here imports vscode, and nothing here touches the filesystem.
 *
 * The defects that prompted the rewrite have their own file,
 * tests/regression.test.js, where each one is also run against the original
 * code. This file is the ordinary coverage: what the functions do at their
 * edges, and the invariants the extension relies on.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const dash = require("../out/dash.js");

const EM = "\u2014";
const EN = "\u2013";
const CAP = 2048 * 1024;

/* ── The two characters ─────────────────────────────────────── */

test("the constants are the characters they claim to be", () => {
  assert.equal(dash.EM_DASH.codePointAt(0), 0x2014);
  assert.equal(dash.EN_DASH.codePointAt(0), 0x2013);
  assert.equal(dash.EM_DASH.length, 1);
  assert.equal(dash.EN_DASH.length, 1);
});

test("the defaults are a plain hyphen for both", () => {
  assert.deepEqual(dash.DEFAULT_REPLACEMENTS, { em: "-", en: "-" });
});

/* ── findDashes ─────────────────────────────────────────────── */

test("findDashes on an empty string finds nothing", () => {
  assert.deepEqual(dash.findDashes(""), []);
});

test("findDashes on text with no dashes finds nothing", () => {
  assert.deepEqual(dash.findDashes("a plain hyphen - is not a dash"), []);
});

test("findDashes locates a single em dash", () => {
  assert.deepEqual(dash.findDashes("a" + EM + "b"), [{ offset: 1, kind: "em" }]);
});

test("findDashes locates a single en dash", () => {
  assert.deepEqual(dash.findDashes("a" + EN + "b"), [{ offset: 1, kind: "en" }]);
});

test("findDashes returns hits in document order", () => {
  const hits = dash.findDashes(EN + "x" + EM + "y" + EN);
  assert.deepEqual(hits, [
    { offset: 0, kind: "en" },
    { offset: 2, kind: "em" },
    { offset: 4, kind: "en" }
  ]);
});

test("findDashes handles a dash at the very start and the very end", () => {
  assert.deepEqual(dash.findDashes(EM), [{ offset: 0, kind: "em" }]);
  const hits = dash.findDashes("ab" + EN);
  assert.deepEqual(hits, [{ offset: 2, kind: "en" }]);
});

test("findDashes handles runs of adjacent dashes", () => {
  const hits = dash.findDashes(EM + EM + EN);
  assert.equal(hits.length, 3);
  assert.deepEqual(
    hits.map((h) => h.kind),
    ["em", "em", "en"]
  );
});

test("findDashes offsets are UTF-16 code units, so surrogate pairs count as two", () => {
  /* This is the invariant that makes the ranges correct. `positionAt` takes a
     UTF-16 offset, which is what a JavaScript string index already is - but
     only if the scan walks code units rather than code points. A document with
     an emoji before the dash is where a code-point scan goes wrong. */
  const text = "\u{1D11E}" + EM; // a musical G clef, which is a surrogate pair
  assert.equal(text.length, 3);
  assert.deepEqual(dash.findDashes(text), [{ offset: 2, kind: "em" }]);
});

test("findDashes is not confused by a hyphen, a minus sign, or a horizontal bar", () => {
  const lookalikes = "-−―‒‐";
  assert.deepEqual(dash.findDashes(lookalikes), []);
});

test("findDashes finds dashes across line breaks", () => {
  const hits = dash.findDashes("one" + EM + "\r\ntwo" + EN + "\n");
  assert.deepEqual(
    hits.map((h) => h.offset),
    [3, 9]
  );
});

/* ── countDashes ────────────────────────────────────────────── */

test("countDashes agrees with findDashes", () => {
  const text = "a" + EM + "b" + EN + "c" + EM + EM;
  const counts = dash.countDashes(text);
  const hits = dash.findDashes(text);

  assert.equal(counts.em, hits.filter((h) => h.kind === "em").length);
  assert.equal(counts.en, hits.filter((h) => h.kind === "en").length);
  assert.equal(counts.em, 3);
  assert.equal(counts.en, 1);
});

test("countDashes on empty and dashless text is zero", () => {
  assert.deepEqual(dash.countDashes(""), { em: 0, en: 0 });
  assert.deepEqual(dash.countDashes("nothing here"), { em: 0, en: 0 });
});

/* ── replacementFor and replaceDashes ───────────────────────── */

test("replacementFor picks the value for the kind", () => {
  const r = { em: " -- ", en: "-" };
  assert.equal(dash.replacementFor("em", r), " -- ");
  assert.equal(dash.replacementFor("en", r), "-");
});

test("replaceDashes with the defaults reproduces the original behaviour", () => {
  assert.equal(
    dash.replaceDashes("2020" + EN + "2024 and a break" + EM + "here", dash.DEFAULT_REPLACEMENTS),
    "2020-2024 and a break-here"
  );
});

test("replaceDashes leaves text with no dashes untouched", () => {
  const text = "nothing to do - really";
  assert.equal(dash.replaceDashes(text, dash.DEFAULT_REPLACEMENTS), text);
});

test("replaceDashes can use different text for each kind", () => {
  assert.equal(
    dash.replaceDashes("a" + EM + "b" + EN + "c", { em: " -- ", en: "-" }),
    "a -- b-c"
  );
});

test("replaceDashes with an empty replacement deletes the dash", () => {
  assert.equal(dash.replaceDashes("a" + EM + "b", { em: "", en: "" }), "ab");
});

test("replaceDashes does not reprocess its own output", () => {
  /* A replacement containing a dash is inserted, not rescanned. One pass. */
  assert.equal(dash.replaceDashes("a" + EM + "b", { em: EN, en: "-" }), "a" + EN + "b");
});

test("replaceDashes handles a string that is nothing but dashes", () => {
  assert.equal(dash.replaceDashes(EM + EN + EM, dash.DEFAULT_REPLACEMENTS), "---");
});

test("replaceDashes preserves CRLF line endings", () => {
  assert.equal(
    dash.replaceDashes("a" + EM + "\r\nb", dash.DEFAULT_REPLACEMENTS),
    "a-\r\nb"
  );
});

test("the offsets from findDashes rebuild exactly what replaceDashes produces", () => {
  /* The invariant the extension depends on: it never calls replaceDashes, it
     builds one edit per offset and lets VS Code apply them. Applying them by
     hand, last first, has to give the same answer. */
  const replacements = { em: "<EM>", en: "<EN>" };
  const text = "start" + EM + "mid" + EN + EN + "end" + EM;

  let rebuilt = text;
  for (const hit of [...dash.findDashes(text)].reverse()) {
    rebuilt =
      rebuilt.slice(0, hit.offset) +
      dash.replacementFor(hit.kind, replacements) +
      rebuilt.slice(hit.offset + 1);
  }

  assert.equal(rebuilt, dash.replaceDashes(text, replacements));
  assert.equal(rebuilt, "start<EM>mid<EN><EN>end<EM>");
});

/* ── containsNul ────────────────────────────────────────────── */

test("containsNul is false for text", () => {
  assert.equal(dash.containsNul(Buffer.from("hello " + EM + " world", "utf8")), false);
});

test("containsNul is false for an empty buffer", () => {
  assert.equal(dash.containsNul(Buffer.alloc(0)), false);
});

test("containsNul finds a NUL at the first byte", () => {
  assert.equal(dash.containsNul(Buffer.from([0x00, 0x41])), true);
});

test("containsNul finds a NUL at the last byte", () => {
  assert.equal(dash.containsNul(Buffer.from([0x41, 0x00])), true);
});

test("containsNul finds a NUL far past the original 8000-byte sample", () => {
  const bytes = Buffer.concat([Buffer.alloc(50000, 0x41), Buffer.from([0x00])]);
  assert.equal(dash.containsNul(bytes), true);
});

test("containsNul accepts a plain Uint8Array, not only a Buffer", () => {
  assert.equal(dash.containsNul(new Uint8Array([1, 2, 0])), true);
  assert.equal(dash.containsNul(new Uint8Array([1, 2, 3])), false);
});

/* ── isValidUtf8 ────────────────────────────────────────────── */

test("isValidUtf8 accepts ASCII and an empty buffer", () => {
  assert.equal(dash.isValidUtf8(Buffer.from("plain ascii", "ascii")), true);
  assert.equal(dash.isValidUtf8(Buffer.alloc(0)), true);
});

test("isValidUtf8 accepts two-, three- and four-byte sequences", () => {
  assert.equal(dash.isValidUtf8(Buffer.from("café", "utf8")), true);
  assert.equal(dash.isValidUtf8(Buffer.from(EM + EN, "utf8")), true);
  assert.equal(dash.isValidUtf8(Buffer.from("\u{1F600}", "utf8")), true);
});

test("isValidUtf8 accepts a UTF-8 byte order mark", () => {
  assert.equal(dash.isValidUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), true);
});

test("isValidUtf8 rejects a lone continuation byte", () => {
  assert.equal(dash.isValidUtf8(Buffer.from([0x41, 0x80, 0x41])), false);
});

test("isValidUtf8 rejects a truncated multi-byte sequence", () => {
  assert.equal(dash.isValidUtf8(Buffer.from([0xe2, 0x80])), false, "em dash missing its last byte");
  assert.equal(dash.isValidUtf8(Buffer.from([0xc3])), false);
});

test("isValidUtf8 rejects an overlong encoding", () => {
  // C0 80 is a two-byte encoding of NUL, which UTF-8 does not allow.
  assert.equal(dash.isValidUtf8(Buffer.from([0xc0, 0x80])), false);
});

test("isValidUtf8 rejects a surrogate encoded as UTF-8", () => {
  // ED A0 80 is U+D800, which is not a scalar value.
  assert.equal(dash.isValidUtf8(Buffer.from([0xed, 0xa0, 0x80])), false);
});

test("isValidUtf8 rejects a byte that cannot start a sequence", () => {
  assert.equal(dash.isValidUtf8(Buffer.from([0xf8, 0x88, 0x80, 0x80, 0x80])), false);
  assert.equal(dash.isValidUtf8(Buffer.from([0xff])), false);
});

test("isValidUtf8 rejects Windows-1252 high bytes", () => {
  // The case that mattered: 0x97 is an em dash in that codepage.
  assert.equal(dash.isValidUtf8(Buffer.from([0x61, 0x97, 0x62])), false);
});

/* ── hasDashBytes ───────────────────────────────────────────── */

test("hasDashBytes finds an em dash and an en dash", () => {
  assert.equal(dash.hasDashBytes(Buffer.from("a" + EM + "b", "utf8")), true);
  assert.equal(dash.hasDashBytes(Buffer.from("a" + EN + "b", "utf8")), true);
});

test("hasDashBytes is false for text without either", () => {
  assert.equal(dash.hasDashBytes(Buffer.from("a - b", "utf8")), false);
  assert.equal(dash.hasDashBytes(Buffer.alloc(0)), false);
});

test("hasDashBytes is not fooled by a partial sequence", () => {
  assert.equal(dash.hasDashBytes(Buffer.from([0xe2, 0x80])), false);
  assert.equal(dash.hasDashBytes(Buffer.from([0xe2, 0x80, 0x95])), false, "U+2015, not a dash");
});

test("hasDashBytes finds a dash at the very end of the buffer", () => {
  assert.equal(dash.hasDashBytes(Buffer.from("text" + EM, "utf8")), true);
});

test("hasDashBytes finds a dash in a large buffer", () => {
  const bytes = Buffer.concat([Buffer.alloc(40000, 0x41), Buffer.from(EN, "utf8")]);
  assert.equal(dash.hasDashBytes(bytes), true);
});

/* ── screenBytes ────────────────────────────────────────────── */

test("screenBytes calls a file with a dash in it a candidate", () => {
  assert.equal(dash.screenBytes(Buffer.from("a" + EM + "b", "utf8"), CAP), "candidate");
});

test("screenBytes calls a dashless text file no-dashes", () => {
  assert.equal(dash.screenBytes(Buffer.from("nothing here", "utf8"), CAP), "no-dashes");
});

test("screenBytes calls an oversized file too-large", () => {
  assert.equal(dash.screenBytes(Buffer.from("a" + EM, "utf8"), 2), "too-large");
});

test("screenBytes calls a file with NULs binary", () => {
  assert.equal(dash.screenBytes(Buffer.from([0x41, 0x00, 0x42]), CAP), "binary");
});

test("screenBytes calls a file that is not valid UTF-8 undecodable", () => {
  assert.equal(dash.screenBytes(Buffer.from([0x41, 0x97, 0x42]), CAP), "undecodable");
});

test("screenBytes checks size before anything else", () => {
  const big = Buffer.concat([Buffer.from([0x00]), Buffer.from(EM, "utf8")]);
  assert.equal(dash.screenBytes(big, 1), "too-large");
});

test("screenBytes checks binary before decodability", () => {
  // A buffer that is both: it has a NUL and it is not valid UTF-8. "Binary" is
  // the more useful thing to tell the user, and it is what the original said.
  const both = Buffer.from([0x41, 0x00, 0xff]);
  assert.equal(dash.isValidUtf8(both), false);
  assert.equal(dash.containsNul(both), true);
  assert.equal(dash.screenBytes(both, CAP), "binary");
});

test("UTF-16 text in the ASCII range is valid UTF-8, and is caught by the NUL check", () => {
  /* Worth pinning, because it is counter-intuitive and it is why the NUL
     heuristic is load-bearing rather than merely a nicety. UTF-16LE "ab" is
     61 00 62 00, and every one of those bytes is a legal single-byte UTF-8
     sequence - so isValidUtf8 says yes. Only containsNul rejects it. */
  const u16 = Buffer.from("ab", "utf16le");
  assert.equal(dash.isValidUtf8(u16), true);
  assert.equal(dash.containsNul(u16), true);
  assert.equal(dash.screenBytes(u16, CAP), "binary");
});

test("screenBytes accepts a file exactly at the cap", () => {
  const bytes = Buffer.from("abcd", "utf8");
  assert.equal(dash.screenBytes(bytes, 4), "no-dashes");
  assert.equal(dash.screenBytes(bytes, 3), "too-large");
});

test("screenBytes calls an empty file no-dashes", () => {
  assert.equal(dash.screenBytes(Buffer.alloc(0), CAP), "no-dashes");
});

/* ── splitExcludeGlob and buildExcludePattern ───────────────── */

test("splitExcludeGlob trims and drops empties", () => {
  assert.deepEqual(dash.splitExcludeGlob(" a , b ,, c "), ["a", "b", "c"]);
  assert.deepEqual(dash.splitExcludeGlob(""), []);
  assert.deepEqual(dash.splitExcludeGlob("   "), []);
});

test("buildExcludePattern returns undefined when there is nothing to exclude", () => {
  assert.equal(dash.buildExcludePattern(""), undefined);
  assert.equal(dash.buildExcludePattern(" , , "), undefined);
});

test("buildExcludePattern returns a single pattern unwrapped", () => {
  assert.equal(dash.buildExcludePattern("**/*.min.js"), "**/*.min.js");
  assert.equal(dash.buildExcludePattern("  **/*.min.js  "), "**/*.min.js");
});

test("buildExcludePattern groups several patterns", () => {
  assert.equal(dash.buildExcludePattern("a,b,c"), "{a,b,c}");
});

test("buildExcludePattern handles the shipped default", () => {
  const shipped =
    "**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**,**/*.min.js,**/*.lock";
  const pattern = dash.buildExcludePattern(shipped);
  assert.equal(pattern.startsWith("{"), true);
  assert.equal(pattern.endsWith("}"), true);
  assert.equal(dash.splitExcludeGlob(shipped).length, 8);
});

/* ── the summary ────────────────────────────────────────────── */

test("emptySummary starts every counter at zero", () => {
  const s = dash.emptySummary();
  assert.equal(s.filesScanned, 0);
  assert.equal(s.filesChanged, 0);
  assert.equal(s.totalReplacements, 0);
  assert.equal(s.skippedBinary, 0);
  assert.equal(s.skippedTooLarge, 0);
  assert.equal(s.skippedUndecodable, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.cancelled, false);
  assert.equal(s.editFailed, false);
  assert.deepEqual(s.results, []);
});

test("recordChange accumulates counts and keeps the file", () => {
  const s = dash.emptySummary();
  dash.recordChange(s, { path: "a.md", emDashCount: 2, enDashCount: 1 });
  dash.recordChange(s, { path: "b.md", emDashCount: 0, enDashCount: 3 });

  assert.equal(s.filesChanged, 2);
  assert.equal(s.emDashTotal, 2);
  assert.equal(s.enDashTotal, 4);
  assert.equal(s.totalReplacements, 6);
  assert.deepEqual(
    s.results.map((r) => r.path),
    ["a.md", "b.md"]
  );
});

test("headline reports a clean run in the original words", () => {
  const s = dash.emptySummary();
  assert.equal(
    dash.headline(s, false),
    "Dash Replacer: No em dashes or en dashes were found. Nothing to do."
  );
});

test("headline reports a replacement run in the original words", () => {
  const s = dash.emptySummary();
  dash.recordChange(s, { path: "a.md", emDashCount: 2, enDashCount: 1 });
  s.filesScanned = 10;
  s.skippedBinary = 4;
  s.skippedTooLarge = 1;

  assert.equal(
    dash.headline(s, false),
    "Dash Replacer: 3 dash(es) replaced in 1 file(s) (scanned 10 text file(s); " +
      "skipped 4 binary, 1 oversized)."
  );
});

test("headline says found rather than replaced for a preview", () => {
  const s = dash.emptySummary();
  dash.recordChange(s, { path: "a.md", emDashCount: 1, enDashCount: 0 });
  s.filesScanned = 1;

  assert.match(dash.headline(s, true), /1 dash\(es\) found in 1 file\(s\)/);
  assert.match(dash.headline(s, false), /1 dash\(es\) replaced in 1 file\(s\)/);
});

test("headline names undecodable files on an otherwise clean run", () => {
  const s = dash.emptySummary();
  s.skippedUndecodable = 3;
  assert.equal(
    dash.headline(s, false),
    "Dash Replacer: No em dashes or en dashes were found. 3 file(s) were skipped as not valid UTF-8."
  );
});

test("headline names both kinds of problem at once", () => {
  const s = dash.emptySummary();
  s.skippedUndecodable = 2;
  s.errors = 1;
  const line = dash.headline(s, false);
  assert.match(line, /2 file\(s\) were skipped as not valid UTF-8/);
  assert.match(line, /1 file\(s\) could not be read/);
});

test("headline reports a failed edit and nothing else", () => {
  const s = dash.emptySummary();
  dash.recordChange(s, { path: "a.md", emDashCount: 9, enDashCount: 0 });
  s.editFailed = true;
  assert.equal(
    dash.headline(s, false),
    "Dash Replacer: the edit could not be applied, so nothing was changed."
  );
});

test("summaryLines carries the totals, the skips and one line per file", () => {
  const s = dash.emptySummary();
  dash.recordChange(s, { path: "docs/a.md", emDashCount: 2, enDashCount: 1 });
  dash.recordChange(s, { path: "docs/b.md", emDashCount: 0, enDashCount: 5 });
  s.skippedBinary = 3;
  s.skippedTooLarge = 1;
  s.skippedUndecodable = 2;
  s.errors = 4;

  const lines = dash.summaryLines(s, false, "SOME TIME");
  const text = lines.join("\n");

  assert.match(text, /Dash Replacer run - SOME TIME/);
  assert.match(text, /Em dashes \(U\+2014\): 2 {3}En dashes \(U\+2013\): 6 {3}Total: 8/);
  assert.match(text, /Skipped: 3 binary, 1 oversized, 2 not valid UTF-8, 4 unreadable\./);
  assert.match(text, /docs\/a\.md {2}em:2 {2}en:1 {2}total:3/);
  assert.match(text, /docs\/b\.md {2}em:0 {2}en:5 {2}total:5/);
});

test("summaryLines says preview for a dry run", () => {
  const lines = dash.summaryLines(dash.emptySummary(), true, "T");
  assert.match(lines.join("\n"), /Dash Replacer preview - T/);
});

test("summaryLines mentions a cancelled run", () => {
  const s = dash.emptySummary();
  s.cancelled = true;
  assert.match(dash.summaryLines(s, false, "T").join("\n"), /Cancelled before the end/);
});

test("summaryLines has no file lines when nothing changed", () => {
  const lines = dash.summaryLines(dash.emptySummary(), false, "T");
  assert.equal(
    lines.filter((l) => l.includes("em:")).length,
    0
  );
});

/* ── an end-to-end pass over a realistic document ───────────── */

test("a realistic document is screened, counted and rewritten consistently", () => {
  const document = [
    "# Notes",
    "",
    "The range 2020" + EN + "2024 is covered" + EM + "in full" + EM + "by this file.",
    "A plain hyphen - stays put, and so does a minus −.",
    ""
  ].join("\r\n");
  const bytes = Buffer.from(document, "utf8");

  assert.equal(dash.screenBytes(bytes, CAP), "candidate");

  const counts = dash.countDashes(document);
  assert.deepEqual(counts, { em: 2, en: 1 });

  const out = dash.replaceDashes(document, dash.DEFAULT_REPLACEMENTS);
  assert.equal(out.includes(EM), false);
  assert.equal(out.includes(EN), false);
  assert.equal(out.includes("−"), true, "the minus sign is untouched");
  assert.equal(out.split("\r\n").length, 5, "line endings are unchanged");
  assert.equal(dash.screenBytes(Buffer.from(out, "utf8"), CAP), "no-dashes");
});

test("headline says a cancelled run was cancelled even when it found nothing", () => {
  /* Otherwise a run stopped after two files reports "Nothing to do." over a
     project it never finished looking at. */
  const s = dash.emptySummary();
  s.cancelled = true;
  const line = dash.headline(s, false);
  assert.match(line, /Cancelled before the end/);
  assert.doesNotMatch(line, /Nothing to do/);
});
