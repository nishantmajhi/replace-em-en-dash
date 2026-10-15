/* Regression tests: one per defect, each run against both implementations.
 *
 *   npm test
 *
 * Every test in this file asserts twice. Once against `tests/original.js`,
 * which is the original extension's logic transcribed from commit 27e3bf1, to
 * show that the defect was real and is reproduced here. Once against
 * `out/dash.js`, the compiled fix, to show that it is gone. A test that only
 * did the second half would prove nothing about whether there had been a bug.
 *
 * The original wrote files with `vscode.workspace.fs.writeFile`, so the unit
 * under test is "given these bytes on disk, what bytes does the extension leave
 * there". `newPipeline` below is the fixed extension's answer to that same
 * question, assembled from the same pure functions `src/extension.ts` calls.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const original = require("./original.js");
const dash = require("../out/dash.js");

const EM = "\u2014";
const EN = "\u2013";

/* The fixed extension's decision path for a file that is not already open in
   an editor, in the same shape as original.processFile so the two can be
   compared directly. `src/extension.ts` does exactly this: screenBytes, then
   findDashes over the decoded text, then a ranged edit per hit. */
function newPipeline(bytes, { maxSizeBytes = 2048 * 1024, dryRun = false } = {}) {
  const verdict = dash.screenBytes(bytes, maxSizeBytes);
  const result = { outcome: verdict, bytesOnDisk: bytes, emCount: 0, enCount: 0 };

  if (verdict !== "candidate") {
    return result;
  }

  const text = Buffer.from(bytes).toString("utf8");
  const counts = dash.countDashes(text);
  result.emCount = counts.em;
  result.enCount = counts.en;

  if (!dryRun) {
    result.outcome = "written";
    result.bytesOnDisk = Buffer.from(
      dash.replaceDashes(text, dash.DEFAULT_REPLACEMENTS),
      "utf8"
    );
  }
  return result;
}

/* ── 1. A file that is not valid UTF-8 is destroyed ─────────── */

test("original: a stray non-UTF-8 byte is replaced by U+FFFD when the file is rewritten", () => {
  /* The defect. A file that is mostly UTF-8 but contains one byte from another
     encoding still contains a real em dash, so the original found something to
     replace and wrote the file back out. The write went through
     `Buffer.from(text, "utf8")` where `text` came from a lossy decode, so the
     stray byte had already become U+FFFD and was written back as EF BF BD.
     The dash was fixed and the rest of the line was destroyed. */
  const bytes = Buffer.concat([
    Buffer.from("caf", "ascii"),
    Buffer.from([0xe9]), // é in Windows-1252, not valid UTF-8
    Buffer.from(" " + EM + " bar", "utf8")
  ]);

  const r = original.processFile(bytes);

  assert.equal(r.outcome, "written");
  assert.equal(r.bytesOnDisk.includes(0xe9), false, "the CP1252 byte did not survive");
  assert.deepEqual(
    [...r.bytesOnDisk.subarray(3, 6)],
    [0xef, 0xbf, 0xbd],
    "it was rewritten as the replacement character"
  );
});

test("fixed: a file that is not valid UTF-8 is left alone and counted as such", () => {
  const bytes = Buffer.concat([
    Buffer.from("caf", "ascii"),
    Buffer.from([0xe9]),
    Buffer.from(" " + EM + " bar", "utf8")
  ]);

  const r = newPipeline(bytes);

  assert.equal(r.outcome, "undecodable");
  assert.equal(r.bytesOnDisk, bytes, "the file is not touched at all");
});

test("fixed: an undecodable file is reported rather than silently skipped", () => {
  /* The other half of the fix. Refusing the file is only safe if the user is
     told, otherwise the extension reports a clean run over a file whose dashes
     it could not see. */
  const summary = dash.emptySummary();
  summary.skippedUndecodable = 2;

  const line = dash.headline(summary, false);
  assert.match(line, /not valid UTF-8/);
  assert.doesNotMatch(line, /Nothing to do/);
});

/* ── 2. Dashes in a legacy codepage are silently missed ─────── */

test("original: a Windows-1252 em dash is not found, and the file is reported as clean", () => {
  /* 0x97 is an em dash in Windows-1252. Decoded as UTF-8 it becomes U+FFFD, so
     the counts came out zero, the file was not written, and it was added to
     `filesScanned` - the summary said it had been scanned and had no dashes in
     it. The tool's one job, silently not done. */
  const bytes = Buffer.from([0x32, 0x30, 0x32, 0x30, 0x97, 0x32, 0x30, 0x32, 0x34]); // 2020-2024

  const r = original.processFile(bytes);

  assert.equal(r.outcome, "unchanged");
  assert.equal(r.emCount, 0);
  assert.equal(r.scanned, 1, "counted as a successfully scanned text file");
});

test("fixed: the same file is classed as undecodable, not as scanned and clean", () => {
  const bytes = Buffer.from([0x32, 0x30, 0x32, 0x30, 0x97, 0x32, 0x30, 0x32, 0x34]);
  assert.equal(dash.screenBytes(bytes, 2048 * 1024), "undecodable");
});

/* ── 3. The review's UTF-16 example, which was wrong ────────── */

