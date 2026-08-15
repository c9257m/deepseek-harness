# DeepSeek Harness

English | [中文](README.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Desktop app

The Windows desktop shell offers an install path without a terminal: the packaged installer bundles its own Node.js runtime, so after installation you open Harness from the desktop shortcut — no separate Node.js installation and no terminal command required.

- The NSIS installer is produced by `pnpm desktop:dist` into `apps/desktop/dist/`; it supports choosing the installation directory and creating a desktop shortcut.
- All user data — model credentials, settings, sessions, and storages — lives under `$DSH_HOME` (default `~/.dsh`), outside the installation directory; the installer carries only the application payload, so it is safe to hand to other people.
- During source development, `pnpm desktop:dev` starts the desktop shell (port `32080`) and `pnpm desktop:pack` produces an unpacked app directory for faster iteration.

```sh
pnpm desktop:dev
pnpm desktop:pack
pnpm desktop:dist
```

See [apps/desktop/README.md](apps/desktop/README.md).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
