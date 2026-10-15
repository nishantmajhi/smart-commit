import { execFileSync } from "child_process";

/**
 * Running git.
 *
 * Every call in this extension used to go through execSync with an
 * interpolated string:
 *
 *     exec(`git config user.name "${name}"`, cwd);
 *     exec(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, cwd);
 *
 * execSync runs the string through cmd.exe on Windows and /bin/sh elsewhere,
 * so every one of those was a shell injection. Two of them were reachable
 * without any effort at all:
 *
 *   - `name` comes from config.get("gitUserName"), and VS Code resolves
 *     settings from the workspace. A repository can ship a
 *     .vscode/settings.json setting smartCommit.gitUserName to anything it
 *     likes. Opening someone else's repository and pressing Ctrl+Alt+S ran
 *     their payload with your privileges.
 *   - The commit message. Backslash-escaping double quotes is not how cmd.exe
 *     works, and it does nothing whatever about &, |, ^ or %VAR%. A perfectly
 *     innocent "fix login & deploy" ran `deploy` as a second command.
 *
 * execFileSync takes an argument array and starts the process directly. No
 * shell is involved, so there is nothing to escape and no metacharacter means
 * anything. That removes the class of bug rather than patching instances of
 * it, which is why every function here goes through runGit and why runGit is
 * the only thing in the extension that spawns anything.
 */

export interface GitFailure extends Error {
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Run git with the given arguments. Throws a GitFailure on a non-zero exit. */
export function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      // Keep git's output in English so the identity-error detection below
      // does not depend on the user's locale.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
  } catch (raw) {
    const err = raw as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };

    const failure = new Error(
      `git ${args.join(" ")} failed: ${String(err.stderr ?? err.message).trim()}`,
    ) as GitFailure;

    failure.status = err.status ?? null;
    failure.stderr = String(err.stderr ?? "");
    failure.stdout = String(err.stdout ?? "");

    throw failure;
  }
}

/** Does cwd sit inside a git working tree? */
export function isRepository(cwd: string): boolean {
  try {
    runGit(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function init(cwd: string): void {
  runGit(["init"], cwd);
}

/**
 * The configured value of a git identity field, or null when it is unset at
 * every level.
 *
 * `git config <key>` exits 1 when the key is absent, which is what the
 * original code used as its test — correct, but written as a try/catch around
 * a call whose return value was thrown away, which reads like a mistake.
 */
export function configuredIdentity(cwd: string, key: "user.name" | "user.email"): string | null {
  try {
    const value = runGit(["config", key], cwd);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Set the identity fields that the settings supply and git does not already
 * have. An identity already configured — globally or for this repository — is
 * never overwritten.
 */
export function applyIdentity(cwd: string, name: string, email: string): void {
  if (name && configuredIdentity(cwd, "user.name") === null) {
    runGit(["config", "user.name", name], cwd);
  }

  if (email && configuredIdentity(cwd, "user.email") === null) {
    runGit(["config", "user.email", email], cwd);
  }
}

/** Paths currently staged, relative to the repository root. */
export function stagedPaths(cwd: string): string[] {
  const output = runGit(["diff", "--cached", "--name-only"], cwd);

  return output === "" ? [] : output.split("\n").filter(Boolean);
}

export function stageAll(cwd: string): void {
  runGit(["add", "."], cwd);
}

/**
 * Unstage specific paths.
 *
 * The `--` separator matters: without it a path that begins with a dash, or
 * one that happens to match a branch name, is read as an option or a revision.
 */
export function unstage(paths: string[], cwd: string): void {
  if (paths.length === 0) return;

  runGit(["reset", "--quiet", "HEAD", "--", ...paths], cwd);
}

/**
 * A snapshot of the current index, as a tree object id, or null if one cannot
 * be taken.
 *
 * This is how a cancelled commit puts things back. The original ran a bare
 * `git reset HEAD`, which resets the *entire* index — including whatever the
 * user had staged before running the command. Someone building a partial
 * commit by hand, who ran Smart Commit by accident and pressed Escape, lost
 * that work with no warning and no way back.
 *
 * write-tree/read-tree restores the index exactly, including the staged
 * content of files that were also modified again afterwards, which a
 * path-by-path reset cannot do. It fails while a merge is in progress, which
 * is why the caller has a fallback.
 */
export function snapshotIndex(cwd: string): string | null {
  try {
    return runGit(["write-tree"], cwd);
  } catch {
    return null;
  }
}

export function restoreIndex(tree: string, cwd: string): void {
  runGit(["read-tree", tree], cwd);
}

export function commit(message: string, cwd: string): void {
  runGit(["commit", "-m", message], cwd);
}

export function shortHead(cwd: string): string {
  try {
    return runGit(["rev-parse", "--short", "HEAD"], cwd);
  } catch {
    return "";
  }
}

/**
 * Does this failure mean git has no identity to commit as?
 *
 * git says so on stderr, which execFileSync puts on the error object rather
 * than in its message — hence GitFailure carrying it explicitly.
 */
export function isMissingIdentity(err: unknown): boolean {
  const failure = err as Partial<GitFailure>;
  const text = `${failure?.stderr ?? ""} ${failure?.message ?? String(err)}`;

  return text.includes("user.email") || text.includes("user.name");
}
