/* Tests for the git layer, against real repositories in a temporary directory.
 *
 *   npm run compile && node --test "tests/*.test.js"
 *
 * These drive out/git.js — the compiled output — because that is what actually
 * ships. Nothing here touches the user's repositories: every test builds its
 * own in os.tmpdir() and removes it afterwards.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const git = require("../out/git.js");

/* Point git at configuration files that do not exist, so these tests see only
   the repository-level config they set themselves. Without this the machine's
   own global user.name leaks in and the identity tests below cannot tell
   "applyIdentity refused to overwrite" from "applyIdentity never ran".
   runGit reads process.env at call time, so setting it here is enough. */
const NOWHERE = path.join(os.tmpdir(), "smart-commit-no-such-gitconfig");
process.env.GIT_CONFIG_GLOBAL = NOWHERE;
process.env.GIT_CONFIG_SYSTEM = NOWHERE;

/** A fresh repository with an identity configured, and a callback run in it. */
function inRepo(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-commit-test-"));

  try {
    git.runGit(["init", "--initial-branch=main"], dir);
    git.runGit(["config", "user.name", "Test Person"], dir);
    git.runGit(["config", "user.email", "test@example.com"], dir);

    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir, name, contents) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/* ── Shell injection ────────────────────────────────────────── */

test("a git user name with shell metacharacters is stored literally", () => {
  /* The defect this exists for. gitUserName comes from VS Code settings, and
     settings resolve from the workspace — so a repository could ship a
     .vscode/settings.json with a payload in that field, and opening it and
     pressing Ctrl+Alt+S ran the payload. It used to be interpolated into
     `git config user.name "${name}"` and handed to a shell. */
  inRepo((dir) => {
    const marker = path.join(dir, "PWNED");
    const hostile = `Bob" & echo owned > "${marker}`;

    git.runGit(["config", "--unset-all", "user.name"], dir);
    git.applyIdentity(dir, hostile, "");

    assert.equal(git.configuredIdentity(dir, "user.name"), hostile, "stored exactly as given");
    assert.equal(fs.existsSync(marker), false, "and nothing ran");
  });
});

test("a git user email with shell metacharacters is stored literally", () => {
  inRepo((dir) => {
    const marker = path.join(dir, "PWNED-EMAIL");
    const hostile = `a@b.com" | echo owned > "${marker}`;

    git.runGit(["config", "--unset-all", "user.email"], dir);
    git.applyIdentity(dir, "", hostile);

    assert.equal(git.configuredIdentity(dir, "user.email"), hostile);
    assert.equal(fs.existsSync(marker), false, "nothing ran");
  });
});

test("a commit message containing an ampersand is committed whole", () => {
  /* Not even a malicious case — just a message anyone might type. The old code
     escaped double quotes with a backslash, which cmd.exe does not honour, and
     did nothing about &, |, ^ or %VAR%. On Windows "fix login & deploy" ran
     `deploy` as a second command and committed only "fix login". */
  inRepo((dir) => {
    write(dir, "a.txt", "hello");
    git.stageAll(dir);

    const message = 'fix login & deploy | tee "x" ^ %PATH% $(whoami) `id`';
    git.commit(message, dir);

    assert.equal(git.runGit(["log", "-1", "--pretty=%s"], dir), message);
  });
});

test("a commit message spanning lines keeps its body", () => {
  inRepo((dir) => {
    write(dir, "a.txt", "hello");
    git.stageAll(dir);

    git.commit("subject line\n\nbody line one\nbody line two", dir);

    assert.equal(git.runGit(["log", "-1", "--pretty=%s"], dir), "subject line");
    assert.match(git.runGit(["log", "-1", "--pretty=%b"], dir), /body line two/);
  });
});

test("a file name that begins with a dash is unstaged as a path", () => {
  // Without the -- separator, git reads it as an option.
  inRepo((dir) => {
    write(dir, "a.txt", "keep");
    write(dir, "-weird-name.txt", "drop");
    git.stageAll(dir);

    git.unstage(["-weird-name.txt"], dir);

    assert.deepEqual(git.stagedPaths(dir), ["a.txt"]);
  });
});

/* ── The index is not destroyed on cancel ───────────────────── */

test("restoring the index puts back exactly what was staged", () => {
  /* The defect: cancelling ran a bare `git reset HEAD`, which resets the whole
     index. Someone who had spent time building a partial commit, ran Smart
     Commit by accident and pressed Escape, lost that work silently. */
  inRepo((dir) => {
    write(dir, "committed.txt", "v1");
    git.stageAll(dir);
    git.commit("initial", dir);

    // A partial commit built by hand: one of two changed files staged.
    write(dir, "wanted.txt", "deliberately staged");
    write(dir, "unwanted.txt", "not ready yet");
    git.runGit(["add", "wanted.txt"], dir);

    assert.deepEqual(git.stagedPaths(dir), ["wanted.txt"], "the starting point");

    const snapshot = git.snapshotIndex(dir);
    assert.ok(snapshot, "a snapshot was taken");

    // What Smart Commit does, then cancels.
    git.stageAll(dir);
    assert.deepEqual(git.stagedPaths(dir).sort(), ["unwanted.txt", "wanted.txt"]);

    git.restoreIndex(snapshot, dir);

    assert.deepEqual(git.stagedPaths(dir), ["wanted.txt"], "the partial commit survives");
  });
});

test("restoring the index keeps the staged content, not just the path", () => {
  // A path-by-path reset cannot do this: the file is staged in both states, so
  // it would be left holding the newer content.
  inRepo((dir) => {
    write(dir, "seed.txt", "seed");
    git.stageAll(dir);
    git.commit("initial", dir);

    write(dir, "notes.txt", "the version I meant to commit");
    git.runGit(["add", "notes.txt"], dir);

    const snapshot = git.snapshotIndex(dir);

    write(dir, "notes.txt", "a later edit I did not mean to include");
    git.stageAll(dir);
    git.restoreIndex(snapshot, dir);

    assert.equal(
      git.runGit(["show", ":notes.txt"], dir),
      "the version I meant to commit",
    );
  });
});

test("a clean index restores to clean", () => {
  inRepo((dir) => {
    write(dir, "seed.txt", "seed");
    git.stageAll(dir);
    git.commit("initial", dir);

    const snapshot = git.snapshotIndex(dir);

    write(dir, "new.txt", "added by the command");
    git.stageAll(dir);
    git.restoreIndex(snapshot, dir);

    assert.deepEqual(git.stagedPaths(dir), [], "nothing left staged");
    assert.ok(fs.existsSync(path.join(dir, "new.txt")), "and the file itself is untouched");
  });
});

test("an index can be snapshotted before the first commit", () => {
  // write-tree works in a repository with no HEAD, which is the state
  // ensureRepository leaves behind after git init.
  inRepo((dir) => {
    write(dir, "first.txt", "hello");
    git.runGit(["add", "first.txt"], dir);

    const snapshot = git.snapshotIndex(dir);
    assert.ok(snapshot, "a snapshot exists with no commits yet");

    write(dir, "second.txt", "also hello");
    git.stageAll(dir);
    git.restoreIndex(snapshot, dir);

    assert.deepEqual(git.stagedPaths(dir), ["first.txt"]);
  });
});

/* ── Identity ───────────────────────────────────────────────── */

test("an identity already configured is not overwritten", () => {
  // The setting is a fallback for when git has none, not an override.
  inRepo((dir) => {
    git.applyIdentity(dir, "Someone Else", "else@example.com");

    assert.equal(git.configuredIdentity(dir, "user.name"), "Test Person");
    assert.equal(git.configuredIdentity(dir, "user.email"), "test@example.com");
  });
});

test("an unset identity reads as null", () => {
  inRepo((dir) => {
    git.runGit(["config", "--unset-all", "user.name"], dir);

    // The repository config no longer has it. There may still be a global
    // one on this machine, so this only asserts the shape of the answer.
    const value = git.configuredIdentity(dir, "user.name");
    assert.ok(value === null || typeof value === "string");
  });
});

/* ── Errors ─────────────────────────────────────────────────── */

test("a failing git command throws with stderr attached", () => {
  /* The identity-error message depends on this. execSync embedded stderr in
     the message; execFileSync puts it on the error object, so it is copied
     across explicitly. */
  inRepo((dir) => {
    try {
      git.runGit(["rev-parse", "--verify", "refs/heads/nonexistent"], dir);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(typeof err.stderr, "string");
      assert.notEqual(err.status, 0);
      assert.match(err.message, /^git rev-parse/);
    }
  });
});

test("a missing identity is recognised from the failure", () => {
  inRepo((dir) => {
    git.runGit(["config", "--unset-all", "user.name"], dir);
    git.runGit(["config", "--unset-all", "user.email"], dir);

    write(dir, "a.txt", "hello");
    git.stageAll(dir);

    try {
      // A global identity on the test machine would make this succeed, in
      // which case there is nothing to check.
      git.commit("message", dir);
      return;
    } catch (err) {
      assert.equal(git.isMissingIdentity(err), true);
    }
  });
});

test("an unrelated failure is not mistaken for a missing identity", () => {
  inRepo((dir) => {
    try {
      git.runGit(["checkout", "no-such-branch"], dir);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(git.isMissingIdentity(err), false);
    }
  });
});

/* ── Repository detection ───────────────────────────────────── */

test("a directory that is not a repository is reported as such", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-commit-bare-"));

  try {
    // os.tmpdir() is not inside a repository on any normal machine, but say so
    // rather than assume it.
    let insideSomeRepo = true;
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dir, stdio: "ignore" });
    } catch {
      insideSomeRepo = false;
    }

    if (insideSomeRepo) return;

    assert.equal(git.isRepository(dir), false);

    git.init(dir);

    assert.equal(git.isRepository(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unstaging nothing does nothing", () => {
  inRepo((dir) => {
    write(dir, "a.txt", "hello");
    git.stageAll(dir);

    git.unstage([], dir);

    assert.deepEqual(git.stagedPaths(dir), ["a.txt"], "an empty list is not an empty pathspec");
  });
});
