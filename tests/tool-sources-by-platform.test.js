'use strict';

// Fontes oficiais por sistema/arquitetura (sem rede): tabela de ToolSources, whisper.cpp, limpeza de resíduos,
// remoção de instalação inválida e escolha do asset do app por sistema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasSource, resolveDownloadUrl, unavailableReason, ToolUnavailableError, componentFor } = require('../src/infrastructure/external-tools/ToolSources');
const { ToolUpdater } = require('../src/infrastructure/external-tools/ToolUpdater');
const { AppUpdateChecker } = require('../src/infrastructure/external-tools/AppUpdateChecker');
const { WhisperCppSource, WHISPER_CPP_RELEASE, unavailableReason: whisperReason } = require('../src/core/modules/sources');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-toolsrc-'));

test('Windows x64: todas as fontes existem e apontam para releases oficiais', () => {
  assert.match(resolveDownloadUrl('ytdlp', null, 'win32', 'x64'), /yt-dlp\/yt-dlp\/releases\/latest\/download\/yt-dlp\.exe$/);
  assert.match(resolveDownloadUrl('ffmpeg', null, 'win32', 'x64'), /BtbN\/FFmpeg-Builds.*win64-gpl\.zip$/);
  assert.match(resolveDownloadUrl('deno', null, 'win32', 'x64'), /denoland\/deno.*x86_64-pc-windows-msvc\.zip$/);
  assert.match(resolveDownloadUrl('spotdl', 'v4.5.2', 'win32', 'x64'), /spotdl-4\.5\.2-win32\.exe$/);
  assert.match(resolveDownloadUrl('untrunc', null, 'win32', 'x64'), /anthwlock\/untrunc.*untrunc_x64\.zip$/);
  assert.match(resolveDownloadUrl('exiftool', 'v13.50', 'win32', 'x64'), /ShareX\/ExifTool.*exiftool-13\.50-win64\.zip$/);
});

test('Linux x64 e arm64 recebem o asset da arquitetura certa', () => {
  assert.match(resolveDownloadUrl('ytdlp', null, 'linux', 'x64'), /yt-dlp_linux$/);
  assert.match(resolveDownloadUrl('ytdlp', null, 'linux', 'arm64'), /yt-dlp_linux_aarch64$/);
  assert.match(resolveDownloadUrl('ffmpeg', null, 'linux', 'x64'), /linux64-gpl\.tar\.xz$/);
  assert.match(resolveDownloadUrl('ffmpeg', null, 'linux', 'arm64'), /linuxarm64-gpl\.tar\.xz$/);
  assert.match(resolveDownloadUrl('deno', null, 'linux', 'arm64'), /aarch64-unknown-linux-gnu\.zip$/);
  assert.match(resolveDownloadUrl('spotdl', 'v4.5.2', 'linux', 'x64'), /spotdl-4\.5\.2-linux$/);
  assert.match(resolveDownloadUrl('exiftool', 'v13.50', 'linux', 'x64'), /exiftool\/exiftool\/archive\/refs\/tags\/v13\.50\.tar\.gz$/);
});

test('macOS: yt-dlp universal e deno por arquitetura; ffmpeg indisponível com orientação', () => {
  assert.match(resolveDownloadUrl('ytdlp', null, 'darwin', 'arm64'), /yt-dlp_macos$/);
  assert.match(resolveDownloadUrl('ytdlp', null, 'darwin', 'x64'), /yt-dlp_macos$/);
  assert.match(resolveDownloadUrl('deno', null, 'darwin', 'arm64'), /aarch64-apple-darwin\.zip$/);
  assert.match(resolveDownloadUrl('deno', null, 'darwin', 'x64'), /x86_64-apple-darwin\.zip$/);
  assert.equal(hasSource('ffmpeg', 'darwin', 'arm64'), false);
  assert.equal(hasSource('ffprobe', 'darwin', 'x64'), false);
  assert.throws(() => resolveDownloadUrl('ffmpeg', null, 'darwin', 'arm64'), (e) => {
    return e instanceof ToolUnavailableError && e.code === 'TOOL_UNAVAILABLE' && /macOS/.test(e.message) && /gerenciador de pacotes/.test(e.message) && /não publica/.test(e.message);
  });
});

test('combinação sem fonte oficial é "indisponível" (nunca baixa asset errado)', () => {
  for (const [tool, platform, arch] of [
    ['spotdl', 'linux', 'arm64'], ['spotdl', 'darwin', 'arm64'], ['untrunc', 'linux', 'x64'], ['untrunc', 'darwin', 'arm64'],
    ['untrunc', 'win32', 'arm64'], ['ffmpeg', 'win32', 'ia32'], ['deno', 'win32', 'ia32']
  ]) {
    assert.equal(hasSource(tool, platform, arch), false, `${tool} ${platform}-${arch}`);
    assert.throws(() => resolveDownloadUrl(tool, 'v1', platform, arch), (e) => e.code === 'TOOL_UNAVAILABLE', `${tool} ${platform}-${arch}`);
  }
  assert.match(unavailableReason('untrunc', 'linux', 'x64'), /ainda não está disponível neste sistema \(Linux, 64 bits \(x64\)\)/);
});

test('ffmpeg e ffprobe são um componente só (um download)', () => {
  assert.equal(componentFor('ffprobe'), 'ffmpeg');
  for (const [p, a] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    assert.equal(resolveDownloadUrl('ffprobe', null, p, a), resolveDownloadUrl('ffmpeg', null, p, a));
  }
});

