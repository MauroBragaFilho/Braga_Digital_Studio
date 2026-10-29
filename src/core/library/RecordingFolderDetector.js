'use strict';

/**
 * RecordingFolderDetector — descobre sozinho onde o OBS Studio e o NVIDIA App (ShadowPlay) gravam, para o BDS
 * cadastrar as bibliotecas sem o usuário apontar a pasta.
 *
 * OBS Studio: lê a configuração do próprio OBS (nada é executado).
 *   - <config>/user.ini (OBS 31+) ou <config>/global.ini (antigos): [Basic] ProfileDir = perfil ativo
 *   - <config>/basic/profiles/<perfil>/basic.ini: [Output] Mode = Simple | Advanced
 *       Simple   -> [SimpleOutput] FilePath
 *       Advanced -> [AdvOut] RecType = Standard -> RecFilePath | FFmpeg -> FFFilePath
 *   <config> = %APPDATA%\obs-studio (Windows), ~/.config/obs-studio ou o do Flatpak (Linux),
 *              ~/Library/Application Support/obs-studio (macOS). O OBS em modo portátil guarda a configuração
 *              ao lado do executável e não é detectado: fica o campo manual.
 *
 * NVIDIA App / ShadowPlay (só Windows):
 *   1. registro HKCU\Software\NVIDIA Corporation\Global\ShadowPlay\NVSPCAPS, valor DefaultPathW (REG_BINARY, UTF-16);
 *   2. reserva: %LOCALAPPDATA%\NVIDIA Corporation\NVIDIA Overlay\GallerySettings.json -> currentDirectoryV2.
 *
 * Tudo é injetável (pastas, leitura de arquivo, existência, execução do reg.exe) para os testes rodarem em
 * qualquer sistema com arquivos de exemplo.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** INI simples (seções, chave=valor; `;` e `#` são comentários). Valores do OBS trazem `\\` no lugar de `\`. */
function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); out[section] = out[section] || {}; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (out[section] = out[section] || {})[key] = value;
  }
  return out;
}

/** Caminho como o OBS escreve ("C:\\Users\\x" ou "D:/REC") -> caminho normal do sistema. */
function normalizeObsPath(value) {
  if (!value) return '';
  const unescaped = String(value).replace(/\\\\/g, '\\').trim();
  return path.normalize(unescaped).replace(/[\\/]+$/, '');
}

/** Pastas de configuração do OBS candidatas para o sistema (só as que existem contam). */
function obsConfigDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obs-studio')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'obs-studio')];
  return [
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-studio'),
    path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio')
  ];
}

/** Pasta de gravação de um basic.ini já lido, conforme o modo de saída. */
function recordingPathFromProfile(ini) {
  const mode = String(ini.Output?.Mode || 'Simple');
  if (/^advanced$/i.test(mode)) {
    const adv = ini.AdvOut || {};
    const ffmpeg = /^ffmpeg$/i.test(String(adv.RecType || ''));
    return { mode: 'Advanced', path: normalizeObsPath(ffmpeg ? adv.FFFilePath : adv.RecFilePath) };
  }
  return { mode: 'Simple', path: normalizeObsPath(ini.SimpleOutput?.FilePath) };
}

/**
 * @param {{ configDirs?: string[], readFile?: Function, exists?: Function, listDir?: Function }} [opts]
 * @returns {{ configDir: string|null, activeProfile: string|null, profiles: Array<{profile:string, dir:string, path:string, mode:string, active:boolean}> }}
 */
function detectObs(opts = {}) {
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const listDir = opts.listDir || ((p) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  const dirs = opts.configDirs || obsConfigDirs();
  const configDir = dirs.find((d) => exists(path.join(d, 'basic', 'profiles'))) || null;
  const result = { configDir, activeProfile: null, profiles: [] };
  if (!configDir) return result;

  // Perfil ativo: user.ini (OBS 31+) tem prioridade sobre global.ini
  for (const name of ['user.ini', 'global.ini']) {
    const file = path.join(configDir, name);
    if (!exists(file)) continue;
    let ini;
    try { ini = parseIni(readFile(file)); } catch (_) { continue; }
    const basic = ini.Basic || {};
    if (basic.ProfileDir || basic.Profile) { result.activeProfile = basic.ProfileDir || basic.Profile; break; }
  }

  const profilesDir = path.join(configDir, 'basic', 'profiles');
  let names = [];
  try { names = listDir(profilesDir); } catch (_) { names = []; }
  const found = [];
  for (const dir of names) {
    const file = path.join(profilesDir, dir, 'basic.ini');
    if (!exists(file)) continue;
    let ini;
    try { ini = parseIni(readFile(file)); } catch (_) { continue; }
    const { mode, path: recPath } = recordingPathFromProfile(ini);
    if (!recPath || !exists(recPath)) continue;
    const named = Boolean(ini.General?.Name);
    found.push({
      profile: String(ini.General?.Name || dir),
      dir,
      path: recPath,
      mode,
      named,
      active: result.activeProfile != null && (dir === result.activeProfile || ini.General?.Name === result.activeProfile)
    });
  }
  // Dois perfis na mesma pasta = uma biblioteca só: fica o ativo; senão o que tem nome próprio; senão o primeiro por nome
  found.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.named) - Number(a.named) || a.profile.localeCompare(b.profile));
  const seen = new Set();
  for (const p of found) {
    const key = process.platform === 'win32' ? p.path.toLowerCase() : p.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const { named: _named, ...entry } = p;
    result.profiles.push(entry);
  }
  result.profiles.sort((a, b) => Number(b.active) - Number(a.active) || a.profile.localeCompare(b.profile));
  return result;
}

