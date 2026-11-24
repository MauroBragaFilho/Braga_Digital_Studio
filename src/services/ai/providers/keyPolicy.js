'use strict';

/**
 * keyPolicy: única fonte das regras sobre ONDE a chave de API pode ser enviada e COMO normalizar o endereço digitado.
 * Sem rede e sem estado. Usado pelo OpenAIProvider (_headers) e pela descoberta de modelos.
 *
 *  - isLoopbackHost: regra ESTRITA, só a própria máquina (localhost, *.localhost, 127.0.0.0/8, ::1). Rede local (LAN) NÃO conta:
 *    a chave nunca vai por http:// para outro computador, nem da mesma casa.
 *  - isPrivateHost: própria máquina OU rede local (10.x, 172.16-31.x, 192.168.x, link-local, nome sem ponto, .local/.lan...).
 *    É a regra única do aviso de servidor externo (AIService.isLocalOrLanHost aponta para esta função; serve para decidir esquema padrão e aviso de servidor externo, nunca para liberar chave).
 *  - assertKeyAllowed: recusa chave por http:// fora do loopback.
 *  - normalizeUserUrl: endereço digitado pelo usuário -> base http(s) limpa.
 */

const hostOnly = (host) => String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');

/** Só a própria máquina: localhost, *.localhost, 127.0.0.0/8 e ::1. */
function isLoopbackHost(host) {
  const h = hostOnly(host);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const v4 = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(v4) && v4.slice(1).every((part) => Number(part) <= 255);
}

/** Própria máquina ou rede local (não é "internet"). */
function isPrivateHost(host) {
  const h = hostOnly(host);
  if (!h) return false;
  if (isLoopbackHost(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(h); // link-local e ULA do IPv6
  if (!h.includes('.')) return true; // nome de máquina da rede local
  return /\.(local|lan|home\.arpa|internal)$/.test(h);
}

const policyError = (code, message) => Object.assign(new Error(message), { code });

/**
 * Garante que a chave pode ir a este endereço. Sem chave, tudo é permitido. Com chave, http:// só no loopback.
 * @param {string|URL} url
 * @param {string} key
 * @returns {true}
 * @throws Error com code 'KEY_INSECURE' (http:// com chave fora do loopback) ou 'BAD_URL'
 */
function assertKeyAllowed(url, key) {
  if (!key) return true;
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url)); }
  catch (_) { throw policyError('BAD_URL', 'O endereço do servidor é inválido.'); }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    if (isLoopbackHost(parsed.hostname)) return true;
    throw policyError('KEY_INSECURE', 'Por segurança, a chave de API não é enviada por http:// a servidores remotos. Use https://.');
  }
  throw policyError('BAD_URL', 'A URL do servidor deve começar com http:// ou https://.');
}

/**
 * Endereço digitado pelo usuário -> base normalizada (origem + caminho sem barra final; caminho vazio vira /v1).
 *  - vazio: BAD_URL antes de qualquer normalização (nada de cair num endereço padrão);
 *  - sem esquema: https:// (ou http:// quando o host é a própria máquina ou da rede local);
 *  - recusa usuário/senha na URL e esquemas que não sejam http/https; descarta ?consulta e #trecho.
 * @throws Error com code 'BAD_URL'
 */
function normalizeUserUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw policyError('BAD_URL', 'Informe o endereço do servidor.');
  let text = raw.trim();
  if (text.length > 2048 || /[\x00-\x20\x7f\\]/.test(text) || text.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\/\//i.test(text)) {
    throw policyError('BAD_URL', 'O endereço do servidor é inválido.');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let probe;
    try { probe = new URL(`http://${text}`); }
    catch (_) { throw policyError('BAD_URL', 'O endereço do servidor é inválido.'); }
    text = `${isPrivateHost(probe.hostname) ? 'http' : 'https'}://${text}`;
  }
  let url;
  try { url = new URL(text); }
  catch (_) { throw policyError('BAD_URL', 'O endereço do servidor é inválido.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw policyError('BAD_URL', 'A URL do servidor deve começar com http:// ou https://.');
  if (url.username || url.password) throw policyError('BAD_URL', 'A URL não deve conter usuário ou senha.');
  if (!url.hostname) throw policyError('BAD_URL', 'O endereço do servidor é inválido.');
  const pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.origin + pathname;
}

module.exports = { isLoopbackHost, isPrivateHost, assertKeyAllowed, normalizeUserUrl };