test('ToolUpdater: _getConfig delega a URL para a tabela', () => {
  const u = new ToolUpdater();
  const cfg = u._getConfig('ytdlp');
  assert.equal(cfg.downloadUrl('2026.01.01'), resolveDownloadUrl('ytdlp', '2026.01.01', process.platform, process.arch));
});

test('whisper.cpp: Windows x64/arm64 e Linux x64/arm64 têm motor; macOS não; CUDA só no Windows x64', () => {
  const src = new WhisperCppSource();
  for (const [p, a] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const asset = src.asset('cpu', p, a);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.size > 0);
    assert.ok(asset.url.startsWith(`https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE.tag}/`));
  }
  assert.match(src.asset('cpu', 'linux', 'x64').name, /ubuntu-x64\.tar\.gz$/);
  assert.match(src.asset('cpu', 'linux', 'arm64').name, /ubuntu-arm64\.tar\.gz$/);
  assert.equal(src.hasAsset('cpu', 'darwin', 'arm64'), false);
  assert.equal(src.hasAsset('cuda', 'linux', 'x64'), false);
  assert.equal(src.hasAsset('cuda', 'win32', 'x64'), true);
  assert.throws(() => src.asset('cpu', 'darwin', 'arm64'), /não publica o motor para macOS/);
  assert.match(whisperReason('cpu', 'darwin', 'x64'), /^Transcrição ainda não disponível neste sistema: o projeto oficial não publica o motor para macOS/);
});

test('ToolUpdater.cleanupStaleResidue remove resíduos antigos e preserva os recentes e os backups', async () => {
  const dir = tmp();
  try {
    const u = new ToolUpdater();
    u._toolsDir = dir;
    const old = Date.now() - 5 * 3600 * 1000;
    const mk = (name, dirLike, when) => {
      const p = path.join(dir, name);
      if (dirLike) { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'x'), '1'); } else fs.writeFileSync(p, '1');
      fs.utimesSync(p, when / 1000, when / 1000);
    };
    mk('.staging_ffmpeg_1', true, old);
    mk('.preswap_ffmpeg.exe_2', false, old);
    mk('yt-dlp.exe.old_3', false, old);
    mk('.staging_ffmpeg_recente', true, Date.now());
    mk('.component-backups', true, old);
    mk('ffmpeg.exe', false, old);
    const removed = (await u.cleanupStaleResidue()).sort();
    assert.deepEqual(removed, ['.preswap_ffmpeg.exe_2', '.staging_ffmpeg_1', 'yt-dlp.exe.old_3']);
    assert.ok(fs.existsSync(path.join(dir, '.staging_ffmpeg_recente')));
    assert.ok(fs.existsSync(path.join(dir, '.component-backups')));
    assert.ok(fs.existsSync(path.join(dir, 'ffmpeg.exe')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_restorePreSwap: sem backup remove o binário inválido; com backup restaura', () => {
  const dir = tmp();
  try {
    const u = new ToolUpdater();
    const target = path.join(dir, 'tool.exe');
    fs.writeFileSync(target, 'quebrado');
    u._restorePreSwap(path.join(dir, 'nao-existe'), target);
    assert.equal(fs.existsSync(target), false);

    const backup = path.join(dir, 'bk');
    fs.writeFileSync(backup, 'bom');
    fs.writeFileSync(target, 'quebrado');
    u._restorePreSwap(backup, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'bom');

    // sem preswap, usa o backup persistido como reserva
    fs.writeFileSync(target, 'quebrado');
    u._restorePreSwap(path.join(dir, 'nao-existe'), target, backup);
    assert.equal(fs.readFileSync(target, 'utf8'), 'bom');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_persistPreviousAsBackup guarda a versão ANTERIOR (RK-072)', () => {
  const dir = tmp();
  try {
    const u = new ToolUpdater();
    u.init(dir);
    const pre = path.join(dir, '.preswap_tool.exe_1');
    fs.writeFileSync(pre, 'v1');
    u._persistPreviousAsBackup('ytdlp', 'tool.exe', pre, { version: '1.0', sha256: 'abc' });
    assert.equal(fs.readFileSync(u._backupPathFor('ytdlp', 'tool.exe'), 'utf8'), 'v1');
    assert.equal(u._readBackupInfo('ytdlp').version, '1.0');
    assert.equal(fs.existsSync(pre), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AppUpdateChecker escolhe o asset por sistema (Windows .exe; Linux deb/AppImage só informativo; macOS nenhum)', () => {
  const c = new AppUpdateChecker();
  const release = { assets: [
    { name: 'BragaDigitalStudioSetup.exe', browser_download_url: 'https://x/e.exe', digest: 'sha256:aa' },
    { name: 'BragaDigitalStudioSetup.deb', browser_download_url: 'https://x/d.deb', digest: 'sha256:bb' },
    { name: 'BragaDigitalStudioSetup.AppImage', browser_download_url: 'https://x/a.AppImage', digest: 'sha256:cc' }
  ] };
  const win = c._findPlatformAsset(release, 'win32');
  assert.equal(win.kind, 'installer');
  assert.equal(win.name, 'BragaDigitalStudioSetup.exe');
  const prev = process.env.APPIMAGE;
  delete process.env.APPIMAGE;
  const deb = c._findPlatformAsset(release, 'linux');
  assert.equal(deb.kind, 'manual');
  assert.equal(deb.name, 'BragaDigitalStudioSetup.deb');
  process.env.APPIMAGE = '/tmp/x.AppImage';
  assert.equal(c._findPlatformAsset(release, 'linux').name, 'BragaDigitalStudioSetup.AppImage');
  if (prev === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = prev;
  assert.equal(c._findPlatformAsset(release, 'darwin'), null);
});
