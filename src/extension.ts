import * as vscode from "vscode";
import * as path from "path";

import {
  FileResult,
  Replacements,
  RunSummary,
  buildExcludePattern,
  emptySummary,
  findDashes,
  headline,
  recordChange,
  replacementFor,
  screenBytes,
  summaryLines
} from "./dash";

/**
 * The VS Code side: commands, file discovery, progress, and the single
 * `WorkspaceEdit` that carries the whole run.
 *
 * Every decision this file makes about a file's contents is delegated to
 * `dash.ts`, which knows nothing about VS Code and is tested under plain Node.
 * What is left here is plumbing, and it is deliberately thin.
 */

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Dash Replacer");

  context.subscriptions.push(
    vscode.commands.registerCommand("dashReplacer.replaceInProject", () =>
      runReplace({ scope: "project" })
    ),
    vscode.commands.registerCommand("dashReplacer.previewInProject", () =>
      runReplace({ scope: "project", dryRun: true })
    ),
    vscode.commands.registerCommand("dashReplacer.replaceInFolder", (uri: vscode.Uri) =>
      runReplace({ scope: "folder", target: uri })
    ),
    vscode.commands.registerCommand("dashReplacer.replaceInFile", (uri: vscode.Uri) =>
      runReplace({ scope: "file", target: uri })
    ),
    outputChannel
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}

async function runReplace(options: {
  scope: "project" | "folder" | "file";
  target?: vscode.Uri;
  dryRun?: boolean;
}): Promise<void> {
  const config = vscode.workspace.getConfiguration("dashReplacer");
  const dryRun = options.dryRun ?? false;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage("Dash Replacer: No folder is open in this workspace.");
    return;
  }

  // Resolve which files to scan based on scope.
  let filesToScan: vscode.Uri[];
  try {
    filesToScan = await resolveFiles(options.scope, options.target, config);
  } catch (err) {
    vscode.window.showErrorMessage(`Dash Replacer: ${(err as Error).message}`);
    return;
  }

  if (filesToScan.length === 0) {
    vscode.window.showInformationMessage("Dash Replacer: No matching files found to scan.");
    return;
  }

  const confirmBeforeReplace = config.get<boolean>("confirmBeforeReplace", true);
  if (!dryRun && confirmBeforeReplace) {
    const scopeLabel =
      options.scope === "project"
        ? "the entire project"
        : options.scope === "folder"
        ? `the folder "${path.basename(options.target?.fsPath ?? "")}"`
        : `the file "${path.basename(options.target?.fsPath ?? "")}"`;

    const choice = await vscode.window.showWarningMessage(
      `This will scan ${filesToScan.length} file(s) in ${scopeLabel} and replace every em dash (U+2014) and en dash (U+2013) with a plain hyphen (-). This modifies files on disk. Continue?`,
      { modal: true },
      "Replace Dashes"
    );
    if (choice !== "Replace Dashes") {
      return;
    }
  }

  const summary = await withProgressScan(filesToScan, config, dryRun);
  reportSummary(summary, dryRun, config);
}

async function resolveFiles(
  scope: "project" | "folder" | "file",
  target: vscode.Uri | undefined,
  config: vscode.WorkspaceConfiguration
): Promise<vscode.Uri[]> {
  if (scope === "file") {
    if (!target) {
      throw new Error("No file was provided.");
    }
    return [target];
  }

  const includeGlob = config.get<string>("includeGlob", "**/*");
  const excludeGlobRaw = config.get<string>(
    "excludeGlob",
    "**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**,**/*.min.js,**/*.lock"
  );
  const excludeGlob = buildExcludePattern(excludeGlobRaw);

  if (scope === "project") {
    return vscode.workspace.findFiles(includeGlob, excludeGlob);
  }

  // scope === 'folder'
  if (!target) {
    throw new Error("No folder was provided.");
  }
  const relativePattern = new vscode.RelativePattern(target, includeGlob);
  return vscode.workspace.findFiles(relativePattern, excludeGlob);
}

function replacementsFrom(config: vscode.WorkspaceConfiguration): Replacements {
  return {
    em: config.get<string>("emDashReplacement", "-"),
    en: config.get<string>("enDashReplacement", "-")
  };
}

/**
 * Scan every file, and collect the replacements into one `WorkspaceEdit`.
 *
 * The edit is applied once, at the end, rather than a file at a time. That is
 * what makes the whole run a single undo step, and it is also why a cancelled
 * run now changes nothing at all: there is no partially-written state to be
 * left behind.
 *
 * Files are screened as bytes first and only opened as documents when they
 * actually contain a dash, so a project-wide run does not pull every file in
 * the workspace into VS Code's document cache.
 */
