'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Resolve um executável do sistema Windows para o caminho absoluto em %SystemRoot%\System32
 * (evita que um powershell.exe/reg.exe/taskkill.exe plantado no diretório de trabalho ou no PATH
 * seja executado no lugar do original). Fora do Windows, ou se o arquivo não existir, devolve o nome.
 *
 * @param {string} name - 'powershell', 'reg', 'taskkill'...
 * @returns {string}
 */
function systemExe(name) {
  if (process.platform !== 'win32') return name;
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) return name;
  const base = /\.exe$/i.test(name) ? name : `${name}.exe`;
  const full = base.toLowerCase() === 'powershell.exe'
    ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', base)
    : path.join(root, 'System32', base);
  try { return fs.existsSync(full) ? full : name; } catch (_) { return name; }
}

module.exports = { systemExe };
