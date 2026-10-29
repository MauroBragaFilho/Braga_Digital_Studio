'use strict';

const { dependencyManager } = require('../../infrastructure/external-tools/DependencyManager');
const { processRunner } = require('../../infrastructure/external-tools/ProcessRunner');

/**
 * Confere se uma imagem decodifica de verdade, usando o motor de mídia.
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, decoded: boolean, message: string}|null>} null = não foi possível verificar (motor ausente).
 *   `ok` = decodificou sem nenhum aviso; `decoded` = decodificou (pode haver avisos, como imagem cortada).
 */
async function decodeCheck(filePath) {
  let exe;
  try {
    if (!dependencyManager.isAvailable('mediaEngine')) return null;
    exe = dependencyManager.resolveComponent('mediaEngine');
  } catch (_) {
    return null;
  }

  return new Promise((resolve) => {
    const child = processRunner.spawn(exe, ['-v', 'error', '-nostdin', '-i', filePath, '-frames:v', '1', '-f', 'null', '-']);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; processRunner.cancel(child); }, 60000);
    if (timer.unref) timer.unref();
    child.stdout.resume();
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2048); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      const message = stderr.trim();
      resolve({ ok: code === 0 && message === '', decoded: code === 0, message });
    });
  });
}

module.exports = { decodeCheck };
