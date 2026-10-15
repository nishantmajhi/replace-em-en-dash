# Code Review - Dash Replacer (replace-em-en-dash)

First reviewed 2026-09-04. **Remediated 2026-09-18** on branch
`cleanup/2026-09-18`. This file is now a record rather than a to-do list.

## Corrections to the first review

Two things the first review got wrong. Both are now pinned by tests, in
`tests/regression.test.js`, so they cannot quietly become true again.

**The UTF-16 example was wrong.** Finding 2 said a UTF-16 file would be "read as
mojibake, has its 'dashes' replaced (or not), and is written back as UTF-8 -
corrupting the entire file, not just the dashes". It would not. UTF-16 text in
the Latin range has a NUL byte for every second character, and the binary
heuristic at `:237` rejected the file before anything was decoded. The original
skipped those files, counted them as binary, and left them alone. The test is
`both: a UTF-16 file is skipped as binary, not corrupted`.

**The corruption was real but needed a narrower input than the review described,
and there was a second failure mode it did not mention.** The original only
wrote a file if the decoded text contained a real em or en dash. So:

- A file in a legacy codepage throughout - say Windows-1252, where an em dash is
  the single byte 0x97 - decoded to U+FFFD, produced a count of zero, and was
  never written. It was **not** corrupted. It was added to `filesScanned` and
  reported as a text file with no dashes in it. The tool's one job, silently not
  done, with a summary that said everything was fine.
- Corruption needed a file containing **both** a valid UTF-8 dash **and** a byte
  that is not valid UTF-8 - a mixed-encoding file, which is what you get when
  two tools have edited the same file. Then the dash was replaced, the write
  happened, and every unrepresentable byte went to disk as EF BF BD.

Both are reproduced against the original code in `tests/regression.test.js`.

## What this project is

A VS Code extension that finds em dashes and en dashes across a project, a
folder, or a single file and replaces them with a plain hyphen, with a preview
mode, a confirmation prompt, include/exclude globs, a file-size cap, and a
summary written to an output channel.

## What was fixed

**1. P1 - a project-wide replacement could not be undone.** `:211` wrote each
file with `vscode.workspace.fs.writeFile`, which VS Code has no record of: Ctrl+Z
did nothing, and a file with unsaved changes in a tab was overwritten underneath
the user.

Every replacement now goes into one `vscode.WorkspaceEdit`, applied once with
`vscode.workspace.applyEdit` after the scan finishes. The whole run is a single
undo step, open documents are edited in place, and VS Code owns the encoding and
the line endings.

Two things fell out of that shape and are improvements in their own right. A
cancelled run now changes nothing at all, because the edit had not been applied
yet - previously cancelling kept whatever had already been written and the
summary did not mention it. And if `applyEdit` returns false, the summary says
the edit could not be applied rather than reporting a success that did not
happen.

**2. P1 - every rewritten file was forced to UTF-8.** See the correction above
for what this actually did. The fix is that a file is now screened before it is
opened, and one that is not well-formed UTF-8 is skipped, counted, and named in
the output channel. `isValidUtf8` in `src/dash.ts` is the guard.

This is a deliberate refusal rather than a repair. The alternative - guessing the
encoding - is a much larger feature, and guessing wrong on a bulk destructive
command is worse than declining. The README says plainly that a dash in a legacy
codepage will not be found, and what to do about it.

Note that `WorkspaceEdit` alone would not have fixed this. VS Code decodes an
unknown file as UTF-8 too; editing a document it had to decode lossily and saving
it writes the U+FFFD back. The byte-level guard is what makes it safe.

**3. The binary check only looked at the first 8000 bytes.** Not in the first
review. `looksBinary` sampled `Math.min(bytes.length, 8000)`, so a file with
clean text at the front and binary content further in was decoded as text and
rewritten - destroying the tail, not just the dashes. `containsNul` now scans the
whole buffer, which costs nothing worth measuring: the file has already been read
into memory and capped at `maxFileSizeKB`.

**4. Errors were counted nowhere.** P3 in the first review, and worse than it
looked. Per-file failures went to the output channel and were never counted, and
the summary only offered the "Show Details" button when something had changed. So
a run in which every file failed to read said "No em dashes or en dashes were
found. Nothing to do." and gave the user no way to reach the errors it had just
written. Errors and undecodable files are now counted, named in the headline, and
the details button is offered whenever there is anything to show.

**5. The exclude glob was always wrapped in braces.** Not in the first review.
`{${parts.join(",")}}` at `:120` produced `{**/node_modules/**}` for a single
pattern and `{}` for an empty setting. `findFiles` documents `undefined` as
"exclude nothing"; `{}` is not documented at all, and relying on a glob engine to
treat a one-element brace group as a group is an unnecessary dependency when the
pattern can simply be passed through. `buildExcludePattern` now returns the
pattern itself for one, a brace group for several, and `undefined` for none.

I did not reproduce a user-visible failure from this one, because doing so needs
VS Code's own glob engine. It is listed as hardening, not as a proven bug.

**6. P2 - the replacement was not configurable.** Added
`dashReplacer.emDashReplacement` and `dashReplacer.enDashReplacement`.

