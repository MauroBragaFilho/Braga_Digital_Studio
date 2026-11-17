# Braga Digital Studio (BDS) 🎬

[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![NodeJS](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

*[Leia em Português](README.md)*

Braga Digital Studio (formerly Braga Media Downloader) is an advanced and professional central hub for digital media management, downloading, and organization. Tailored specifically for content creators, photographers and videographers, the tool acts as the core bridge between your capture devices (Cameras, SD Cards, Drones) and your creative workflow.

## 📥 Download & Install

BDS is **free**. Get the latest installer from the [Releases](../../releases) page (`braga-digital-studio-<version>-windows-x64.exe` for 64-bit Windows 10/11; a portable `-windows-x64-portable.zip` and, for Linux, `-linux-x86_64.AppImage` and `-linux-x86_64.deb` are also available).

During setup you choose between:

- **Complete install (recommended):** installs the program, downloads the tools and the transcription feature, and leaves everything ready to use.
- **Short install:** installs the program and the basic tools; transcription can be added later in *Settings → Modules*.

Until the installer ships code-signed, Windows (SmartScreen) may show a warning on first run: use "More info → Run anyway". Every release lists the installer's SHA-256, plus `SHA256SUMS.txt` with the hash of every file. The app shows a notice in *Settings* when a new version is out (checking at startup is optional) and only installs after you confirm. Only the latest version gets fixes, on a best-effort basis.

## 🚀 Key Features

- **Capture Device Management:** 
  - Automatic, fast, and secure recognition of connected devices via **MTP** (Media Transfer Protocol) for Cameras and Smartphones.
  - Native reading of SD cards and flash drives via **USB (Mass Storage)**.
  - Wireless integration with **Sony Cameras (Alpha/Cyber-shot)** via SSDP & Camera Remote API for real-time telemetry (battery/storage) and dedicated RAW (.ARW), JPG and MP4 downloads.
  - Secure pairing with the **BDS phone app** (4-digit code approved on the device), over USB or Wi-Fi.
  - Clean media import that never overwrites existing files and automatically skips hidden system folders created by cameras.

- **Library & Projects:** 
  - Virtualized library (thousands of files without lag), filters, favorites, and video/audio/photo preview.
  - Projects with bins, sequences and audio-based sync, export to Premiere (XML) and the native `.bdspro` format, with relinking of missing files.

- **Smart Media Downloader:** 
  - Accelerated video/audio downloads from YouTube and hundreds of other sites, with a configurable pause between queue items.
  - When you paste a link to an item inside a playlist, the app asks whether you want only that item or the whole playlist.

- **Transcription & subtitles (optional module):** 
  - Local transcription on your own computer (cloud is optional and only used if you choose it), with SRT, Markdown and TXT output, automatic skipping of non-speech parts, and optional NVIDIA GPU acceleration.

- **Converter, Silence Remover & Metadata:** tools to convert media, cut silences, and edit tags and covers.

- **Color Grading Panel (LUTs):** (On Work)
  - A cinematic aesthetic interface designed to import, preview, and manage `.cube` color profile files.
  - Highly optimized, interactive "Before and After" real-time simulation via an interactive slider, supporting native imagery.

- **Built-in AI Assistant:** 
  - A floating button (shortcut **Ctrl + J**) opens a chat that knows your library, your projects and the screen you are on, and can transcribe, convert, remove silence, download a link, create projects and export. **Every action asks for your confirmation before it happens.**
  - Works with servers you choose: local (LM Studio, Ollama) or on the internet (Groq, Qwen, OpenAI or any compatible one), each with its own key, with automatic fallback to the next one if a server fails. It is optional and can be turned off in *Settings*.

- **Secure Session Isolation & Local Login:** 
  - Isolated login using partitioned windows (`persist:youtube`): the platform session lives in its own partition of the embedded browser, separate from the rest of the app. BDS does not store your password or send the session to any cloud of the author. Using your account for YouTube downloads is optional and off by default (*Settings → Media*). When on, the app creates a temporary plain-text file with the YouTube session only while it downloads and deletes it when done; while it exists, anyone using your Windows user can read it, so use a trusted computer. The *Sign out and delete the session* button ends the login and removes the stored session.

- **Interface Design:** 
  - Clean look in dark or light theme, with pill-shaped buttons, a red accent plus 4 other accent colors to choose from, Montserrat and Inter fonts, and accessibility-grade contrast (WCAG AA).
  - Every feature is a module that can be turned on or off in *Settings → Modules*.

## 🛠️ Technology Stack

- **[Electron](https://www.electronjs.org/) / Node.js**: The core engine empowering the application with native system capabilities, file system access, child processes, and sandboxed secure sessions.
- **[PowerShell](https://learn.microsoft.com/en-us/powershell/) (CIM/WMI)**: Invisible backend layer managing silent media copying routines and hardware scanning.
- **Vanilla JavaScript, HTML5 & CSS3**: The entire frontend was built from scratch utilizing bare-bone web standards, without bloating the app with heavy frontend frameworks. This ensures UI views load in milliseconds while consuming minimal RAM.
- **Third-party components downloaded on demand** (FFmpeg, yt-dlp, whisper.cpp and others), from each project's public releases (FFmpeg comes from the BtbN project's builds, because FFmpeg does not publish binaries) and checked by SHA-256 when the source publishes the hash. The full list, with versions and licenses, is in *Settings → About and licenses*.

## 📦 Installation & Setup (Development)

The source code is open, under the [GPL v3](LICENSE). Ensure you have **Node.js** installed on your machine (version 22 or higher).

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MauroBragaFilho/Braga_Digital_Studio.git
   cd Braga_Digital_Studio
   ```

2. **Install essential dependencies:**
   ```bash
   npm install
   ```

3. **Start the Electron development server:**
   ```bash
   npm start
   ```

   Note: in development the app writes `data/`, `database/` and `config/` inside the project folder itself. To test without touching your data, use `--user-data-dir` with a test folder.

## 🏭 How to Compile (Build the .exe)

To package the project into an easy-to-distribute installer for Windows computers:

```bash
npm run build
```

This command bundles the source code (the internal media and download tools are fetched at runtime, they are not in the installer) and outputs the final installer into the `dist/` folder (about 94 MB). The installer is dark-themed, in Portuguese, and asks whether the install is short or complete. Details, command-line parameters (such as `/S` and `/COMPONENTES=completa|curta|nenhuma`) and how to test it safely are in `.docs/INSTALADOR.md` (Portuguese).

## 🧪 Quality, Scripts & CI

| Script | What it does |
|---|---|
| `npm start` | Runs the app in development mode |
| `npm run check` | Syntax-checks every `.js` file (ES modules in the renderer) |
| `npm run lint` | ESLint (flat config in `eslint.config.js`) |
| `npm test` | Unit tests (`node --test`, `tests/` folder) |
| `npm run verify:package` | Makes sure no user data ends up in the package |
| `npm run verify:preload` | Checks that the generated `preload.js` matches what the generator produces |
| `npm run generate:licenses` | Regenerates the third-party license list |
| `npm run build` / `build:win` | Windows installer (NSIS) |
| `npm run build:win:portable` | Windows portable build |
| `npm run build:linux` | AppImage + `.deb` (also `build:linux:appimage` and `build:linux:deb`) |

The `.github/workflows/ci.yml` workflow runs `npm ci`, `check`, `lint` and `test` on every push/PR, on Linux and Windows. The release workflows run the same checks before building.

## 🚢 Versioning & Release

A release comes from a **version tag** `vX.Y.Z` whose commit is on `main`. Pushing to `main` only runs CI.

```bash
node scripts/release-tag.js
```

The script checks that you are on `main` with everything committed and in sync, suggests the next version, updates `package.json`, creates the tag and pushes it. The **Release BDS (Windows + Linux)** workflow then:

1. builds Windows and Linux after `check`, `lint` and `test` pass;
2. signs the Windows installer with SignPath (see the [code signing policy](CODE_SIGNING_POLICY.md));
3. publishes a single Release with `SHA256SUMS.txt` and notes: the installer's SHA-256 and a **Mudanças** (changes) section listing every commit title since the previous tag. So write commit titles as sentences a user can understand.

All Release files follow one pattern, which the in-app updater looks for:

| File | What it is |
|---|---|
| `braga-digital-studio-<version>-windows-x64.exe` | Windows installer (what the updater downloads) |
| `braga-digital-studio-<version>-windows-x64-portable.zip` | Portable Windows build |
| `braga-digital-studio-<version>-linux-x86_64.AppImage` | Linux, no install needed |
| `braga-digital-studio-<version>-linux-x86_64.deb` | Linux (Debian/Ubuntu) |

## 🤝 Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run check`, `npm run lint` and `npm test`. By contributing, you agree that your contribution is distributed under the same license (GPL v3). Security issues go through the [Security Policy](SECURITY.md), not a public issue.

## 🧩 Modules

Every BDS feature is a module with a switch in *Settings → Modules*. On a fresh install only the AI Assistant comes turned on; people already using the app keep what they chose. Heavy features, such as **Transcription** (engine, models and NVIDIA GPU DLLs), are downloaded on demand, SHA-256 verified, into `<dataDir>/modules`. Code in `src/core/modules/`, IPC in `src/ipc/moduleHandlers.js`, panel in `renderer/components/modules-panel.js`. Details in [`src/core/modules/README.md`](src/core/modules/README.md) (Portuguese).

## 🗂️ Folder Structure

```
main.js, preload.js      Main process and secure bridge (IPC); the preload is generated
src/core/                Business logic (media, library, devices, modules...)
src/infrastructure/      External tools, filesystem, database
src/ipc/                 IPC handlers, channel table and input validation
src/services/            Application services (downloads, conversion, AI assistant...)
src/setup/               Windowless mode used by the installer (--setup-components)
src/config/              Versioned configuration (e.g. modules.config.json)
renderer/                UI (vanilla JS, ES modules; fonts in renderer/assets/fonts)
installer/               NSIS script and installer images
config/                  Local configuration (ignored); use *.example.json as a template
assets/                  App icons and the third-party license file
scripts/, tests/         Maintenance scripts and automated tests
.github/workflows/       CI and release
```

## 🔒 Privacy, Data & Gitignore

All the data the program generates (library, settings, history, thumbnails) stays on your computer, in a local folder (`AppData`). The program has **no telemetry**, requires no account, and does not send your library or files to the author. AI server keys are stored encrypted and are never shown back.

What reaches the internet: update checks and downloads (GitHub), tools and models (each project's public releases and Hugging Face), the sites you ask it to download from and, **only if you choose**, the cloud: the configured AI server, cloud transcription (the audio goes to the provider you pick, Groq or ElevenLabs) and AI transcript analysis (the transcript text goes to the AI server). With any of them, what you send leaves your computer, so the app warns you before the first time. The MCP server, which is off by default, only accepts connections from your own computer. Error reports are only sent if you choose to send them.

No sensitive information is stored in this repository: databases, caches, logs, `data` folders and authentication sessions are blocked by the `.gitignore` rules.

Found a security flaw? See the [Security Policy](SECURITY.md) and report it privately, not in a public issue.

## ⚖️ Copyright and responsible use

BDS downloads the videos and audio that **you** ask for, from sites the program does not control; the content still belongs to whoever holds the rights. Download only what you have the right to download (your own content, freely licensed content, or content you have permission to use): respecting copyright and each site's terms is the responsibility of the person downloading. Music from streaming services is for personal use; using it as the soundtrack of a published video requires a license. The same goes for uploading to YouTube: publish only what you have the right to publish, paying attention to third-party music and images.

## 📄 License

Copyright © 2026 **Mauro Braga**. Free software under the [GNU GPL v3.0](LICENSE): you may use, study, modify and redistribute it, as long as you keep the same license and the source open. Third-party components keep their own licenses (see *Settings → About and licenses*).

Signed Windows installers: [Code Signing Policy](CODE_SIGNING_POLICY.md) — free code signing by [SignPath.io](https://signpath.io), certificate by the [SignPath Foundation](https://signpath.org).
