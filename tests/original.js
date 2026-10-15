/* The original extension's decision logic, transcribed from
 * `git show 27e3bf1:src/extension.ts`, so that the regression tests can be run
 * against it.
 *
 * Nothing here is imported by the extension. It exists so that every claim the
 * suite makes about "the original did X" is executed rather than asserted from
 * memory, and so that a test which would pass against the unfixed code is
 * visible as such.
 *
 * The original had no seam to test: its logic sat inside a `for` loop in
 * `withProgressScan`, between a `vscode.workspace.fs.readFile` and a
 * `vscode.workspace.fs.writeFile`. `processFile` below is that loop body with
 * the two filesystem calls replaced by a buffer in and a buffer out. Line
 * references are to the original file.
 */

"use strict";

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const DASH_REGEX = new RegExp(`[${EM_DASH}${EN_DASH}]`, "g"); // :7

/** Original :237-245. Samples the first 8000 bytes only. */
function looksBinary(bytes) {
  const sampleLength = Math.min(bytes.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Original :223-231. */
function countChar(text, char) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char) {
      count++;
    }
  }
  return count;
}

/** Original :120-124. Wraps the comma-separated setting in a brace group. */
function buildExcludeGlob(excludeGlobRaw) {
  return `{${excludeGlobRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",")}}`;
}

/**
 * Original :179-215, the body of the per-file loop, with the two
 * `vscode.workspace.fs` calls lifted out.
 *
 * Returns what the original would have done with the file: the bytes it would
 * have left on disk, and the counters it would have added to the summary.
 */
function processFile(bytes, { maxSizeBytes = 2048 * 1024, dryRun = false } = {}) {
  const result = {
    outcome: null, // 'too-large' | 'binary' | 'unchanged' | 'written'
    bytesOnDisk: bytes,
    scanned: 0,
    changed: 0,
    emCount: 0,
    enCount: 0
  };

  if (bytes.length > maxSizeBytes) {
    result.outcome = "too-large";
    return result;
  }

  if (looksBinary(bytes)) {
    result.outcome = "binary";
    return result;
  }

  const text = Buffer.from(bytes).toString("utf8"); // :193
  const emCount = countChar(text, EM_DASH);
  const enCount = countChar(text, EN_DASH);

  result.scanned = 1;
  result.emCount = emCount;
  result.enCount = enCount;

  if (emCount === 0 && enCount === 0) {
    result.outcome = "unchanged";
    return result;
  }

  result.changed = 1;

  if (!dryRun) {
    const replaced = text.replace(DASH_REGEX, "-"); // :210
    result.bytesOnDisk = Buffer.from(replaced, "utf8"); // :211
    result.outcome = "written";
  } else {
    result.outcome = "unchanged";
  }

  return result;
}

module.exports = { EM_DASH, EN_DASH, looksBinary, countChar, buildExcludeGlob, processFile };
