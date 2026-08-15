#!/usr/bin/env node
// Fetch the Node.js distribution the desktop shell bundles.
//
// electron-builder's `extraResources` ships apps/desktop/runtime into the
// packaged app as resources/runtime; the shell spawns that Node to run the
// harness server. The harness boots on real Node (not Electron's embedded
// runtime) because its loader reaches Node internals through
// node-addon-require-builtin, which does not work in Electron's V8 realm.
//
// The version stays inside the harness engine range (`^22.19 || >=24`).

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { get } from 'node:https'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Node release line the packaged runtime pins; satisfies dsh engines `^22.19 || >=24`. */
const NODE_VERSION = '24.18.1'
/** Mirror hosting official Node.js distributions. */
const NODE_MIRROR = 'https://npmmirror.com/mirrors/node'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const runtimeDir = join(desktopDir, 'runtime')

/** The mirror's distribution identifier for this platform. */
function platformKey() {
  switch (process.platform) {
    case 'win32':
      return 'win-x64'
    case 'darwin':
      return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    case 'linux':
      return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
    default:
      throw new Error(`unsupported runtime platform: ${process.platform}/${process.arch}`)
  }
}

/** Download `url` to `dest`, following one level of redirects. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume()
        request.destroy()
        const next = new URL(response.headers.location, url).toString()
        return download(next, dest).then(resolve, reject)
      }
      if (status !== 200) {
        response.resume()
        return reject(new Error(`GET ${url} -> HTTP ${status}`))
      }
      pipeline(response, createWriteStream(dest)).then(resolve, reject)
    })
    request.on('error', reject)
  })
}

/** Extract the distribution zip into the runtime dir, stripping its top-level folder. */
function extract(zipPath) {
  mkdirSync(runtimeDir, { recursive: true })
  // bsdtar (ships with Windows 10+ and macOS) and GNU tar both strip components.
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', runtimeDir, '--strip-components=1'], { stdio: 'inherit' })
  if (tar.error !== undefined || tar.status !== 0) {
    throw new Error(`failed to extract ${zipPath}: ${tar.error?.message ?? `exit ${tar.status}`}`)
  }
}

const binaryName = process.platform === 'win32' ? 'node.exe' : 'node'
if (existsSync(join(runtimeDir, binaryName)) && !process.argv.includes('--force')) {
  console.log(`runtime already present at ${runtimeDir} (--force to re-fetch)`)
  process.exit(0)
}

const key = platformKey()
const zipName = `node-v${NODE_VERSION}-${key}.zip`
const url = `${NODE_MIRROR}/v${NODE_VERSION}/${zipName}`
const zipPath = join(desktopDir, '.cache', zipName)
mkdirSync(dirname(zipPath), { recursive: true })
console.log(`downloading ${url}`)
await download(url, zipPath)
extract(zipPath)
console.log(`Node ${NODE_VERSION} runtime ready at ${runtimeDir}`)
