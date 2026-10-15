import * as vscode from "vscode";
import * as path from "path";

import * as git from "./git";
import {
  buildDefaultMessage,
  isInside,
  outsidersOf,
  realNorm,
  sensitivePaths,
  summariseFiles,
  truncate,
} from "./workspace";

// ---------------------------------------------------------------------------
// The command
//
// This file is the VS Code plumbing and nothing else. Every decision it makes
// is a function in ./git or ./workspace, which import no editor API and are
// covered by tests/.
// ---------------------------------------------------------------------------

/** Absolute paths of the files currently open in text editors. */
function openTextFiles(): string[] {
  const files: string[] = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        files.push(tab.input.uri.fsPath);
      }
    }
  }

  return files;
}

/** Pick the workspace folder to commit, asking when there is more than one. */
async function chooseWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      "Smart Commit: No workspace folder open. Open a folder first.",
    );
    return undefined;
  }

  if (folders.length === 1) return folders[0].uri.fsPath;

  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })),
    { placeHolder: "Smart Commit: Select workspace folder to commit" },
  );

  return picked?.root;
}

/** Save every dirty editor that belongs to this workspace. */
async function saveWorkspaceEditors(workspaceRoot: string): Promise<void> {
  const root = realNorm(workspaceRoot);

  await vscode.workspace.saveAll(false);

  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty || doc.isUntitled) continue;

    if (isInside(realNorm(doc.uri.fsPath), root)) {
      await doc.save();
    }
  }
}

/**
 * Make sure there is a repository, asking first if there is not.
 *
 * `git init` used to run silently on whatever folder happened to be open, and
 * `git add .` followed two steps later. Running the command in Downloads or a
 * scratch directory turned it into a repository and staged everything in it.
 *
 * @returns true to carry on, false if the user declined.
 */
async function ensureRepository(workspaceRoot: string): Promise<boolean> {
  if (git.isRepository(workspaceRoot)) return true;

  const answer = await vscode.window.showWarningMessage(
    `Smart Commit: ${workspaceRoot} is not a git repository.`,
    { modal: true, detail: "Initialise a new repository here?" },
    "Initialise Repository",
  );

  if (answer !== "Initialise Repository") {
    vscode.window.showInformationMessage("Smart Commit: Cancelled.");
    return false;
  }

  git.init(workspaceRoot);
  vscode.window.showInformationMessage(
    `Smart Commit: Initialised a git repository in ${workspaceRoot}`,
  );

  return true;
}

/**
 * Ask about anything staged that looks like a credential.
 *
 * @returns true to carry on.
 */
async function confirmSensitiveFiles(staged: string[]): Promise<boolean> {
  const flagged = sensitivePaths(staged);

  if (flagged.length === 0) return true;

  const answer = await vscode.window.showWarningMessage(
    `Smart Commit: ${flagged.length} staged file(s) look like credentials.`,
    {
      modal: true,
      detail:
        `${summariseFiles(flagged)}\n\n` +
        "Committing a secret is hard to undo — it stays readable in the " +
        "history even after a later commit removes it. Add these to " +
        ".gitignore instead, unless you are sure.",
    },
    "Commit Anyway",
  );

  return answer === "Commit Anyway";
}