/** Saída de `reg query ... /v DefaultPathW` -> caminho (o valor é REG_BINARY com texto UTF-16 LE). */
function decodeRegBinaryUtf16(regOutput) {
  const m = String(regOutput || '').match(/REG_BINARY\s+([0-9A-Fa-f]+)/);
  if (!m) return '';
  const text = Buffer.from(m[1], 'hex').toString('utf16le').replace(/\0+$/, '');
  return text.trim();
}

function regQuery(key, valueName) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/v', valueName], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/**
 * @param {{ platform?: string, regQuery?: Function, readFile?: Function, exists?: Function, localAppData?: string }} [opts]
 * @returns {Promise<{ path: string, source: 'registry'|'gallery' }|null>}
 */
async function detectShadowPlay(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const query = opts.regQuery || regQuery;

  const fromRegistry = decodeRegBinaryUtf16(await query('HKCU\\Software\\NVIDIA Corporation\\Global\\ShadowPlay\\NVSPCAPS', 'DefaultPathW'));
  if (fromRegistry && exists(fromRegistry)) return { path: path.normalize(fromRegistry).replace(/[\\/]+$/, ''), source: 'registry' };

  const localAppData = opts.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const gallery = path.join(localAppData, 'NVIDIA Corporation', 'NVIDIA Overlay', 'GallerySettings.json');
  if (exists(gallery)) {
    try {
      const data = JSON.parse(readFile(gallery));
      const dir = String(data.currentDirectoryV2 || data.currentDirectory || '').replace(/[\\/]+$/, '');
      if (dir && exists(dir)) return { path: path.normalize(dir), source: 'gallery' };
    } catch (_) { /* arquivo inválido: sem detecção */ }
  }
  return null;
}

/**
 * Detecção completa, com cache do último resultado (lido por syncLibraries e pela tela de Configurações).
 */
class RecordingFolderDetector {
  constructor() {
    this.last = { obs: { configDir: null, activeProfile: null, profiles: [] }, shadowplay: null, at: 0 };
  }

  async refresh(opts = {}) {
    let obs = { configDir: null, activeProfile: null, profiles: [] };
    try { obs = detectObs(opts.obs); } catch (_) { /* sem OBS */ }
    let shadowplay = null;
    try { shadowplay = await detectShadowPlay(opts.shadowplay); } catch (_) { /* sem NVIDIA */ }
    this.last = { obs, shadowplay, at: Date.now() };
    return this.last;
  }

  /** Observa a configuração do OBS: ao trocar de perfil ou de pasta, `onChange()` roda (com debounce). */
  watchObs(onChange, { debounceMs = 2000 } = {}) {
    const dir = this.last.obs.configDir || obsConfigDirs().find((d) => fs.existsSync(d));
    if (!dir) return () => {};
    let timer = null;
    const watchers = [];
    const trigger = () => { clearTimeout(timer); timer = setTimeout(() => { try { onChange(); } catch (_) { /* ouvinte */ } }, debounceMs); };
    for (const target of [dir, path.join(dir, 'basic', 'profiles')]) {
      try {
        const w = fs.watch(target, { recursive: target !== dir }, (_event, file) => {
          if (!file || /\.ini$/i.test(String(file))) trigger();
        });
        w.on('error', () => {});
        watchers.push(w);
      } catch (_) { /* pasta sem suporte a watch */ }
    }
    return () => { clearTimeout(timer); for (const w of watchers) { try { w.close(); } catch (_) { /* já fechado */ } } };
  }
}

const recordingFolderDetector = new RecordingFolderDetector();

module.exports = {
  recordingFolderDetector,
  RecordingFolderDetector,
  detectObs,
  detectShadowPlay,
  parseIni,
  normalizeObsPath,
  obsConfigDirs,
  recordingPathFromProfile,
  decodeRegBinaryUtf16
};