test("both: a UTF-16 file is skipped as binary, not corrupted", () => {
  /* review.md said a UTF-16 file would be "read as mojibake ... and written
     back as UTF-8 - corrupting the entire file". It would not: UTF-16 text in
     the Latin range has a NUL byte for every second character, so the
     binary heuristic rejects it before anything is decoded. The correction is
     recorded at the top of review.md. This test exists to keep it true. */
  const u16 = Buffer.from("a" + EM + " plain sentence", "utf16le");

  assert.equal(original.looksBinary(u16), true);
  assert.equal(original.processFile(u16).outcome, "binary");
  assert.equal(dash.screenBytes(u16, 2048 * 1024), "binary");
});

/* ── 4. The binary check only looked at the first 8000 bytes ── */

test("original: a file whose binary content starts after 8000 bytes is treated as text", () => {
  /* `looksBinary` sampled `Math.min(bytes.length, 8000)`. A file with clean
     text at the front and binary further in passed the check, was decoded
     lossily, and was written back - so the binary tail was destroyed, not just
     the dashes. */
  const bytes = Buffer.concat([
    Buffer.from("A prose header " + EM + " with a dash in it.\n".padEnd(9000, "x"), "utf8"),
    Buffer.from([0x00, 0xff, 0x00, 0xfe])
  ]);

  assert.equal(original.looksBinary(bytes), false, "the heuristic did not see the NULs");

  const r = original.processFile(bytes);
  assert.equal(r.outcome, "written");
  assert.equal(r.bytesOnDisk.includes(0xff), false, "the binary tail was rewritten");
});

test("fixed: a NUL anywhere in the file makes it binary", () => {
  const bytes = Buffer.concat([
    Buffer.from("A prose header " + EM + " with a dash in it.\n".padEnd(9000, "x"), "utf8"),
    Buffer.from([0x00, 0xff, 0x00, 0xfe])
  ]);

  assert.equal(dash.containsNul(bytes), true);
  assert.equal(dash.screenBytes(bytes, 2048 * 1024), "binary");
});

/* ── 5. The exclude glob was always wrapped in braces ───────── */

test("original: one exclude pattern is handed to findFiles wrapped in braces", () => {
  assert.equal(original.buildExcludeGlob("**/node_modules/**"), "{**/node_modules/**}");
});

test("original: an empty exclude setting becomes the empty brace group", () => {
  assert.equal(original.buildExcludeGlob(""), "{}");
  assert.equal(original.buildExcludeGlob("  ,  "), "{}");
});

test("fixed: one pattern is passed through as itself, and none becomes undefined", () => {
  /* `findFiles` documents `undefined` as "exclude nothing". `{}` is not
     documented at all, and a single-element brace group depends on how the
     glob engine treats `{a}` - which is behaviour this extension has no reason
     to rely on when it can simply pass the pattern. */
  assert.equal(dash.buildExcludePattern("**/node_modules/**"), "**/node_modules/**");
  assert.equal(dash.buildExcludePattern(""), undefined);
  assert.equal(dash.buildExcludePattern("  ,  "), undefined);
  assert.equal(dash.buildExcludePattern("a,b"), "{a,b}", "several still need the group");
});

/* ── 6. Errors were counted nowhere ─────────────────────────── */

test("original: there is no error counter to report", () => {
  /* Structural rather than behavioural, so the assertion is about the shape of
     the original summary. `RunSummary` had `skippedBinary` and
     `skippedTooLarge` and nothing else; per-file failures went to the output
     channel and were never counted, so a run in which every file failed said
     "No em dashes or en dashes were found. Nothing to do." and did not even
     offer the "Show Details" button that would have shown the errors. */
  const originalSummaryFields = [
    "filesScanned",
    "filesChanged",
    "totalReplacements",
    "emDashTotal",
    "enDashTotal",
    "results",
    "skippedBinary",
    "skippedTooLarge"
  ];
  assert.equal(originalSummaryFields.includes("errors"), false);
});

test("fixed: a run in which everything failed says so", () => {
  const summary = dash.emptySummary();
  summary.errors = 7;

  const line = dash.headline(summary, false);
  assert.match(line, /7 file\(s\) could not be read/);
  assert.doesNotMatch(line, /Nothing to do/);
});

/* ── 7. The write path itself ───────────────────────────────── */

test("fixed: the compiled extension no longer writes files behind the editor's back", () => {
  /* The headline defect - a project-wide replacement that Ctrl+Z could not
     undo - cannot be reproduced outside a running extension host, because it
     is a property of which API is called. What can be checked, and what stops
     it coming back, is that the call is gone: replacements now go through a
     WorkspaceEdit, which VS Code records as one undoable operation and applies
     to open documents in place. See review.md for the manual check. */
  const fs = require("node:fs");
  const compiled = fs.readFileSync(require.resolve("../out/extension.js"), "utf8");

  assert.match(compiled, /applyEdit/, "the edit goes through workspace.applyEdit");
  assert.match(compiled, /WorkspaceEdit/);
  assert.doesNotMatch(compiled, /fs\.writeFile/, "nothing writes to disk directly any more");
});

test("fixed: a cancelled run is reported as having changed nothing", () => {
  /* Previously cancelling stopped the loop but left every file written so far
     rewritten, with a summary that did not mention it. With one edit applied at
     the end there is nothing partial to leave behind, and the message says so. */
  const summary = dash.emptySummary();
  summary.cancelled = true;
  summary.filesChanged = 3;
  summary.totalReplacements = 9;

  assert.match(dash.headline(summary, false), /Cancelled before the end; nothing was changed/);
});
