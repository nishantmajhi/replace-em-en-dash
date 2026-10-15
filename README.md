# Replace Em/En Dash

A VS Code extension that replaces every em dash (U+2014) and en dash (U+2013)
with a plain hyphen, across a whole workspace, one folder, or one file.

Text pasted from Word, Google Docs or a language model arrives full of typographic
dashes. They are fine in prose and a nuisance in a commit message, a config file,
a shell script or an identifier. This removes them in one pass.

## What it actually does

The run is a single **`WorkspaceEdit`**, applied once at the end of the scan.
That is the whole design, and three useful properties fall out of it:

- **Ctrl+Z undoes the entire run**, across every file it touched, as one step.
  Nothing is written behind the editor's back.
- **Files open in a tab are edited in place.** A tab with unsaved changes is not
  overwritten on disk underneath you.
- **Each document keeps its own encoding and line endings**, because VS Code does
  the decoding and re-encoding rather than the extension.

If you cancel while it is scanning, nothing is changed at all - there is no
half-finished state to clean up, because the edit had not been applied yet.

## What it will not touch

Only U+2014 and U+2013 are replaced. A hyphen-minus, a true minus sign (U+2212),
a horizontal bar (U+2015) and a figure dash (U+2012) are all left alone.

Files are screened before they are opened, and a file is skipped if it is:

| Skipped | Why |
| --- | --- |
| larger than `maxFileSizeKB` | it is unlikely to be prose, and cheap to opt back in |
| containing a NUL byte anywhere | it is binary; rewriting it as text would destroy it |
| not well-formed UTF-8 | see below |

The UTF-8 rule is the one worth understanding. VS Code decodes an unknown file as
UTF-8, and a byte it cannot interpret becomes U+FFFD. Editing a document that was
decoded that way and saving it writes the replacement characters back, so the
dashes get fixed and every other non-ASCII byte in the file is destroyed. A file
this extension cannot decode losslessly is a file it has no business rewriting,
so it counts it, names it in the Output channel, and moves on.

The practical consequence: **a dash stored in a legacy codepage is not found.**
An em dash saved as byte 0x97 in Windows-1252 is not an em dash as far as this
extension is concerned. It will tell you the file was skipped rather than tell you
it was clean. Reopen the file with the right encoding (`Reopen with Encoding` in
the command palette), save it as UTF-8, and run again.

## Using it

From the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Dash Replacer: Preview Em/En Dash Occurrences in Project** - counts everything
  and changes nothing. Worth running first.
- **Dash Replacer: Replace Em/En Dashes in Entire Project**

From the Explorer context menu, on any folder or file:

- **Replace Em/En Dashes in This Folder**
- **Replace Em/En Dashes in This File**

A summary notification appears when the run finishes. **Show Details** opens the
"Dash Replacer" Output channel, which lists every changed file with its per-kind
counts, plus how many files were skipped and why.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `dashReplacer.includeGlob` | `**/*` | Which files to scan. |
| `dashReplacer.excludeGlob` | `**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**,**/*.min.js,**/*.lock` | Comma-separated patterns to skip. Empty means exclude nothing. |
| `dashReplacer.maxFileSizeKB` | `2048` | Skip files larger than this. |
| `dashReplacer.confirmBeforeReplace` | `true` | Ask before applying the edit. |
| `dashReplacer.openSummaryInOutputChannel` | `true` | Write the per-file summary to the Output channel. |
| `dashReplacer.emDashReplacement` | `-` | What each em dash becomes. |
| `dashReplacer.enDashReplacement` | `-` | What each en dash becomes. |

The last two exist because the two characters do different jobs. An en dash is
usually a range, and turning a range into `2020-2024` is right. An em dash is usually
punctuation, and if your source writes it without surrounding spaces then `" - "`
may read better than `"-"`. Both default to a plain hyphen, which is what the
extension has always done.

The default `includeGlob` is `**/*`, so a project-wide run rewrites dashes **inside
code as well as inside prose** - string literals, regular expressions, test
fixtures and fenced code blocks included. That is usually what you want when you
are cleaning up pasted text, and occasionally not. Preview first, or narrow
`includeGlob` to `**/*.md` and the like.

## Building from source

```bash
npm install
npm run compile      # tsc -p ./
npm test             # compiles, then runs the suite under node --test
```

Press `F5` in VS Code to launch an Extension Development Host with the extension
loaded.

To build a `.vsix`:

```bash
npx vsce package
```

`package.json` ships with placeholder `publisher` and repository URLs. Replace them
before publishing anywhere.

## Layout

```
src/dash.ts        the decisions: which files, which characters, what to report
src/extension.ts   the VS Code plumbing: commands, globs, progress, the edit
tests/dash.test.js        unit tests for src/dash.ts
tests/regression.test.js  one test per fixed defect
tests/original.js         the pre-fix logic, so the regressions can be shown to fail
```

`src/dash.ts` does not import `vscode`. That is what makes it testable: the suite
runs under plain Node with no extension host and no VS Code installation, and it
covers the file screening, the dash scan, the replacement, the glob handling and
the summary text. `tests/regression.test.js` runs each defect against
`tests/original.js` as well, so every claim that something used to be broken is
executed rather than asserted.

There are 87 tests. `npm test` is the whole suite.

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
