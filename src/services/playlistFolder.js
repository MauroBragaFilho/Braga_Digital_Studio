'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const logger = require('./logService');

const ICON_NAME = '.capa-da-playlist.ico';
const COVER_TIMEOUT_MS = 20000;

/** Nome da playlist -> nome de pasta válido no Windows (sem caracteres proibidos, ponto/espaço no fim, nomes reservados). */
function folderNameFor(title) {
  let name = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/g, '');
  if (!name) return '';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `${name}_`;
  return name;
}

function run(exe, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Avisa o Explorer que a pasta mudou (SHChangeNotify), para o ícone novo aparecer sem esperar o cache. Melhor esforço. */
function notifyExplorer(folder) {
  const script = [
    "Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"shell32.dll\", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string a, IntPtr b);'",
    '$p = $env:BDS_FOLDER',
    '[W.N]::SHChangeNotify(0x2000, 0x5, $p, [IntPtr]::Zero)', // SHCNE_UPDATEITEM (pasta)
    '[W.N]::SHChangeNotify(0x1000, 0x5, $p, [IntPtr]::Zero)'  // SHCNE_UPDATEDIR (conteúdo)
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, env: { ...process.env, BDS_FOLDER: folder } }, () => resolve());
  });
}

async function fetchCover(url, dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dá à pasta o ícone da capa da playlist (Windows: desktop.ini + .ico, pasta marcada como somente leitura).
 * Melhor esforço: nunca lança; sem capa, sem ffmpeg ou com um desktop.ini já existente, a pasta fica como está.
 * @returns {Promise<boolean>} true se o ícone foi aplicado
 */
async function applyCoverIcon(folder, coverUrl, ffmpegExe) {
  if (process.platform !== 'win32' || !folder || !/^https?:\/\//i.test(String(coverUrl || ''))) return false;
  const ini = path.join(folder, 'desktop.ini');
  const icon = path.join(folder, ICON_NAME);
  const tmp = path.join(folder, '.capa-da-playlist.tmp');
  let createdIni = false;
  try {
    if (fs.existsSync(ini) || !ffmpegExe || !fs.existsSync(ffmpegExe)) return false;
    await fetchCover(coverUrl, tmp);
    await run(ffmpegExe, [
      '-y', '-loglevel', 'error', '-i', tmp,
      '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=256:256",
      '-frames:v', '1', icon
    ]);
    fs.writeFileSync(ini, `[.ShellClassInfo]\r\nIconResource=${ICON_NAME},0\r\n`, 'utf8');
    createdIni = true;
    await run('attrib', ['+s', '+h', ini]);
    await run('attrib', ['+s', '+h', icon]);
    await run('attrib', ['+r', folder]);
    await notifyExplorer(folder);
    return true;
  } catch (err) {
    logger.warn('[PlaylistFolder] Ícone da pasta não aplicado', { folder, error: err && err.message });
    // Só apaga o que esta chamada criou (o desktop.ini já existente de outra origem nunca é tocado)
    if (createdIni) { try { fs.unlinkSync(ini); } catch (_) { /* melhor esforço */ } }
    try { fs.unlinkSync(icon); } catch (_) { /* pode não existir */ }
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* já não existe */ }
  }
}

module.exports = { folderNameFor, applyCoverIcon, ICON_NAME };