Both default to `-`, which is what the extension has always done. The first
review suggested defaulting the em dash to `" - "`; I did not, because changing
what a bulk destructive command does by default, silently, on upgrade, is a worse
outcome than leaving the user to set it. The reasoning is in the README next to
the settings.

**7. P3 - dashes inside code are replaced too.** Documented, in its own paragraph
in the README under Settings, with the suggestion to preview first or narrow
`includeGlob`.

**8. The stray `.vsix` is deleted.** It was untracked and gitignored.

## Structure

`src/extension.ts` was one 289-line file with the decisions inlined between a
`readFile` and a `writeFile` inside a progress callback, which is why none of it
had ever been run outside a live editor.

The decisions are now in `src/dash.ts`, which does not import `vscode`: the file
screening, the dash scan, the replacement, the exclude-glob handling and the
summary text. `src/extension.ts` keeps the commands, the globs, the progress
reporting and the edit. This is the same split as
`VS Code Extensions/smart-commit/src/git.ts` next door, and for the same reason.

## Tests

87 tests, `node --test`, no framework added. `npm test` compiles and runs them,
and CI runs them between the compile and the package step.

- `tests/dash.test.js` - the ordinary coverage of `src/dash.ts`.
- `tests/regression.test.js` - one test per defect above, each run against
  **both** implementations.
- `tests/original.js` - the original's decision logic transcribed from commit
  `27e3bf1`, with the two `vscode.workspace.fs` calls replaced by a buffer in and
  a buffer out. It exists so that every "the original did X" claim in this file
  is executed rather than remembered.

The three assertions in the fixed half that could be run against the original
were checked to fail against it before the fix was committed.

Two things the suite pins that are easy to get wrong:

- **Offsets are UTF-16 code units.** `document.positionAt` takes a UTF-16 offset,
  so the scan has to walk code units. A document with an emoji before the dash is
  where a code-point scan goes wrong, and there is a test for exactly that.
- **UTF-16LE text in the ASCII range is valid UTF-8.** `61 00 62 00` is four
  legal single-byte sequences, so `isValidUtf8` says yes to it. Only the NUL
  check rejects it, which is why that check is load-bearing rather than a
  nicety.

## Deliberately not done

- **The `publisher` field is still `your-publisher-name`,** and the repository,
  bugs and homepage URLs still say `your-github-username`. Inventing a publisher
  identity is the author's call, not a cleanup decision. The README says to
  replace them before publishing.
- **The progress `increment` is still wrong.** `(25 / total) * 100` is reported on
  the final batch regardless of how many files it actually contained, so the bar
  overshoots on the last step. It is display only, and the standing constraint in
  `CLAUDE.md` is to leave the UI alone.
- **The confirmation dialog still counts every matched file,** including ones that
  will be skipped as binary or oversized, so it can promise to scan more files
  than it will. Also UI copy, also left alone.
- **No encoding detection.** See fix 2. Guessing an encoding on a bulk
  destructive command is a feature, not a fix.
- **`activationEvents: []`** is correct for current VS Code versions, which derive
  activation from `contributes.commands`. Unchanged.

## Not verified here: the extension has never been loaded

**This is the item for whoever is next.** Nothing in this archive can run a VS
Code extension host, so the headline fix - that the run is undoable - is the one
thing that has not been observed. What is verified is that `fs.writeFile` is gone
from the compiled output and `applyEdit` is there, which `tests/regression.test.js`
asserts, and that the offsets fed to it are correct.

Five steps, about ten minutes, in an Extension Development Host (`F5`):

1. Make a scratch folder with three or four `.md` files, each containing a few em
   and en dashes, and open two of them in tabs. Type something into one so it is
   dirty.
2. Run **Preview Em/En Dash Occurrences in Project**. Check the counts against the
   files, and check that nothing was written.
3. Run **Replace Em/En Dashes in Entire Project**. The open tabs should update in
   place; the dirty one should keep its unsaved edit *and* have its dashes
   replaced.
4. Press **Ctrl+Z once**. Every file should go back, in one step. This is the
   fix. If it takes more than one undo, or if a closed file does not revert,
   something about the single-edit shape is wrong.
5. Save a file as Windows-1252 with an em dash in it (`Save with Encoding`), and
   run again. It should be reported as skipped and not valid UTF-8, and the file
   should be byte-identical afterwards.

Worth doing at the same time: start a project-wide run on a large folder and
press Cancel. Nothing should change.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same, and `package.json`
declares `SEE LICENSE IN LICENSE`, npm's form for a licence with no SPDX
identifier. Anything above that calls the licence an open question, or calls
the project MIT, is superseded.

This repository's `origin/main` already publishes an MIT `LICENSE`. Copies
taken under it keep MIT; the new licence governs the code from this branch on.

## CI, 2026-10-02

The existing `.github/workflows/ci.yml` was checked and left unchanged: run
from a fresh one-commit clone on Ubuntu 24.04, it compiles, passes the suite
and packages the `.vsix` (10 files, 24 KB). It runs on Node 20, which reached
end of life in April 2026; moving it to 24 is a one-line change when you next
touch it. It triggers on `main` only.
