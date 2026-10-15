import * as path from "path";
import * as fs from "fs";

/**
 * Deciding what belongs to the workspace, what a commit message says, and
 * which filenames deserve a second look before being committed.
 *
 * Nothing here imports vscode. That is deliberate: it is what lets
 * tests/workspace.test.js run these under plain Node, and it keeps the rules
 * separable from the plumbing that feeds them.
 */

/** Resolve symlinks and normalise a path so two of them can be compared. */
export function realNorm(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(p);
  }
}

/**
 * Is `candidate` the directory `root`, or something inside it?
 *
 * The separator is not decoration. A plain startsWith(root) says that
 * /home/me/project-notes is inside /home/me/project, and the file would then
 * be staged from a workspace it does not belong to.
 */
export function isInside(candidate: string, root: string): boolean {
  const a = path.normalize(candidate);
  const b = path.normalize(root);

  if (a === b) return true;

  const prefix = b.endsWith(path.sep) ? b : b + path.sep;

  // Windows paths are compared without regard to case, as the filesystem is.
  return process.platform === "win32"
    ? a.toLowerCase().startsWith(prefix.toLowerCase())
    : a.startsWith(prefix);
}

/**
 * Of the given open files, those that live outside the workspace.
 *
 * Takes plain paths rather than editor tabs so it can be tested. The extension
 * passes the paths of open text editors; these are the ones it must not stage.
 */
export function outsidersOf(openFiles: string[], workspaceRoot: string): string[] {
  const root = realNorm(workspaceRoot);
  const outside = new Set<string>();

  for (const file of openFiles) {
    const resolved = realNorm(file);

    if (!isInside(resolved, root)) {
      outside.add(resolved);
    }
  }

  return [...outside];
}

/** Build the default commit message from the configured template. */
export function buildDefaultMessage(
  template: string,
  stagedCount: number,
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5);

  // Replaces every occurrence, not just the first: "{files} files at {time}
  // ({files})" used to leave the second one as literal text.
  return template
    .split("{date}")
    .join(date)
    .split("{time}")
    .join(time)
    .split("{files}")
    .join(String(stagedCount));
}

/**
 * Filenames that look like credentials.
 *
 * `git add .` stages everything that is not gitignored, and the confirmation
 * used to show only a count — so a .env or a private key that nobody had
 * thought to ignore went into a commit in one keystroke, and on this project's
 * own author's account, into a public repository. Matching by name is a
 * heuristic and always will be; the point is to make the user look, not to
 * decide for them.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.?(npmrc|netrc|pgpass)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|pfx|p12|keystore|jks|ppk)$/i,
  /(^|\/).*(secret|credential|password)s?[^/]*$/i,
  /(^|\/)(service-account|serviceaccount|client_config|credentials)\.json$/i,
  /\.(sqlite3?|db|mdb)$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
];

/** Those of the given repository-relative paths that look like credentials. */
export function sensitivePaths(paths: string[]): string[] {
  const normalised = (p: string) => p.split("\\").join("/");

  return paths.filter((p) => SENSITIVE_PATTERNS.some((r) => r.test(normalised(p))));
}

/**
 * A file list short enough for a notification, with the remainder counted.
 *
 * Showing the names rather than a bare count is the whole point of the
 * confirmation, but a thousand of them is not something anyone reads.
 */
export function summariseFiles(paths: string[], limit = 10): string {
  if (paths.length <= limit) return paths.join(", ");

  const shown = paths.slice(0, limit).join(", ");

  return `${shown} and ${paths.length - limit} more`;
}

/** Shorten a commit message so a success toast stays readable. */
export function truncate(text: string, limit = 72): string {
  const oneLine = text.split(/\r?\n/).join(" ").trim();

  return oneLine.length <= limit ? oneLine : oneLine.slice(0, limit - 1) + "…";
}
