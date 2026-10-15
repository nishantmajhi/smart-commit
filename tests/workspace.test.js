/* Tests for the decisions the command makes: what belongs to the workspace,
 * what the default message says, and which filenames deserve a second look.
 *
 *   npm run compile && node --test "tests/*.test.js"
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildDefaultMessage,
  isInside,
  outsidersOf,
  sensitivePaths,
  summariseFiles,
  truncate,
} = require("../out/workspace.js");

/** A path in the platform's own separators, so these read the same anywhere. */
const p = (...parts) => path.join(...parts);

/* ── Which files belong to the workspace ────────────────────── */

test("a file inside the workspace is inside it", () => {
  const root = p("home", "me", "project");

  assert.equal(isInside(p("home", "me", "project", "src", "a.ts"), root), true);
  assert.equal(isInside(p("home", "me", "project", "a.ts"), root), true);
  assert.equal(isInside(root, root), true, "the root itself");
});

test("a sibling directory with the root as a name prefix is not inside it", () => {
  /* The reason isInside exists rather than a plain startsWith. Without the
     separator, /home/me/project-notes counts as inside /home/me/project, and
     its open files would be treated as workspace files. */
  const root = p("home", "me", "project");

  assert.equal(isInside(p("home", "me", "project-notes", "a.md"), root), false);
  assert.equal(isInside(p("home", "me", "projectx"), root), false);
});

test("a file outside the workspace is outside it", () => {
  const root = p("home", "me", "project");

  assert.equal(isInside(p("home", "me", "other", "a.ts"), root), false);
  assert.equal(isInside(p("etc", "passwd"), root), false);
  assert.equal(isInside(p("home", "me"), root), false, "the parent is not inside the child");
});

test("a trailing separator on the root does not change the answer", () => {
  const root = p("home", "me", "project") + path.sep;

  assert.equal(isInside(p("home", "me", "project", "a.ts"), root), true);
  assert.equal(isInside(p("home", "me", "project-notes", "a.md"), root), false);
});

test("open files are split into insiders and outsiders", () => {
  const root = p("home", "me", "project");

  const outsiders = outsidersOf(
    [
      p("home", "me", "project", "src", "a.ts"),
      p("home", "me", "notes.md"),
      p("home", "me", "project-notes", "b.md"),
      p("home", "me", "project", "README.md"),
    ],
    root,
  );

  assert.equal(outsiders.length, 2);
  assert.ok(outsiders.some((f) => f.endsWith("notes.md")));
  assert.ok(outsiders.some((f) => f.endsWith("b.md")));
});

test("the same outsider open in two tabs is listed once", () => {
  const root = p("home", "me", "project");
  const stray = p("home", "me", "notes.md");

  assert.equal(outsidersOf([stray, stray], root).length, 1);
});

test("no open files means no outsiders", () => {
  assert.deepEqual(outsidersOf([], p("home", "me", "project")), []);
});

/* ── The default commit message ─────────────────────────────── */

test("the template placeholders are filled in", () => {
  const when = new Date("2026-09-05T14:30:00Z");

  const message = buildDefaultMessage("chore: auto-commit {date} ({files} files)", 7, when);

  assert.match(message, /^chore: auto-commit 2026-09-05 \(7 files\)$/);
});

test("a placeholder used more than once is replaced every time", () => {
  // String.replace with a string pattern replaces only the first occurrence,
  // so "{files} of {files}" used to leave the second one as literal text.
  const message = buildDefaultMessage("{files} file(s), {files} again", 3, new Date());

  assert.equal(message, "3 file(s), 3 again");
});

test("a template with no placeholders is left alone", () => {
  assert.equal(buildDefaultMessage("wip", 4, new Date()), "wip");
});

test("the time placeholder is filled with a time", () => {
  assert.match(buildDefaultMessage("{time}", 1, new Date()), /^\d{2}:\d{2}$/);
});

/* ── Files that look like credentials ───────────────────────── */

test("credential-shaped filenames are flagged", () => {
  /* `git add .` stages everything not gitignored, and the confirmation used to
     show only a count. This is a heuristic and always will be — the point is
     to make the user look, not to decide for them. */
  const flagged = sensitivePaths([
    "src/index.ts",
    ".env",
    ".env.local",
    "config/secrets.yml",
    "deploy/id_rsa",
    "certs/server.pem",
    "certs/server.key",
    "db/app.sqlite",
    "client_config.json",
    ".ssh/config",
    "README.md",
  ]);

  assert.deepEqual(flagged.sort(), [
    ".env",
    ".env.local",
    ".ssh/config",
    "certs/server.key",
    "certs/server.pem",
    "client_config.json",
    "config/secrets.yml",
    "db/app.sqlite",
    "deploy/id_rsa",
  ]);
});

test("ordinary source files are not flagged", () => {
  assert.deepEqual(
    sensitivePaths([
      "src/extension.ts",
      "package.json",
      "docs/environment.md",
      "test/keyboard.test.js",
      "images/icon.png",
    ]),
    [],
    "environment.md and keyboard.test.js are near misses that must not match",
  );
});

test("windows-style separators are recognised", () => {
  assert.deepEqual(sensitivePaths(["config\\.env"]), ["config\\.env"]);
});

test("nothing staged means nothing flagged", () => {
  assert.deepEqual(sensitivePaths([]), []);
});

/* ── Presenting things to the user ──────────────────────────── */

test("a short file list is shown in full", () => {
  assert.equal(summariseFiles(["a.ts", "b.ts"]), "a.ts, b.ts");
});

test("a long file list is cut off and counted", () => {
  const files = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);

  const summary = summariseFiles(files, 3);

  assert.equal(summary, "file0.ts, file1.ts, file2.ts and 22 more");
});

test("a list exactly at the limit is not truncated", () => {
  assert.equal(summariseFiles(["a", "b", "c"], 3), "a, b, c");
});

test("a long commit message is shortened for the notification", () => {
  const long = "x".repeat(200);

  const shown = truncate(long);

  assert.equal(shown.length, 72);
  assert.ok(shown.endsWith("…"));
});

test("a multi-line commit message becomes one line", () => {
  assert.equal(truncate("subject\n\nbody"), "subject  body");
});

test("a short message is left exactly as it is", () => {
  assert.equal(truncate("fix: the thing"), "fix: the thing");
});