async function withProgressScan(
  files: vscode.Uri[],
  config: vscode.WorkspaceConfiguration,
  dryRun: boolean
): Promise<RunSummary> {
  const maxSizeBytes = config.get<number>("maxFileSizeKB", 2048) * 1024;
  const replacements = replacementsFrom(config);

  const summary = emptySummary();
  const edit = new vscode.WorkspaceEdit();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: dryRun ? "Dash Replacer: Scanning for dashes…" : "Dash Replacer: Replacing dashes…",
      cancellable: true
    },
    async (progress, token) => {
      const total = files.length;
      let processed = 0;

      for (const uri of files) {
        if (token.isCancellationRequested) {
          summary.cancelled = true;
          break;
        }

        processed++;
        if (processed % 25 === 0 || processed === total) {
          progress.report({
            message: `${processed}/${total} files`,
            increment: (25 / total) * 100
          });
        }

        try {
          const document = await openIfWorthOpening(uri, maxSizeBytes, summary);
          if (!document) {
            continue;
          }

          summary.filesScanned++;

          const text = document.getText();
          const hits = findDashes(text);
          if (hits.length === 0) {
            continue;
          }

          const result: FileResult = {
            path: vscode.workspace.asRelativePath(uri, false),
            emDashCount: hits.filter((h) => h.kind === "em").length,
            enDashCount: hits.filter((h) => h.kind === "en").length
          };
          recordChange(summary, result);

          if (!dryRun) {
            for (const hit of hits) {
              const range = new vscode.Range(
                document.positionAt(hit.offset),
                document.positionAt(hit.offset + 1)
              );
              edit.replace(uri, range, replacementFor(hit.kind, replacements));
            }
          }
        } catch (err) {
          summary.errors++;
          outputChannel.appendLine(`Error processing ${uri.fsPath}: ${(err as Error).message}`);
        }
      }
    }
  );

  if (!dryRun && !summary.cancelled && summary.filesChanged > 0) {
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      summary.editFailed = true;
      outputChannel.appendLine(
        "applyEdit returned false: no file was changed. This usually means a " +
          "document changed underneath the scan."
      );
    }
  }

  return summary;
}

/**
 * Decide whether `uri` is worth opening as a document, and open it if so.
 *
 * A document already open in the editor is used as it is: VS Code has decoded
 * it, possibly with an encoding the user chose, and its in-memory text may
 * differ from what is on disk. Reading the bytes in that case would screen the
 * wrong content.
 *
 * Everything else is read as bytes and screened before being opened, which is
 * where files that are oversized, binary, or not valid UTF-8 are counted and
 * dropped. The UTF-8 check is the one that matters: VS Code decodes an unknown
 * file as UTF-8, and editing a document it had to decode lossily would write
 * the lost bytes back as U+FFFD.
 */
async function openIfWorthOpening(
  uri: vscode.Uri,
  maxSizeBytes: number,
  summary: RunSummary
): Promise<vscode.TextDocument | undefined> {
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString() && !d.isClosed
  );
  if (open) {
    if (Buffer.byteLength(open.getText(), "utf8") > maxSizeBytes) {
      summary.skippedTooLarge++;
      return undefined;
    }
    return open;
  }

  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > maxSizeBytes) {
    summary.skippedTooLarge++;
    return undefined;
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  switch (screenBytes(bytes, maxSizeBytes)) {
    case "too-large":
      summary.skippedTooLarge++;
      return undefined;
    case "binary":
      summary.skippedBinary++;
      return undefined;
    case "undecodable":
      summary.skippedUndecodable++;
      outputChannel.appendLine(`Skipped ${uri.fsPath}: not valid UTF-8.`);
      return undefined;
    case "no-dashes":
      summary.filesScanned++;
      return undefined;
    case "candidate":
      return vscode.workspace.openTextDocument(uri);
  }
}

function reportSummary(
  summary: RunSummary,
  dryRun: boolean,
  config: vscode.WorkspaceConfiguration
): void {
  const message = headline(summary, dryRun);
  const hasDetails = summary.filesChanged > 0 || summary.errors > 0 || summary.skippedUndecodable > 0;

  if (!hasDetails) {
    vscode.window.showInformationMessage(message);
    return;
  }

  vscode.window.showInformationMessage(message, "Show Details").then((choice) => {
    if (choice === "Show Details") {
      outputChannel.show(true);
    }
  });

  if (config.get<boolean>("openSummaryInOutputChannel", true)) {
    for (const line of summaryLines(summary, dryRun, new Date().toLocaleString())) {
      outputChannel.appendLine(line);
    }
  }
}
