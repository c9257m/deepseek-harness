# Agent Note: Web git change marks in the file viewer

Status: implemented

English | [中文](2026-08-16-web-git-change-marks.zh.md)

## Problem

The git quick-action panel (see [web git quick actions beneath the file tree](2026-08-15-web-git-quick-actions.md)) listed the changed files but could not open one: a changed row was a dead label, so the user had to find the file in the tree again. And once a file was open in the viewer, nothing answered the next question — "which lines did I change?" The viewer rendered the file content with no git context, so an editing session against a git workspace had to guess what was new.

## Decision

Two coupled capabilities, both over existing seams:

- **Changed-file rows open in the viewer.** The `sidebar.files.git` hole's owner share grows from an empty object to `{ openFile, enterFileMode }` — the tree's own open gestures, passed through `renderSlot` and consumed by the panel. A row's file name becomes a button that resolves the git-reported path (workspace-relative, since `git status --porcelain` prints relative paths, or already absolute) against the session cwd and opens it exactly like a tree row. The "client never joins path segments" rule is a viewer-contract rule; the panel's one join is unavoidable because git hands it relative paths, and the host resolves the result on its side.
- **Per-line change marks in the file viewer.** A new `git.diff` RPC (`GitApi.diff`, `{ path, file }` → `{ diff: { kind, hunks } }`) runs `git diff HEAD --no-ext-diff -- <file>` in the workspace — HEAD so staged and unstaged changes combine — and parses the single-file unified diff through the tool package's pure `parseFileDiff` into hunks of context/added/deleted records. The host resolves the file argument (workspace-relative or absolute, must land inside the workspace), reports `kind: 'untracked'` with empty hunks for a file git does not track or a repo without any commit yet, and `kind: 'tracked'` with empty hunks for a clean tracked file. The viewer derives the workspace root from the current Session's cwd, fetches the diff once per (root, path) pair, and maps hunks onto the current content: new-side records mark their line added or context; deletions anchor on the following new-side line, or on the line before the hunk when the hunk ends on deletions (an EOF removal). Added lines get a green tint and a tooltip; lines anchoring a deletion get a red tint and an "N lines deleted" tooltip; an untracked file is tinted entirely green. A successful save invalidates the tab's diff so the marks re-fetch against the new content; a diff failure (not a repo, git missing) leaves the body unmarked without disturbing the read.

## Alternatives considered

- **A full split/unified diff view with the deleted content shown inline.** Rejected: the viewer is a file viewer with edit mode, tab bar, and line-number-aligned body; interleaving deleted lines would break line alignment and edit-to-content mapping. The chosen marks keep every rendered line the actual current line and express deletions as anchored red tints — the editor-gutter pattern, not a diff document.
- **Fetching the raw diff text and parsing it in the browser.** Rejected: parsing is the host's home (the tool package's pure parsers), and a structured hunks wire value is testable and stable while raw text would push format parsing into the presentation layer.
- **`git diff` (index-comparison) instead of `git diff HEAD`.** Rejected: a staged-only change would render no marks; the viewer's question is "changed relative to the last commit", which `git diff HEAD` answers for staged and unstaged alike.
- **Sending the workspace-relative path computed client-side.** Rejected: the host already owns path resolution and the viewer should not strip root prefixes (case-insensitive drives, trailing separators); the host converts the absolute file path to a workspace-relative pathspec internally.
- **Marking untracked files as "all added" via the status buckets.** Rejected: the viewer does not know the file's status bucket; `git.diff` reports `kind: 'untracked'` directly, which also covers a repo with no commits yet.

## Consequences

- A git change is now one click from list to colored source: open the row, see the added/deleted lines, edit, and the marks re-align after the save.
- The marks are deliberately minimal — line classes and tooltips, no inline deleted content, no base/compare picker — matching the viewer's "present the current file" posture; a real diff document stays deferred.
- The gateway and runtime gain one RPC and one `IWorkspaces` method (`gitDiff`), the host service one method (`diff`) and one parser export (`parseFileDiff`), and the client runtime/test doubles mirror them; wire and contract coverage live in the apiproxy, host-service, runtime, and component suites.
- An untracked file's all-green tint can be visually loud for large new files; the tooltip explains it, and the tint is the same semantic token as any added line.