async function saveAndCommit(): Promise<void> {
  const workspaceRoot = await chooseWorkspaceRoot();
  if (!workspaceRoot) return;

  await saveWorkspaceEditors(workspaceRoot);

  if (!(await ensureRepository(workspaceRoot))) return;

  const config = vscode.workspace.getConfiguration("smartCommit");
  const template: string =
    config.get("commitMessageTemplate") ?? "chore: auto-commit {date} {time}";
  const promptForMessage: boolean = config.get("promptForMessage") ?? true;
  const gitUserName: string = config.get("gitUserName") ?? "";
  const gitUserEmail: string = config.get("gitUserEmail") ?? "";

  // These come from settings, which a workspace can supply, so they reach git
  // as arguments and never as part of a command line. See src/git.ts.
  git.applyIdentity(workspaceRoot, gitUserName, gitUserEmail);

  const outsiders = outsidersOf(openTextFiles(), workspaceRoot);

  if (outsiders.length > 0) {
    vscode.window.showInformationMessage(
      `Smart Commit: Skipping file(s) outside workspace: ${summariseFiles(
        outsiders.map((p) => path.basename(p)),
      )}`,
    );
  }

  // Everything the user had staged before this command ran. Restoring this on
  // cancel is what stops Escape destroying a partial commit somebody built by
  // hand.
  const indexBefore = git.snapshotIndex(workspaceRoot);
  const stagedBefore = git.stagedPaths(workspaceRoot);

  const restore = () => {
    try {
      if (indexBefore !== null) {
        git.restoreIndex(indexBefore, workspaceRoot);
      } else {
        // write-tree refuses during a merge. Unstaging just what this command
        // added is less exact — a file that was already staged and has since
        // been modified keeps the newer content — but it still leaves the
        // user's own work staged.
        const added = git
          .stagedPaths(workspaceRoot)
          .filter((p) => !stagedBefore.includes(p));
        git.unstage(added, workspaceRoot);
      }
    } catch (err) {
      vscode.window.showWarningMessage(
        `Smart Commit: Cancelled, but the index could not be restored — ${err}`,
      );
    }
  };

  let staged: string[];

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Smart Commit", cancellable: false },
      async (progress) => {
        progress.report({ message: "Staging workspace files…" });
        git.stageAll(workspaceRoot);
      },
    );

    // Outsiders can be staged only through an unusual worktree overlap. Belt
    // and braces, and now with the -- separator so a path beginning with a
    // dash is a path.
    git.unstage(outsiders, workspaceRoot);

    staged = git.stagedPaths(workspaceRoot);
  } catch (err) {
    restore();
    vscode.window.showErrorMessage(`Smart Commit: Failed to stage files — ${err}`);
    return;
  }

  const added = staged.filter((p) => !stagedBefore.includes(p));

  if (staged.length === 0) {
    vscode.window.showInformationMessage("Smart Commit: Nothing to commit — workspace is clean.");
    return;
  }

  if (!(await confirmSensitiveFiles(added.length > 0 ? added : staged))) {
    restore();
    vscode.window.showInformationMessage("Smart Commit: Cancelled.");
    return;
  }

  const defaultMessage = buildDefaultMessage(template, staged.length);
  let commitMessage = defaultMessage;

  if (promptForMessage) {
    const entered = await vscode.window.showInputBox({
      // The names, not just the count: this is the last point at which
      // anything can be stopped.
      prompt: `Committing ${staged.length} file(s): ${summariseFiles(staged, 6)}`,
      value: defaultMessage,
      ignoreFocusOut: true,
      placeHolder: defaultMessage,
    });

    if (entered === undefined) {
      restore();
      vscode.window.showInformationMessage("Smart Commit: Cancelled.");
      return;
    }

    if (entered.trim() !== "") commitMessage = entered;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Smart Commit", cancellable: false },
      async (progress) => {
        progress.report({ message: "Committing…" });
        git.commit(commitMessage, workspaceRoot);
      },
    );
  } catch (err) {
    if (git.isMissingIdentity(err)) {
      vscode.window.showErrorMessage(
        "Smart Commit: Git identity not configured. " +
          "Set smartCommit.gitUserName and smartCommit.gitUserEmail in settings, " +
          "or run: git config --global user.email 'you@example.com'",
      );
    } else {
      vscode.window.showErrorMessage(`Smart Commit: Commit failed — ${err}`);
    }
    return;
  }

  vscode.window.showInformationMessage(
    `Smart Commit ✓ [${git.shortHead(workspaceRoot)}] ` +
      `${staged.length} file(s) committed — "${truncate(commitMessage)}"`,
  );
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("smart-commit.saveAndCommit", saveAndCommit),
  );
}

export function deactivate(): void {}
