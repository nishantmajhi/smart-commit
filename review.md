# Code Review — Smart Commit

First reviewed 2026-09-04. Remediated 2026-09-05 on branch `cleanup/2026-09-05`.

## Verdict

The original review's judgement holds: the idea is well thought out, the
outsider-file handling is a genuinely thoughtful detail most people would not
think to add, and the care shows in the progress reporting, the multi-root
picker and the specific message for a missing git identity.

And it was a remote code execution vector. Everything in this pass is either
that or a consequence of it.

## Fixed

**Shell injection, reachable from a repository's own `.vscode/settings.json`.**
`applyGitIdentity` built `git config user.name "${name}"` and handed it to
`execSync`, which runs through `cmd.exe` on Windows and `/bin/sh` elsewhere.
`name` comes from `smartCommit.gitUserName`, and VS Code resolves settings from
the workspace — so a repository could ship a settings file with a payload in
that field, and cloning it and pressing `Ctrl+Alt+S` ran the payload with your
privileges.

Verified rather than assumed: running the original line against a temporary
repository with `Bob" & echo owned > "<path>` as the name creates the file.

The commit message had the same shape. `message.replace(/"/g, '\\"')` is not
how `cmd.exe` escapes anything and does nothing whatever about `&`, `|`, `^` or
`%VAR%`, so `fix login & deploy` ran `deploy` as a second command and committed
only the first half. This one needed no attacker at all.

Every git call now goes through `runGit` in `src/git.ts`, which uses
`execFileSync` with an argument array. No shell, nothing to escape, and the
class of bug is gone rather than the instances of it patched.
`tests/git.test.js` pushes metacharacters through both paths and asserts they
survive as literal text.

**Cancelling destroyed a partial commit.** Escape ran a bare `git reset HEAD`,
which resets the *entire* index — not just what this command staged. Someone
who had spent time building a partial commit by hand and ran Smart Commit by
accident lost that work with no warning.

The index is now snapshotted with `git write-tree` before staging and restored
with `git read-tree` on cancel, which puts back the exact index — including the
staged *content* of a file that was also edited afterwards, which a
path-by-path reset cannot do. `write-tree` refuses during a merge, so there is
a fallback that unstages only what this command added; the README says so.

**`git init` ran silently.** In a folder that was not meant to be a repository
— Downloads, a scratch directory — that plus `git add .` two steps later made a
repository and staged everything in it. It asks now, modally.

**`git add .` staged credentials with no warning.** The confirmation showed a
count, not names. It shows the names now, and stops with a modal warning on
anything matching `.env`, `id_rsa`, `*.pem`, `*.key`, `*.sqlite`,
`client_config.json`, `.ssh/`, `.aws/` and similar. This is a heuristic and
always will be — the point is to make you look, not to decide for you.

**`git reset HEAD -- "${outsider}"` interpolated a path.** A path with a quote
or a space in it broke, and one beginning with a dash was read as an option.
Arguments now, with an explicit `--` separator.

**A placeholder used twice in the message template was only replaced once.**
`String.replace` with a string pattern replaces the first occurrence, so
`{files} of {files}` left the second as literal text.

**Cleanup.** `out/` was committed and is now gitignored and untracked — a
compiled copy of `src/` in the repository drifts from it and produces a diff on
every recompile. The stray `smart-commit-1.0.0.vsix` in the working tree is
deleted; rebuild it with `vsce package`. The duplicate `console.log` is gone.
`applyGitIdentity`'s try/catch-as-conditional is now
`configuredIdentity() === null`, which says what it means. The success
notification truncates the message. There is a `LICENSE`, in the name Manish
Majhi — taken from the author section of `C/LexiGone`'s README rather than
guessed from the GitHub handle.

## Tests

`npm test` — compiles, then `node --test "tests/*.test.js"`. 37 tests, no
framework installed.

`tests/git.test.js` runs against real repositories created in the temporary
directory, never against yours. It points `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` at a path that does not exist, so the machine's own
identity cannot leak in and make an identity test pass for the wrong reason.

## Still open

**There is still no test of `extension.ts` itself,** because testing it means
running inside VS Code (`@vscode/test-electron`). What the split achieved is
that every *decision* is in `git.ts` or `workspace.ts` and is covered; what is
left in `extension.ts` is prompts, notifications and the order things happen
in. That is the part worth exercising by hand with `F5`.

**`promptForMessage: false` skips the last chance to stop.** The credential
warning still fires, but nothing else does. Reasonable for the setting's
purpose; worth knowing.

**The keybinding's `when` clause is `editorTextFocus || !editorFocus`,** which
is close to unconditional and could collide with something. Left alone as a
user-facing choice.

## Notes for a future session

`src/git.ts` is the only thing in the extension that spawns a process. Keep it
that way: if a new git call is needed, add a function there rather than
reaching for `child_process` at the call site. That single rule is what makes
the injection fix hold.

Do not change `runGit`'s `LC_ALL=C`. `isMissingIdentity` matches on git's own
stderr text, and a localised git would break the specific, useful error message
that the original author wrote.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same, and `package.json`
declares `SEE LICENSE IN LICENSE`, npm's form for a licence with no SPDX
identifier. Anything above that calls the licence an open question, or calls
the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs `npm test` (tsc, then the suite) on
`ubuntu-latest`. Nothing has been pushed, so it has not run on GitHub yet.
Every job was run before committing, from a fresh clone of this branch, the
way a runner would run it: Linux jobs in a throwaway Ubuntu 24.04 (the image
`ubuntu-latest` uses) with the same tool versions. 37.
