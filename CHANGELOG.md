# Changelog

All notable changes to the "Replace Em/En Dash" extension are documented here.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Replacements now go through a single `vscode.WorkspaceEdit` instead of
  `vscode.workspace.fs.writeFile`. A project-wide run is one undo step, open
  editors are updated in place rather than overwritten on disk, and each
  document keeps its own encoding and line endings.
- Files that are not well-formed UTF-8 are no longer decoded lossily and written
  back. Previously a file containing both a UTF-8 em dash and a byte from another
  encoding had every one of those bytes rewritten as U+FFFD - the dash was fixed
  and the rest of the file was destroyed. Such files are now skipped, counted and
  named in the Output channel.
- The binary-file check reads the whole file rather than its first 8000 bytes. A
  file whose binary content began after that was previously treated as text and
  rewritten.
- Cancelling a run now leaves everything unchanged. It used to stop the loop but
  keep whatever had already been written, with a summary that did not say so.
- Files that could not be read are counted and reported. A run in which every
  file failed used to report "No em dashes or en dashes were found. Nothing to
  do." and not even offer the button that would have shown the errors.
- A single `excludeGlob` pattern is passed to `findFiles` as itself rather than
  wrapped in a one-element brace group, and an empty setting is passed as
  `undefined` rather than as `{}`.

### Added
- `dashReplacer.emDashReplacement` and `dashReplacer.enDashReplacement`, so the
  two characters can be replaced with different text. Both default to a plain
  hyphen, which is the existing behaviour.
- A test suite: 87 tests under `node --test`, run by `npm test` and by CI. The
  decision logic moved into `src/dash.ts`, which does not import `vscode`, so it
  can be driven without an extension host.

## [0.1.0] - 2026-07-27

### Fixed
- Removed all em dashes and en dashes from the extension's own codebase (README, package.json, source comments and strings) - an extension that replaces these characters shouldn't contain any itself.

### Added
- `Dash Replacer: Replace Em/En Dashes in Entire Project` command.
- `Dash Replacer: Preview Em/En Dash Occurrences in Project` command (dry run, no file writes).
- Explorer context menu commands to replace dashes in a specific folder or file.
- Configurable include/exclude globs, max file size, confirmation prompt, and output logging.
- Automatic binary-file detection to avoid corrupting non-text files.
- Per-file summary report in a dedicated "Dash Replacer" Output channel.
