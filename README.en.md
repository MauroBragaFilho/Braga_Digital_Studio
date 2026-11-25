# Braga Digital Studio (BDS) 🎬

[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![NodeJS](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

*[Leia em Português](README.md)*

Braga Digital Studio (formerly Braga Media Downloader) is a program for downloading, importing, organizing and preparing digital media. Built for content creators, photographers and videomakers, it connects capture devices (cameras, phones, SD cards) to the editing workflow.

## 📥 Download and install

BDS is **free**. Download the latest installer from the [Releases](../../releases) page (`braga-digital-studio-<version>-windows-x64.exe` for 64-bit Windows 10/11; there is also the portable zip `-windows-x64-portable.zip` and, for Linux, `-linux-x86_64.AppImage` and `-linux-x86_64.deb`).

**Systems:** Windows 10/11 x64 (full); Linux x64 (no MTP; transcription on the CPU only); macOS is not supported.

During installation you choose between:

- **Full install (recommended):** installs the program, downloads the tools and the transcription feature and leaves everything ready to use.
- **Short install:** installs the program and the basic tools; transcription can be installed later: turn the module on in *Settings → Modules* and install the engine and the model in *Settings → Artificial Intelligence → On this computer*.

Until the installer ships with a digital signature, Windows (SmartScreen) may show a warning on first run: use "More info → Run anyway". Each release includes the installer's SHA-256 and `SHA256SUMS.txt` with the hash of every file. The program tells you in *Settings* when a new version is available (checking when the app opens is optional) and only installs it after your confirmation; automatic installation is Windows only (on Linux it just tells you and points to the release package). Only the latest version receives fixes, on a best-effort basis.

## 🚀 Main Features

On a fresh install only the AI Assistant is turned on (the full install also turns on Transcription). The other features below are turned on in *Settings → Modules*.

- **Capture Device Management:** 
  - Recognition of cameras and phones connected via **MTP** (Media Transfer Protocol; Windows only).
  - Reading SD cards and USB drives via **USB (Mass Storage)**.
  - Wireless integration with **Sony cameras (Alpha/Cyber-shot)** via SSDP and the Camera Remote API, with downloads that separate RAW (.ARW), JPG and MP4.
  - Secure pairing with the **BDS phone** (requires the BDS app on the phone; 4-digit code approved on the device), over USB or Wi-Fi. Network discovery (mDNS) may fail behind a VPN.
  - Media import that never overwrites existing files and skips the cameras' hidden system folders, with organization of the media after import.

- **Home, Library and Projects:** 
  - Library with a virtual window (thousands of files without freezing), filters, favorites and video, audio and photo preview. In multi-select lists (Library, Projects, LUTs), holding Shift while clicking selects the range between the last click and the current one.
  - Projects with folders and camera sync by audio, export to Premiere (XML) and the native `.bdspro` format, with relinking of missing files. Each project has a workspace with four tabs: Overview (with the project's LUTs), Files (includes "Remove silence" for the selected files), Sync cameras and Delivery and export; the source monitor opens in a window.

- **Media Download:** 
  - Video and audio download from YouTube and hundreds of other sites (yt-dlp), with a configurable pause between queue items.
  - When you paste a link to an item inside a playlist, the app asks whether you want just that item or the whole playlist.

- **YouTube Upload:** upload queue and YouTube Studio inside the app.

- **Transcription and subtitles (optional module):** 
  - Local transcription on your computer (the cloud is optional and only used if you choose it), with SRT, Markdown and TXT output; automatic filtering of non-speech segments; optional NVIDIA GPU acceleration (Windows only).

- **Converter and Metadata:** tools to convert media and edit tags and cover art. Cutting silences lives inside Projects (Files tab).

- **Color Grading Panel (LUTs):**  (IN PROGRESS)
  - Import of `.cube` color profiles (files, a whole folder or drag and drop, with a summary before copying), subfolders, 1D and 3D LUTs, search, multi-select and preview; the side panel only appears when a LUT is selected.
  - Per-project LUTs (card in the project's Overview): the `.bdspro` carries the LUTs, and the Premiere XML comes with a LUT folder beside it (the XML does not apply the LUT).
  - LUT sync to devices (on the Devices screen).
  - "Before and After" comparison with a slider, in real time, on images.

- **Built-in AI Assistant:** 
  - A floating button (shortcut **Ctrl + J**) opens a chat that knows your library, your projects and the screen you are on, and can transcribe, convert, remove silence, download a link, create projects and export (22 tools). **By default it carries out what you ask for in the chat without opening a confirmation window** (validations still apply and every action is logged); in *Settings → Artificial Intelligence → Assistant*, turn off "Run without asking for confirmation" to confirm each action. External agents (MCP) ask for confirmation by default. Before the first message to a server that is not local, the app warns that the content will leave your computer.
  - Works with servers you choose: local (the app's own model, LM Studio, Ollama) or online (Groq, Qwen, OpenAI, Anthropic or another compatible one), each with its own key, automatically switching to the next one if one fails. In *Settings → Artificial Intelligence → Providers*, "Add provider" discovers the models from the address and the key. The app's own model downloads the official `llama-server` from llama.cpp and a Qwen2.5-0.5B or Qwen3-VL 2B/4B/8B model (with vision), chosen by the graphics card's memory. It is optional and can be turned off in *Settings*.

- **Secure Session Isolation and Local Login:** 
  - Isolated login in partitioned windows (`persist:youtube`): the platforms' session lives in its own partition of the embedded browser, separate from the rest of the app. BDS does not store your password or send the session to any cloud of the author. Using your account for YouTube downloads is optional and off by default (*Settings → Media and Performance → Downloads*). The Upload tab uses a separate partition (`persist:youtube_studio`). When on, the app creates a temporary text file with the YouTube session only while downloading and deletes it when done; while it exists, anyone using your Windows user can read it, so use a trusted computer. The *Sign out and delete session* button ends the login and removes the stored session.

- **Interface Design:** 
  - Clean look, in dark or light theme, with pill buttons, a red accent and 4 other colors to choose from, Montserrat and Inter fonts and accessibility contrast (WCAG AA).
  - Each feature is a module that can be turned on or off in *Settings → Modules*.

## 🛠️ Technologies Used

- **[Electron](https://www.electronjs.org/) / Node.js**: file system access, external processes and isolated sessions, with the renderer sandboxed. In the package, Electron Fuses turn off `runAsNode`, `NODE_OPTIONS` and `--inspect`.
- **[PowerShell](https://learn.microsoft.com/en-us/powershell/) (CIM/WMI)**: used on Windows for hardware scanning and media copying over MTP. Linux has no PowerShell, and therefore no MTP.
- **JavaScript (Vanilla), HTML5 and CSS3**: the interface uses only the basic web technologies, with no framework, which keeps it light.
- **[sql.js](https://sql.js.org/)** (SQLite in WebAssembly) as the database; `bonjour-service` (device mDNS), `chokidar` (folder watching), `winston` (logs) and `adm-zip`.
- **Third-party components downloaded on demand** (FFmpeg, yt-dlp, whisper.cpp, llama.cpp and others), from each project's public releases (FFmpeg comes from the BtbN project builds, because FFmpeg does not publish binaries) and checked by SHA-256 when the source publishes the hash. The full list, with versions and licenses, is in *Settings → About and licenses*.

## 📦 Installation and Usage (Development)

The source code is open, under the [GPL v3](LICENSE). Make sure you have **Node.js** installed on your machine (version 22 or later; CI uses 24).

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MauroBragaFilho/Braga_Digital_Studio.git
   cd Braga_Digital_Studio
   ```

2. **Install the essential dependencies:**
   ```bash
   npm install
   ```

3. **Open the app in development mode:**
   ```bash
   npm start
   ```

   Note: in development the app writes `data/`, `database/`, `logs/` and `config/` inside the project folder itself, and `--user-data-dir` does not change that (it only changes the embedded browser's profile). To test without touching your data, use a separate clone of the repository.

## 🏭 How to Build (Generate the .exe)

To turn the project into an installer that is easy to distribute to other Windows computers:

```bash
npm run build
```

This packages the source code (the media, download and AI engines are downloaded at runtime and are not included in the installer) and produces the installer `braga-digital-studio-<version>-windows-x64.exe` in the `dist/` folder (about 90 to 100 MB). The installer is black, in Portuguese, and asks whether the install is short or full. Command-line parameters:

- `/S` installs without a window; in this mode the default is `/COMPONENTES=nenhuma`, meaning a silent update downloads nothing and keeps what already exists.
- `/COMPONENTES=completa|curta|nenhuma` chooses what to download; full and short call the app with `--setup-components=full|basic`.
- Reinstalling over an installation that already has the components does not ask again.

The installer script lives in `installer/`.

## 🧪 Quality, Scripts and CI

| Script | What it does |
|---|---|
| `npm start` | Opens the app in development mode |
| `npm run check` | Validates the syntax of every `.js` (ES modules in the renderer) |
| `npm run lint` | ESLint (flat config in `eslint.config.js`) |
| `npm test` | Unit tests (`node --test`, `tests/` folder) |
| `npm run verify:package` | Ensures no user data goes into the package |
| `npm run generate:preload` | Generates `preload.js` |
| `npm run verify:preload` | Checks that `preload.js` matches what the generator produces |
| `npm run generate:licenses` | Regenerates the third-party license list |
| `npm run build` / `build:win` | Windows installer (NSIS) |
| `npm run build:win:portable` | Windows portable version (`.exe`; the Release `.zip` is assembled by the release workflow) |
| `npm run build:linux` | AppImage + `.deb` (also `build:linux:appimage` and `build:linux:deb`) |

Other scripts in `scripts/`, without an npm shortcut: `after-pack-check.js` (runs after packaging), `generate-installer-images.js`, `installer-license.js` and `limpar-artefatos.js`. `BDS_Menu.bat`, at the root, is a Windows menu to run the app, build the installer or the portable version, publish a release and clean up GitHub Actions artifacts.

The `.github/workflows/ci.yml` workflow runs on every push (any branch) and PR, on Linux and Windows, with Node 24: it installs FFmpeg (without it the media tests are skipped), runs `npm ci`, `check`, `lint` and `test`, checks the license list (`node scripts/generate-licenses.js --check`, on Windows) and, in a separate job, `npm audit --omit=dev --audit-level=high`. The release workflows run `check`, `lint` and `test` (the license list and the audit only run in CI) and `verify:package -- --release` before building.

## 🚢 Version and Release

A release comes from a **version tag** `vX.Y.Z` whose commit is on `main`. Pushing to `main` only runs CI.

```bash
node scripts/release-tag.js            # suggests the next version
node scripts/release-tag.js 1.0.8      # explicit version
node scripts/release-tag.js --dry-run  # only shows what it would do (--yes skips the confirmation)
```

The script checks that you are on `main` with everything committed and in sync, refuses a tag that already exists (locally or on the remote), updates `package.json` and `package-lock.json`, creates the annotated tag and pushes it. The **Release BDS (Windows + Linux)** workflow (`release-bds.yml`) then:

1. builds Windows and Linux, after passing `check`, `lint` and `test`;
2. signs the Windows installer on SignPath only on a tag and when the SignPath token and organization ID are configured (without them the installer ships unsigned); a tag whose commit is not on `main` makes the workflow fail, and a manual run never signs (see the [signing policy](CODE_SIGNING_POLICY.md));
3. publishes a single Release, with `SHA256SUMS.txt` and the notes: the installer's SHA-256 and the **Mudanças** (Changes) section, with the title of each commit since the previous tag. That is why it pays to write the commit title as a sentence the user understands.

The same workflow can be run by hand (without a tag): it takes the next free version and makes a `chore(release): vX.Y.Z [skip release]` commit on `main`. The `build-bds-release.yml` (Windows only), `build-bds-linux.yml` (Linux only, with a launch test via Xvfb) and `release-sign.yml` workflows are run manually; production signing runs inside `release-bds.yml`.

For forks: the Release is published to the `RELEASES_REPO` repository using the repository's own token (`GITHUB_TOKEN`, no extra secret); signing requires the secret `SIGNPATH_API_TOKEN` and the variable `SIGNPATH_ORGANIZATION_ID` (optional: the variables `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY`).

The Release files follow a single pattern, which the built-in updater looks for (the 2 releases after 1.1.1 also ship copies with the old names, each with a `.sha256`, for the updater transition):

| File | What it is |
|---|---|
| `braga-digital-studio-<version>-windows-x64.exe` | Windows installer (what the updater downloads) |
| `braga-digital-studio-<version>-windows-x64-portable.zip` | Windows portable version |
| `braga-digital-studio-<version>-linux-x86_64.AppImage` | Linux, no install needed |
| `braga-digital-studio-<version>-linux-x86_64.deb` | Linux (Debian/Ubuntu) |

## 🤝 How to contribute

Issues and pull requests are welcome. Before opening a PR, run `npm run check`, `npm run lint` and `npm test`. By contributing, you agree that your contribution is distributed under the same license (GPL v3). Security flaws go through the [Security Policy](SECURITY.md), not a public issue.

## 🧩 Modules

Each BDS feature is a module with a switch in *Settings → Modules*. On a fresh install only the AI Assistant is turned on (the full install also turns on Transcription); existing users keep what they chose. Remove silence is not a module: it lives inside Projects. Heavy features, such as **Transcription** (whisper.cpp engine, models and NVIDIA GPU DLLs) and the **local AI model** (`llama-server` and the model chosen by the graphics card's memory), are downloaded on demand, with SHA-256 verification, to `<dataDir>/modules`. Code in `src/core/modules/`, IPC in `src/ipc/moduleHandlers.js`, panel in `renderer/components/modules-panel.js`. Details in [`src/core/modules/README.md`](src/core/modules/README.md).

The Recovery and Montage screens are in development and do not appear in the installed app.

## 🗂️ Folder Structure

```
main.js, preload.js      Main process and secure bridge (IPC); preload is generated
src/bootstrap/           Startup, services, shutdown and the bridge to the renderer
src/core/                Business rules (media, library, devices, modules, database in database/...)
src/infrastructure/      External tools, filesystem, hardware, network and telemetry
src/ipc/                 IPC handlers, channel table and input validation
src/services/            Application services (downloads, conversion, AI assistant...)
src/setup/               Windowless mode used by the installer (--setup-components)
src/config/              Versioned configuration (modules, updates, third-party licenses)
renderer/                Interface (vanilla JS, ES modules; fonts in renderer/assets/fonts)
installer/               NSIS script and installer images
config/                  Local configuration (ignored); use the *.example.json files as templates
data/, database/, logs/  Local data in development (ignored)
assets/                  App icons and third-party license file
scripts/, tests/         Maintenance scripts and automated tests
.github/workflows/       CI and release
```

## 🔒 Privacy and Data

All data the program generates (library, settings, history, thumbnails) stays on your computer, in a local folder (`AppData`). The program **has no telemetry**, requires no account and does not send your library or your files to the author. AI server keys and phone pairing tokens are stored encrypted by the system (DPAPI on Windows) and are never shown back; if the system offers no encryption (for example, Linux without a keyring), the key is not stored.

Crash reports are written only to your computer, without e-mails or long keys (including in the last 30 log lines they carry), and deleted after 30 days. Nothing is sent automatically, unless you configure an https address or send a manual report. The download and conversion history is deleted after 180 days. The assistant's conversation keeps up to 80 messages (older ones become a summary; at most 40 go to the model) and can be cleared in the chat.

What accesses the internet: checking for and downloading updates (GitHub), the tools and models (each project's public releases and Hugging Face), the sites you ask to download from and, **if you choose**, the cloud: the configured AI server, cloud transcription (the audio goes to the chosen provider: Groq, OpenAI or ElevenLabs) and AI transcript analysis (the transcript text goes to the AI server). With any of them, the content sent leaves your computer; that is why the app warns you before the first time. On the local network, the app looks for Sony cameras (SSDP) and the BDS phone (mDNS).

The MCP server is off by default. When on, it listens only on 127.0.0.1 (if the port is taken, it uses another free one), checks the Host, refuses connections coming from a browser and requires a random 256-bit token, generated when it is turned on and stored in your user folder. "No token" and "actions without confirmation" are optional and cannot be on at the same time.

No sensitive information is saved in this repository: database, caches, logs, `data` folders and authentication sessions are blocked by the `.gitignore` rules.

Found a security flaw? See the [Security Policy](SECURITY.md) and report it privately, not in a public issue.

## ⚖️ Copyright and responsible use

BDS downloads the videos and audio that **you** ask for, from sites the program does not control; the content still belongs to whoever holds the rights. Only download what you have the right to download (your own content, freely licensed content or content you have permission for): respecting copyright and each site's terms is the downloader's responsibility. Music from streaming services is for personal use; using it as the soundtrack of a published video requires a license. The same goes for uploading to YouTube: only publish what you have the right to publish, paying attention to third-party music and images.

## 📄 License

Copyright © 2026 **Mauro Braga**. Free software under the [GNU GPL v3.0](LICENSE): you may use, study, modify and redistribute it, as long as you keep the same license and the source code open. Third-party components follow their own licenses (see *Settings → About and licenses*).

Windows installer signing (when signed): [Code Signing Policy](CODE_SIGNING_POLICY.md) — free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).
