# Smart Commit

Save every file in the workspace and commit it, in one keystroke.

`Ctrl+Alt+S`. That is the whole extension.

---

## What it is for

Some work does not deserve a considered commit. Notes, a scratch repository, a
day of small edits to a personal project — the value is in having a history at
all, not in curating it. Doing that by hand is four commands and a context
switch, so it does not happen, and the history is worse for it.

So: one shortcut that saves, stages, asks for a message, and commits.

The care in it is all in what it refuses to do.

- **It will not commit files that are not yours to commit.** VS Code will
  happily have `/etc/hosts` or a file from another project open in the same
  window. Those are detected and kept out of the index.
- **It will not destroy a commit you were already building.** If you had staged
  things by hand and you press Escape, the index goes back exactly as it was —
  including the staged content of files you have edited again since.
- **It will not create a repository without asking.** `git init` in the wrong
  folder, followed by `git add .`, is a mess to undo.
- **It will not quietly commit something that looks like a credential.** The
  confirmation names the files rather than counting them, and stops on
  anything that looks like a key or an environment file.
- **It will not run a shell.** Nothing you or a workspace can type becomes part
  of a command line. See [Safety](#safety).

---

## Shortcut

| Platform        | Shortcut         |
| --------------- | ---------------- |
| Windows / Linux | `Ctrl + Alt + S` |
| macOS           | `Ctrl + Alt + S` |

Rebind via **File → Preferences → Keyboard Shortcuts**, searching
`smart-commit`. It is also in the Command Palette as
**Smart Commit: Save & Commit Workspace**.

---

## What happens when you press it

```
Ctrl+Alt+S
  → saves every dirty editor belonging to the workspace
  → if this is not a repository, asks before running git init
  → git add .
  → unstages anything open from outside the workspace
  → if anything staged looks like a credential, asks
  → input box, pre-filled, naming the files being committed
  → git commit
  → ✓ [a3f9c12] 5 file(s) committed — "chore: auto-commit 2026-09-05 14:32"
```

Escape at any prompt cancels, and puts the index back the way it was.

---

## Configuration

All settings are under `smartCommit.*` (`Ctrl+,`).

| Setting                             | Default                            | Description                                                                    |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `smartCommit.commitMessageTemplate` | `chore: auto-commit {date} {time}` | Default message. `{date}`, `{time}` and `{files}` are replaced everywhere they appear |
| `smartCommit.promptForMessage`      | `true`                             | Show the input box. `false` commits with the template, and skips the last chance to stop |
| `smartCommit.gitUserName`           | `""`                               | Fallback `user.name`, used only when git has none configured at any level      |
| `smartCommit.gitUserEmail`          | `""`                               | Fallback `user.email`, same                                                    |

The identity settings are a fallback, never an override: if git already knows
who you are, globally or for this repository, they are ignored.

```json
{
  "smartCommit.commitMessageTemplate": "auto: {files} files · {date} {time}",
  "smartCommit.promptForMessage": false,
  "smartCommit.gitUserName": "Your Name",
  "smartCommit.gitUserEmail": "you@example.com"
}
```

---

## How it decides what belongs to the workspace

VS Code's `TabGroups` API lists every open editor tab. For each one the
extension resolves symlinks (`fs.realpathSync`) and compares the result against
the real path of the workspace root. Anything that is not the root or beneath
it is an **outsider**, and is unstaged after `git add .` in case an unusual
worktree overlap picked it up.

The comparison includes the path separator, which is not a detail:
`/home/me/project-notes` starts with `/home/me/project`, and without the
separator a whole neighbouring directory would count as inside your workspace.
On Windows the comparison ignores case, as the filesystem does.

---

## Safety

Every git call goes through one function, and that function uses
`execFileSync` with an argument array — the process is started directly and no
shell is involved.

This matters more than it might look. The extension previously built command
strings:

```ts
exec(`git config user.name "${name}"`, cwd);
exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
```

`name` comes from `smartCommit.gitUserName`, and VS Code resolves settings from
the workspace. A repository could ship a `.vscode/settings.json` putting
anything it liked in that field, so cloning someone else's project and pressing
`Ctrl+Alt+S` ran their code with your privileges. The commit message had the
same shape: backslash-escaping quotes is not how `cmd.exe` works and does
nothing about `&`, `|`, `^` or `%VAR%`, so a message as ordinary as
`fix login & deploy` ran `deploy` as a second command.

With an argument array there is nothing to escape, because nothing is ever
parsed. `tests/git.test.js` pushes shell metacharacters through both paths and
checks they are stored and committed as literal text.

---

## Development

```bash
git clone https://github.com/nishantmajhi/smart-commit.git
cd smart-commit
npm install
npm test          # compiles, then runs the tests
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded. `npm run watch` keeps TypeScript compiling in the background.

The tests use Node's own test runner — no framework to install — and run
against real repositories created in the temporary directory. They never touch
your own.

```
smart-commit/
├── src/
│   ├── extension.ts     VS Code plumbing: prompts, notifications, progress
│   ├── git.ts           Every git invocation, and nothing else spawns anything
│   └── workspace.ts     What belongs to the workspace; message and file-name rules
├── tests/
│   ├── git.test.js      Against real repositories in a temp directory
│   └── workspace.test.js
├── .vscode/             F5 debug config and build task
├── package.json         Manifest, keybinding, settings
└── tsconfig.json
```

`src/git.ts` and `src/workspace.ts` import no editor API. That is what lets the
tests run them under plain Node, and it keeps the decisions separable from the
plumbing that feeds them. `out/` is generated and not committed.

---

## Installation

### From source

```bash
npm install
npm run compile
```

Open the folder in VS Code and press `F5`.

### As a `.vsix`

```bash
npm install -g @vscode/vsce
vsce package        # produces smart-commit-1.0.0.vsix
```

Install it **from inside VS Code**:

- **Command Palette** — `Ctrl+Shift+P` → `Install from VSIX` → **Extensions:
  Install from VSIX…**
- **Extensions panel** — `Ctrl+Shift+X`, then the `···` menu → **Install from
  VSIX…**
- **Command line** — `code --install-extension smart-commit-1.0.0.vsix`

> ⚠️ **Windows:** double-clicking a `.vsix` sometimes opens the Visual Studio
> Installer instead of VS Code — different products, similar name. You will see
> `NoApplicableSKUsException: One or more extensions are for Visual Studio
> Code.` Use the Command Palette method instead.

---

## Requirements

- VS Code `1.85+`
- `git` on your `PATH`
- Node.js `18+` to build or test

---

## Known limits

- `git add .` stages everything not gitignored. The credential check is a
  match on filenames and will miss a secret in a file that is not named like
  one. Read the list in the confirmation.
- With `promptForMessage` set to `false` there is no confirmation at all, so
  the credential warning is the only thing that can stop a commit.
- Merge conflicts: the exact index snapshot uses `git write-tree`, which
  refuses during a merge. Cancelling then falls back to unstaging only what
  this command added, which leaves your own staged work in place but does not
  restore the previous *content* of a file staged twice.

---

## License

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
