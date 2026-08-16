# @deepseek-ai/dsh-client-ui-workspace-files

English | [中文](README.zh.md)

Workspace file browser plugin. `FileTree` fills the sidebar shell's `sidebar.files` slot — the current Session's canonical cwd shown as a lazy file/directory tree — and `FileViewer` fills the layout's `workspace.fileViewer` slot, the center column's occupant while file mode is on. Both registrations share one open-tab store handle, so the tree's open gesture and the viewer's tab bar drive the same state.

Opening a file (tree row click) adds it to the open-tab list and activates it, then flips the layout into file mode through `ctx.layout.openFileMode()`: the viewer takes the center column and the conversation docks into the right track as a draggable panel. The viewer's tab bar supports several files at once — click a tab to activate it, × (or the tab's right-click menu: close / close others / close all) to close; closing the last tab calls `ctx.layout.closeFileMode()` and returns the conversation to the center. Directories expand lazily — each opened level costs one `host.listDirectory` call, cached locally; hidden (dot-prefixed) entries are filtered out like the directory picker's default posture.

File rows and tabs carry a **per-type badge** derived from the extension (TS / JS, `{ }`, `M↓`, `#`, `<>`, `>_`, …) instead of one generic code glyph. The code body is **syntax-highlighted per language** through the ui-primitives highlighter (`highlightLines`, grammars lazy-loaded on demand — a first render falls back to plain text, then re-highlights when the grammar registers) with an optional **line-number gutter**; the body's right-click menu toggles line numbers and highlighting. The **code font size** is a durable user setting: the package's node half registers a `workspace-files` settings namespace (schema default 12 px, bounded 10–24), the browser half binds it through `ctx.settingsScope` and mirrors it into the shared store, and a **File Font Size** row in the General settings section steers it with a bounded ± stepper.

Tabs of readable text files are **editable**: the edit toggle swaps the highlighted body for a plain-text editor, and edits are **auto-saved** through `host.writeFile` after a 1 s debounce (flushed immediately on tab switch or close). Dirty tabs carry a dot; a failed save shows an error bar with Retry and keeps the draft. The Host writes atomically (temp sibling + rename, the atomic-write utility) and reports `file-write-failed` otherwise. File content is read whole through `host.readFile` with the Host's byte cap, fetched once per tab (switching tabs does not re-read); a too-large, non-text, or unreadable file renders localized error copy instead of content and cannot be edited.

Files inside a git workspace carry **per-line change marks** fetched from the injected `gitDiff` (the host's working-tree-vs-HEAD diff): added lines get a green tint and lines anchoring a deletion get a red tint with an "N lines deleted" tooltip, while a file git does not track is tinted entirely green. Marks are fetched once per (workspace root, file) and re-fetched after a successful save so they stay aligned with the new content; a diff failure (not a repo, git missing) leaves the body unmarked without disturbing the read. The viewer derives the workspace root from the current Session's cwd and requests the diff only when a session exists.

The sidebar shell owns the sessions/files view switch (`sidebar.files` is declared there); this package only registers into the hole via `slots.inject()` for each declaration lifetime. The git quick-action panel registered into the `sidebar.files.git` child hole receives the tree's open-file gestures as owner props, so a changed-file row in that panel opens in this viewer exactly like a tree row.

## Model Experience

None, as the file browser is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Editing is a plain-text area, no in-place syntax highlighting or line numbers while editing** — the highlighted, line-numbered body is read-only; entering edit mode swaps to a monospace textarea. A richer editor (CodeMirror/Monaco-style) is deferred.
- **No concurrent-edit protection** — the viewer auto-saves the whole file content; an external change between read and save is overwritten (the atomic write prevents partial files, not lost updates).
- **Binary and oversized files cannot be edited** — content that failed to read (too large, non-text, unreadable) renders the error copy and a disabled edit toggle.
- **The tree roots at the current Session's cwd** — switching sessions re-roots the tree; there is no workspace selector inside the files view.
- **No refresh or live watch** — the tree is fetched on demand and tab contents are cached per viewer session; external file changes are not pushed or re-read.
- **No row virtualization** — a file near the read cap (1 MiB) renders one DOM row per line, which can be slow for very large files.
- **Hidden entries are always hidden** — unlike the directory picker there is no show-hidden toggle in the file tree yet.
- **Font size is a single global value** — there is no per-file or per-session font size; the General-settings stepper bounds it to 10–24 px.
- **Diff marks show change classes, not the removed content** — the viewer tints added lines green and anchors deletions with a red tint and an "N lines deleted" tooltip; the removed line text itself is not displayed inline (no split-diff view yet), and marks compare against HEAD only (no base/compare revision picker).
