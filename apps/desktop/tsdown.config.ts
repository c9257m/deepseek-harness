import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one Electron-main bundle. The root tsdown builds
 * only `lib/types/index.js`, so this override points at the emitted main and
 * keeps the runtime `electron` import external (the binary provides it).
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    // The Electron binary provides its own runtime module; bundling it would
    // embed a stub instead.
    neverBundle: ['electron'],
  },
  fixedExtension: false,
  dts: false,
  clean: false,
})
