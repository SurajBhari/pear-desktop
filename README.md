# 🍐 Pear Desktop

[![GitHub release](https://img.shields.io/github/v/release/deruta74/pear-desktop?style=for-the-badge)](https://github.com/deruta74/pear-desktop/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](license)

A desktop app for YouTube Music with plugins, custom themes and native integrations.
This repository is an independently maintained fork of [pear-devs/pear-desktop](https://github.com/pear-devs/pear-desktop).

Code and documentation in this fork may be written or modified with assistance from large language models (LLMs) and AI agents.

Pear Desktop is not affiliated with Google or YouTube. Their names and trademarks belong to their respective owners.
The software is provided under the [MIT license](license), without warranty.

## Contents

- [Features](#features)
- [Download](#download)
  - [Windows](#windows)
  - [macOS](#macos)
  - [Linux](#linux)
  - [Verify downloads](#verify-downloads)
- [Themes](#themes)
- [Development](#development)
  - [Build](#build)
  - [Production preview](#production-preview)
  - [Checks and tests](#checks-and-tests)
- [Build your own plugins](#build-your-own-plugins)
- [Translation](#translation)
- [Contributing](#contributing)
- [License](#license)
- [FAQ](#faq)

## Features

- YouTube Music in a desktop window, with configurable plugins and CSS themes.
- Restored AdBlocker, Compact Sidebar and No Google Login plugins from the 3.11 plugin set, alongside Clock and Do Not Track.
- Fixes for lyric romanization, player API state, background download feedback and plugin cleanup.
- Renderer memory and initialization improvements.

**Bypass Age Restrictions is disabled by default and experimental. Anonymous age-restricted playback is currently unavailable.**
See the [plugin notes](src/plugins/bypass-age-restrictions/README.md) for its limitations.

## Download

Download packages for this fork from the [latest GitHub release](https://github.com/deruta74/pear-desktop/releases/latest).
The packaged application and filenames currently use the name **YouTube Music**.
`VERSION` in the filenames below means the version shown on the release page.

### Windows

- **Installer:** `YouTube-Music-Web-Setup-VERSION.exe`. It downloads the payload for your architecture: x64, ia32 or ARM64.
- **Portable:** `YouTube-Music-VERSION.exe`. It does not require the web installer's separate payload files.

These executables are unsigned, so Windows may show an unknown-publisher prompt.
[Verify the download](#verify-downloads) before running it.

#### Install without a network connection

Download the web installer and the matching payload **from the same release**:

| Windows architecture | Payload                               |
| -------------------- | ------------------------------------- |
| x64                  | `youtube-music-VERSION-x64.nsis.7z`   |
| ia32 (32-bit)        | `youtube-music-VERSION-ia32.nsis.7z`  |
| ARM64                | `youtube-music-VERSION-arm64.nsis.7z` |

Keep the installer and payload in the same directory, retaining their original filenames, then run the installer.
The portable executable is another option for offline use.

### macOS

- **Intel:** `YouTube-Music-VERSION.dmg`.
- **Apple Silicon:** `YouTube-Music-VERSION-arm64.dmg`.

Open the DMG and drag **YouTube Music.app** into Applications.
ZIP packages are also provided for updater compatibility.

These builds are unsigned and not notarized. If macOS blocks a download that you have verified, remove its quarantine attribute:

```bash
/usr/bin/xattr -dr com.apple.quarantine "/Applications/YouTube Music.app"
```

### Linux

Choose a package for your architecture and distribution from the release page:

| Format         | Architectures       |
| -------------- | ------------------- |
| AppImage       | x64, ARM64, ARMv7   |
| DEB            | amd64, ARM64, ARMv7 |
| RPM            | x86_64, aarch64     |
| Flatpak bundle | x86_64              |
| Snap package   | amd64               |
| tar.gz archive | x64, ARM64, ARMv7   |

Make an AppImage executable before launching it. Install a downloaded DEB or RPM with your distribution's package manager.
Flatpak and Snap downloads are local package files; install them using the corresponding tool.

The `.freebsd` files retain the upstream packaging format and contain Linux Electron binaries; they do not provide a native FreeBSD Electron runtime.

### Verify downloads

`SHA256SUMS` lists SHA-256 checksums for the release assets.
A release may also include `SHA256SUMS.asc`, a detached GPG signature of that checksum file.

On Linux, check the downloaded files with `sha256sum`; on macOS, use `shasum -a 256`.
On Windows, use PowerShell's `Get-FileHash -Algorithm SHA256`.
Compare the result for your file with its entry in `SHA256SUMS`.
To verify the checksum file's signature, import the [public signing key](https://github.com/deruta74.gpg) and run:

```bash
gpg --verify SHA256SUMS.asc SHA256SUMS
```

## Themes

Load a custom CSS file through **Options → Visual Tweaks → Theme → Import custom CSS file**.

## Development

The development and CI setup uses **Node.js 24** and **pnpm 11**.

```bash
git clone https://github.com/deruta74/pear-desktop.git
cd pear-desktop
pnpm install --frozen-lockfile
pnpm dev
```

A [VS Code devcontainer configuration](.devcontainer/devcontainer.json) is also available. GUI support depends on the host environment.

### Build

`pnpm build` compiles the application into `dist/`.
The commands below also package it into distributable files in `pack/`:

| Command                     | Target                                         |
| --------------------------- | ---------------------------------------------- |
| `pnpm dist:win`             | Windows: x64, ia32 and ARM64                   |
| `pnpm dist:mac`             | macOS: Intel DMG                               |
| `pnpm dist:mac:arm64`       | macOS: Apple Silicon DMG                       |
| `pnpm dist:linux`           | All configured Linux formats and architectures |
| `pnpm dist:linux:deb-arm64` | Linux: ARM64 DEB                               |
| `pnpm dist:linux:rpm-arm64` | Linux: ARM64 RPM                               |

Build on the corresponding operating system. Linux formats may require additional packaging tools, including Snapcraft, Flatpak and RPM tooling.
Each `dist:*` command cleans the previous output. The [release workflow](.github/workflows/release.yml) builds all targets for an OS in a single invocation.

### Production preview

```bash
pnpm build
pnpm start
```

### Checks and tests

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm exec playwright install --with-deps chromium
pnpm test
```

Application tests use [Playwright](https://playwright.dev/). Release staging regression tests run with:

```bash
node --test scripts/verify-release.test.cjs
```

## Build your own plugins

Create a directory under `src/plugins/YOUR-PLUGIN-NAME` with an `index.ts` entry point.
For example, a plugin with custom styles can use:

```typescript
import style from './style.css?inline';

import { createPlugin } from '@/utils';

export default createPlugin({
  name: () => 'My plugin',
  description: () => 'Apply custom player styles.',
  restartNeeded: false,
  config: { enabled: false },
  stylesheets: [style],
  renderer: {
    start() {
      // Initialize renderer behavior here.
    },
    stop() {
      // Release timers, event listeners and observers created by the plugin.
    },
  },
});
```

Create `style.css` alongside the entry point. Stylesheets registered this way are managed by the plugin lifecycle.
Plugins can define backend, preload and renderer hooks, configuration and menu entries.
Use the [plugin types](src/types/plugins.ts), [context types](src/types/contexts.ts) and [existing plugins](src/plugins) as references.

## Translation

Translation files are in [src/i18n/resources](src/i18n/resources).
Submit translation updates through a pull request to this repository.

## Contributing

Open pull requests against [this repository](https://github.com/deruta74/pear-desktop/pulls).
Keep changes focused and describe what changed and how it was checked.
For bug fixes, include your OS, architecture, app version, enabled plugins and steps to reproduce the problem.

## License

[MIT](license). Original copyright: th-ch. Thanks to the [upstream project and its contributors](https://github.com/pear-devs/pear-desktop/graphs/contributors).

## FAQ

### Why is the app menu hidden?

If **Hide Menu** is enabled, press <kbd>Alt</kbd> to show it, or <kbd>`</kbd> when using the In-App Menu plugin.
