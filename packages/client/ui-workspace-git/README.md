# @deepseek-ai/dsh-client-ui-workspace-git

English | [中文](README.zh.md)

Workspace git quick-action panel plugin for the web GUI: the browser half registers the panel into the workspace file tree's declared `sidebar.files.git` child hole, rendering beneath the tree in the sidebar's files view. The panel derives the workspace path from the standard sessions feed, calls the workspaces service's git methods through the injected share, and shows the current branch with ahead/behind facts, the changed-file buckets (staged/unstaged/untracked/conflicted) in a drag-resizable list with per-file stage/unstage buttons and bucket batch actions, a stage-all commit box, push/pull/refresh actions, and every local branch as a clickable list with the current one marked — all compact enough for the sidebar column. A header toggle collapses the whole panel body to the title row (and expands it back), so the sidebar can reclaim space between editing sessions. A workspace outside a git repository shows a "不是 git 仓库" notice instead of the controls.

Changed-file rows open in the shared file viewer: clicking a row's file name resolves the git-reported path (workspace-relative, or already absolute) against the session cwd and calls the tree's owner-provided open gestures, so a change opens like any tree row — and the opened file then shows its per-line change marks in the viewer.

Behavior facts: the loaded status and branches and the interaction draft (commit message, busy flag, last output/error) live in the package's shared store (`createGitPanelStore`), so the facts survive remounts; the panel is the only reader and writer. Status and branch listing load on session-workspace change and on refresh, with a supersession counter and live abort so a newer root or refresh invalidates stale settlements. Operations are exclusive (the busy flag disables the actions while one is in flight); a successful operation shows its acknowledgement (`已提交 <shortHash>` / `推送完成` / `拉取完成` / `已暂存 N 个文件` / `已取消暂存 N 个文件`) and then reloads the status, while a failure shows the wire error message in an alert row that survives the reload. Per-file and batch stage/unstage (`git.stage`/`git.unstage`) let the user build a selective index; commit uses the host's stage-all-and-commit semantics (`git.commit`) for the remaining changes, matching the quick-action intent. Product copy is Chinese; the English dictionary mirrors it key-for-key.

The panel is pure browser composition: it depends only on the slot system (the hole declared by [ui-workspace-files](../ui-workspace-files/README.md)' FileTree entry), the standard sessions/workspaces feeds, and the locale seat. The host side of the git operations is [@deepseek-ai/dsh-host-workspace-git](../../host/workspace-git/README.md), served through the `git.*` RPCs.

## Model Experience

None, as the panel is a GUI control; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Compact list only** — the changed-file buckets show up to 20 paths each with a `+N` overflow marker; paging or a full source-control view is deferred.
- **Branch list is click-and-switch** — the list checks out on click; create/delete/rename branch management stays with the model-facing git tool.
- **Commit is stage-all** — the panel commits every workspace change; selective staging would need separate stage verbs the host service does not expose yet.
