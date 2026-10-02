'use strict';

/**
 * thumbProtocol.js — Resolução segura de requisições bds-thumb://<caminho-absoluto>.
 *
 * Função pura (sem Electron) para poder ser testada com node. O main.js a usa dentro de
 * protocol.handle('bds-thumb', ...). Só serve imagens dentro de diretórios permitidos
 * (miniaturas, capas e previews de fotos); bloqueia UNC, traversal e extensões não-imagem.
 */

const path = require('node:path');
const { realpathLoose, __internal: { isInside } } = require('./validate');

const SCHEME = 'bds-thumb://';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

/**
 * @param {string} requestUrl URL completa da requisição (bds-thumb://C:/...)
 * @param {string[]} allowedDirs diretórios permitidos (absolutos)
 * @returns {{ ok: true, filePath: string } | { ok: false, status: number, reason: string }}
 */
function resolveThumbRequest(requestUrl, allowedDirs) {
  if (typeof requestUrl !== 'string' || !requestUrl.startsWith(SCHEME)) {
    return { ok: false, status: 400, reason: 'URL inválida' };
  }

  let raw = requestUrl.slice(SCHEME.length);
  // Remove query/fragmento (cache-busting como ?t=123) antes de decodificar
  raw = raw.split(/[?#]/)[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch (_) {
    return { ok: false, status: 400, reason: 'Codificação inválida' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, reason: 'Caminho inválido' };

  // UNC (\\servidor\share ou //servidor/share) — nunca permitido
  if (/^[\\/]{2,}/.test(decoded)) return { ok: false, status: 403, reason: 'Caminho UNC bloqueado' };
  // bds-thumb:///C:/x → remove a barra inicial antes da letra do drive
  decoded = decoded.replace(/^[\\/](?=[a-zA-Z]:)/, '');

  const filePath = path.resolve(decoded.replace(/\//g, path.sep));
  if (!path.isAbsolute(decoded.replace(/\//g, path.sep))) {
    return { ok: false, status: 403, reason: 'Caminho não absoluto' };
  }
  if (!IMAGE_EXTS.has(path.extname(filePath).toLowerCase())) {
    return { ok: false, status: 403, reason: 'Extensão não permitida' };
  }

  const dirs = (allowedDirs || []).filter((d) => typeof d === 'string' && d);
  const realTarget = realpathLoose(filePath);
  const allowed = dirs.some((d) => isInside(path.resolve(d), filePath) && isInside(realpathLoose(d), realTarget));
  if (!allowed) return { ok: false, status: 403, reason: 'Fora dos diretórios permitidos' };

  return { ok: true, filePath };
}

module.exports = { resolveThumbRequest, IMAGE_EXTS };
