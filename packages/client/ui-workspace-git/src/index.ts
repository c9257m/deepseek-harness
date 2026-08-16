/**
 * Workspace git quick-action panel plugin, node half. The browser half ships
 * via exports["./client"] and registers the git panel into the workspace file
 * tree's declared `sidebar.files.git` child hole.
 */

/**
 * Node-half plugin body: nothing to contribute on the host side — the panel
 * is pure browser composition over the workspaces service's git methods.
 */
export function apply(): void {}
