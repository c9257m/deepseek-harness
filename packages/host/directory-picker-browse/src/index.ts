/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability by delegating every primitive to the
 * always-mounted `ctx.fileBrowser` service. The service owns the host
 * filesystem implementation (bounded listings with files, child-directory
 * creation, byte-capped text reads); this backend only adapts it onto the
 * picker capability so the in-app dialog seam contract stays intact. Nothing
 * renders on the host display, so this backend serves remote clients the
 * dialog backend cannot. Policy decisions live with the file-browser service
 * and are recorded in the directory-picker seam Agent Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import type { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
// Type-only: pulls the ctx.fileBrowser Context merge.
import type {} from '@deepseek-ai/dsh-host-file-browser'

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /** The filesystem-browsing service every browse primitive delegates to. */
  static inject = ['fileBrowser']

  private readonly browseCapability: DirectoryPickerCapability

  constructor(ctx: Context) {
    super(ctx)
    const fileBrowser = ctx.fileBrowser
    this.browseCapability = {
      kind: 'browse',
      list: (path, signal) => fileBrowser.list(path, signal),
      createDirectory: (path, name) => fileBrowser.createDirectory(path, name),
      readFile: (path, signal) => fileBrowser.readFile(path, signal),
      writeFile: (path, content) => fileBrowser.writeFile(path, content),
    }
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }
}
