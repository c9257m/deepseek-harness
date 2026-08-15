# @deepseek-ai/dsh-host-file-browser

English | [中文](README.zh.md)

GUI filesystem-browsing service for the web host: `ctx.fileBrowser` serves the browser-side file tree and viewer primitives — one-level listings (files and directories), child-directory creation, and bounded text-file reads over Node's stdlib (which already carries the per-OS adaptation). Mounted on every web composition, independent of how directory *picking* is served: the file browser works whether the [directory-picker seam](../directory-picker/README.md) resolved to the native OS chooser or the in-app browse dialog. The [browse backend](../directory-picker-browse/README.md) delegates its capability methods to this service, so one implementation serves both the picker dialog and the file browser.

Behavior facts: listings return files and directories name-sorted in one bounded window — symlinks resolved to their target kind, broken/cyclic links skipped, a host-owned `hidden` flag (POSIX dot convention) left for the client to act on — with `crumbs` as the root-to-target ancestor chain (the root crumb labeled by its full path) and an absent `list` path meaning the host account's home directory. `createDirectory` is non-recursive (a missing parent is a real failure, not a level to invent) and validates the name as a single non-blank segment even when called directly, mirroring the wire schema's fence. Every primitive rejects an explicit path that is not fully qualified — relative forms, and on Windows the rooted drive-less forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`) that `isAbsolute` accepts — instead of letting `resolve` rebase it under the host process cwd or current drive. One `list` call returns at most `maxEntries` rows (config, default 1000 — the bound GitHub's web UI applies to directory listings), streaming through a bounded window so memory stays O(maxEntries) no matter how many children the directory holds: a cut level keeps the name-sorted head, counts hidden rows against the bound, probes only windowed candidates, and reports `truncated: true`. `readFile` returns a whole UTF-8 text file at most `maxReadBytes` (config, default 1 MiB): a larger or missing or non-regular target fails `file-too-large`/`file-unreadable`, and content carrying a NUL byte fails `file-not-text` (binary rejection decided on the complete bounded result). Every primitive threads the caller's `AbortSignal` so a disconnect or timeout stops the scan or read instead of letting it outlive the caller, and failures throw the seam's typed `DirectoryPickerError` so the gateway maps them onto the wire error vocabulary directly. Policy rationale: [the directory-picker capability seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md).

## Model Experience

None, as the service serves the GUI host's file browsing; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Windows hidden attribute is not read** — Node dirents do not expose `FILE_ATTRIBUTE_HIDDEN`, so `hidden` means dot-prefixed on every platform until a native probe is worth its cost.
- **No drive-root enumeration** — on Windows the ancestry stops at the drive root; crossing drives waits for the browser UI's path-entry affordance rather than an enumeration primitive here.
- **Whole-filesystem scope** — there is no per-deployment browse-root restriction. `workspace.create` accepts arbitrary paths, so a root here would be UX scoping rather than a security boundary.
- **Reads are whole-file only** — a file over `maxReadBytes` fails `file-too-large`; partial/truncated reads are deferred until a viewer wants them.
