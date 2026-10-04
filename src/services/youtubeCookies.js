'use strict';

/**
 * youtubeCookies.js — confere se um arquivo de cookies (formato Netscape) tem uma sessão do YouTube/Google
 * ainda válida e decide se ele deve ser entregue ao yt-dlp para um determinado link.
 *
 * Regras:
 *  - "válido" = existe ao menos um cookie de autenticação da conta (SID, __Secure-1PSID/3PSID, LOGIN_INFO…)
 *    que não expirou. Cookies só de rastreamento/consentimento não contam como sessão.
 *  - o arquivo só é usado em links do YouTube: nunca é enviado a outros sites.
 * O conteúdo do arquivo nunca é logado.
 */

const fs = require('node:fs');

/** Cookies que indicam uma conta logada. */
const AUTH_COOKIES = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']);

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function isYouTubeUrl(url) {
  try { return YOUTUBE_HOSTS.test(new URL(String(url)).hostname); } catch (_) { return false; }
}

const cache = new Map(); // arquivo -> { mtimeMs, size, info }

/**
 * @param {string|null|undefined} file
 * @param {number} [nowMs]
 * @returns {{valid:boolean, expiresAt:number|null, reason:string|null}}
 */
function inspectCookiesFile(file, nowMs = Date.now()) {
  if (!file || typeof file !== 'string') return { valid: false, expiresAt: null, reason: 'sem arquivo' };
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return { valid: false, expiresAt: null, reason: 'arquivo não existe' }; }
  if (!stat.isFile() || stat.size === 0 || stat.size > 5 * 1024 * 1024) return { valid: false, expiresAt: null, reason: 'arquivo inválido' };

  const cached = cache.get(file);
  let parsed;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    parsed = cached.parsed;
  } else {
    parsed = [];
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { valid: false, expiresAt: null, reason: 'não foi possível ler' }; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
      if (!line || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 7) continue;
      const domain = f[0].toLowerCase();
      const bare = domain.replace(/^\./, '');
      if (!/(^|\.)(youtube\.com|google\.com)$/.test(bare)) continue;
      if (!AUTH_COOKIES.has(f[5])) continue;
      parsed.push({ name: f[5], expiry: Number(f[4]) || 0 }); // 0 = cookie de sessão (sem data)
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  }

  const nowSec = Math.floor(nowMs / 1000);
  const alive = parsed.filter((c) => c.expiry === 0 || c.expiry > nowSec);
  if (!alive.length) return { valid: false, expiresAt: null, reason: parsed.length ? 'sessão expirada' : 'sem sessão da conta' };
  // A sessão vale até o último cookie de conta com data; sem data (cookie de sessão) fica sem previsão
  const dated = alive.filter((c) => c.expiry > 0).map((c) => c.expiry);
  return { valid: true, expiresAt: dated.length ? Math.max(...dated) * 1000 : null, reason: null };
}

/**
 * Caminho do arquivo de cookies a entregar ao yt-dlp para `url`, ou null (link de outro site, arquivo
 * ausente ou sessão expirada).
 */
function cookiesFileFor(url, file) {
  if (!isYouTubeUrl(url)) return null;
  return inspectCookiesFile(file).valid ? file : null;
}

module.exports = { isYouTubeUrl, inspectCookiesFile, cookiesFileFor, AUTH_COOKIES };
