# Workspaces

English | [中文](workspace.zh.md)

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. The subsystem is one package ([dsh-workspace](../../packages/workspace/workspace), `ctx.workspaceRegistry`) — an optional host-side capability, not part of the agent-loop spine, and invisible to models (no tools, no prompt text, no session events). It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd — but membership requires both: an id on the account and a header whose canonical cwd equals the workspace path, so one session structurally belongs to at most one workspace. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` canonicalizes the path, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? basename(path)` prepended to the durable registry order — a new record cannot duplicate an existing display title (`WorkspaceNameConflictError`). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

## Consumers

[dsh-host-apiproxy](../../packages/host/apiproxy) is the product consumer: it serves workspace CRUD to GUI clients over `ctx.workspaceRegistry` and performs the create-session-then-attach flow above. [dsh-agent-instructions](../../packages/context/agent-instructions) is **not** a consumer despite the name: it discovers AGENTS.md-style instruction files under an agent's own cwd and never touches `ctx.workspaceRegistry` — the shared word refers to the user's working directory, not to this registry's entities.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts:158`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxfilebrowser--filebrowser"></a>

### `ctx.fileBrowser` — `FileBrowser`

The filesystem-browsing service implementation (stable per service life).

```ts cordis-catalog
/**
 * List one directory level (files and directories), bounded by
 * {@link Config.maxEntries}.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param signal - caller lifetime; abort stops the scan (a stalled network
 * directory must not outlive a disconnected caller) and rejects with the
 * abort reason.
 * @returns the level's listing with ancestry; a cut level reports `truncated`.
 * @throws {DirectoryPickerError} `directory-unreadable` when the target is not fully
 * qualified (a wire value must never resolve against the host cwd or, on
 * Windows, its current drive) or cannot be listed.
 */
async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing>

/**
 * Create one child directory under an existing parent.
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment (no separators, not `.`/`..`).
 * @returns the created directory's absolute path.
 * @throws {DirectoryPickerError} `directory-exists` for an existing child,
 * `directory-create-failed` for a parent that is not fully qualified or any other failure.
 */
async createDirectory(path: string, name: string): Promise<string>

/**
 * Read a regular text file, bounded to {@link Config.maxReadBytes}.
 * @param path - absolute file to read.
 * @param signal - caller lifetime; abort rejects with the abort reason.
 * @returns the decoded UTF-8 content of the whole file.
 * @throws {DirectoryPickerError} `file-unreadable` when the path is not
 * fully qualified or cannot be read as a regular file,
 * `file-too-large` when the file exceeds the backend's byte cap, and
 * `file-not-text` when the content is not valid text (binary rejection).
 */
async readFile(path: string, signal?: AbortSignal): Promise<string>

/**
 * Replace a text file's whole content atomically (temp sibling + rename,
 * via the atomic-write utility), so readers observe either the old or the
 * new complete content and a failed write leaves the target untouched.
 * @param path - absolute file to write.
 * @param content - the complete next file content.
 * @throws {DirectoryPickerError} `file-write-failed` when the path is not
 * fully qualified or the replacement fails for any filesystem reason.
 */
async writeFile(path: string, content: string): Promise<void>
```

Source: [`packages/host/file-browser/src/index.ts:208`](../../packages/host/file-browser/src/index.ts)

<a id="ctxworkspacegit--workspacegit"></a>

### `ctx.workspaceGit` — `WorkspaceGit`

The GUI git-operations service implementation (stable per service life). Every method runs the system git binary in `path` and fails with a typed GitError (`GIT_NOT_A_REPOSITORY` for a non-repo directory, `GIT_ABORTED` for the deadline or caller signal, `GIT_LAUNCH_FAILED` for a failed spawn, `GIT_OUTPUT_OVERFLOW` for a stdout cap breach, `GIT_FAILED` for any other non-zero exit).

```ts cordis-catalog
/**
 * The working-tree picture of a workspace directory.
 * @param path - fully-qualified workspace directory.
 * @param signal - caller lifetime.
 * @returns the parsed status (branch, ahead/behind, file buckets, clean flag).
 */
async status(path: string, signal?: AbortSignal): Promise<GitStatusValue>

/**
 * Stage every change and commit it with the given message — the quick-action
 * semantics of the GUI panel ("commit my workspace changes"), unlike the
 * model-facing tool's staged-only commit.
 * @param path - fully-qualified workspace directory.
 * @param message - the commit message (subject line).
 * @param signal - caller lifetime.
 * @returns the new commit's identity.
 */
async commit(path: string, message: string, signal?: AbortSignal): Promise<GitCommitValue>

/**
 * Stage the given working-tree paths into the index (`git add -- <paths>`).
 * Paths are workspace-relative, exactly as `status` reports them, so the
 * panel can round-trip a row back into the index.
 * @param path - fully-qualified workspace directory.
 * @param files - workspace-relative paths to stage (non-empty).
 * @param signal - caller lifetime.
 * @returns the staged paths.
 */
async stage(path: string, files: readonly string[], signal?: AbortSignal): Promise<{ files: string[] }>

/**
 * Remove the given paths from the index, keeping the working-tree content
 * (`git restore --staged -- <paths>`).
 * @param path - fully-qualified workspace directory.
 * @param files - workspace-relative paths to unstage (non-empty).
 * @param signal - caller lifetime.
 * @returns the unstaged paths.
 */
async unstage(path: string, files: readonly string[], signal?: AbortSignal): Promise<{ files: string[] }>

/**
 * Upload the current branch to its upstream remote.
 * @param path - fully-qualified workspace directory.
 * @param signal - caller lifetime.
 * @returns the retained git output (progress and confirmation).
 */
async push(path: string, signal?: AbortSignal): Promise<GitOutputValue>

/**
 * Download and integrate the current branch from its upstream remote.
 * @param path - fully-qualified workspace directory.
 * @param signal - caller lifetime.
 * @returns the retained git output (fast-forward summary and file stats).
 */
async pull(path: string, signal?: AbortSignal): Promise<GitOutputValue>

/**
 * List the local branches of a workspace directory.
 * @param path - fully-qualified workspace directory.
 * @param signal - caller lifetime.
 * @returns the parsed branches (current, upstream, ahead/behind, `[gone]`).
 */
async branches(path: string, signal?: AbortSignal): Promise<GitBranchValue[]>

/**
 * Switch the workspace to an existing local branch.
 * @param path - fully-qualified workspace directory.
 * @param branch - the branch to check out.
 * @param signal - caller lifetime.
 * @returns the checked-out branch name.
 */
async checkout(path: string, branch: string, signal?: AbortSignal): Promise<{ branch: string }>
```

Source: [`packages/host/workspace-git/src/index.ts:153`](../../packages/host/workspace-git/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The path is
 * canonicalized through `fs.realpath`; a nonexistent path rejects with the
 * original error and a non-directory rejects. Repeated calls for the same
 * canonical path return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in any path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in any spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts:92`](../../packages/workspace/workspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
