'use strict';

/**
 * redact — remoção de dados pessoais/sensíveis de textos e objetos antes de logar, gravar
 * relatórios de erro ou enviá-los para fora da máquina.
 *
 * Remove/substitui:
 *  - diretório do usuário (os.homedir(), %USERPROFILE%, C:\Users\<nome>, /home/<nome>, /Users/<nome>)
 *  - query strings (e fragmentos) de URLs http(s)
 *  - tokens "Bearer ...", cabeçalhos Authorization
 *  - e-mails (exceto o do desenvolvedor)
 *  - cookie=..., set-cookie: ...
 *  - pares chave=valor de segredos (token, api_key, password, secret ...)
 *  - chaves longas (>= 32 caracteres alfanuméricos, exceto hashes hexadecimais — SHA-256 etc.
 *    não são segredos e ajudam no diagnóstico)
 */

const os = require('node:os');

let developerEmail = '';
try { developerEmail = String(require('../config/appInfo').DEVELOPER_EMAIL || '').toLowerCase(); } catch (_) { /* sem appInfo */ }

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Variantes do diretório home (com \ e /), da mais longa para a mais curta. */
function homeDirVariants() {
  const raw = new Set();
  const add = (p) => { if (p && String(p).length > 3) raw.add(String(p)); };
  try { add(os.homedir()); } catch (_) { /* noop */ }
  add(process.env.USERPROFILE);
  add(process.env.HOME);
  const out = new Set();
  for (const p of raw) {
    out.add(p);
    out.add(p.replace(/\\/g, '/'));
    out.add(p.replace(/\//g, '\\'));
    out.add(p.replace(/\\/g, '\\\\')); // forma escapada em JSON
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} input
 * @returns {string} texto sem dados sensíveis (não-strings são convertidas com String())
 */
function redact(input) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  if (!text) return text;

  // 1) diretório home exato
  for (const variant of homeDirVariants()) {
    text = text.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  // 2) padrões genéricos de pasta de usuário (outras contas/máquinas, caminhos em stacks)
  text = text
    .replace(/([a-zA-Z]:[\\/]+Users[\\/]+)[^\\/\s"'<>|:*?]+/gi, '$1<user>')
    .replace(/(\/(?:home|Users)\/)[^/\s"'<>|:]+/g, '$1<user>');

  // 3) query string e fragmento de URLs
  text = text.replace(/(https?:\/\/[^\s"'<>?#`]+)[?#][^\s"'<>`]*/gi, '$1?[redacted]');

  // 4) Authorization / Bearer
  text = text
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');

  // 5) cookies
  text = text.replace(/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\r\n]*/gi, '$1[redacted]');

  // 6) segredos chave=valor
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1[redacted]'
  );

  // 7) e-mails (exceto o do desenvolvedor)
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) => (
    developerEmail && m.toLowerCase() === developerEmail ? m : '[email]'
  ));

  // 8) chaves longas (não mexe em hashes hexadecimais)
  text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[0-9a-f]+$/i.test(m) ? m : '[redacted-key]'));

  return text;
}

/**
 * Cópia profunda de `value` com todas as strings passadas por redact().
 * Erros viram objetos simples (name/message/stack). Profundidade limitada (ciclos seguros).
 */
function redactDeep(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack || '') };
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = redactDeep(value[key], depth + 1);
  }
  return out;
}

module.exports = { redact, redactDeep };
