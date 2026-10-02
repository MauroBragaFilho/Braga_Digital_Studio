'use strict';

/**
 * urlValidator — validador único de URLs http(s) para tudo que vai parar na linha de comando
 * do yt-dlp/spotdl (downloadService, thumbnailService, metadataService).
 *
 * Aceita apenas http: e https:, sem credenciais embutidas e com tamanho limitado. Como a URL é
 * sempre normalizada por `new URL()`, ela nunca começa com "-" (não vira opção do yt-dlp);
 * mesmo assim os chamadores devem inserir '--' antes dela nos argumentos.
 */

const MAX_URL_LENGTH = 2048;
const DEFAULT_MESSAGE = 'Informe uma URL válida.';

/** @returns {URL|null} */
function parseHttpUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let parsed;
  try { parsed = new URL(text); } catch (_) { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  return parsed;
}

/** @returns {boolean} */
function isHttpUrl(input) {
  return parseHttpUrl(input) !== null;
}

/**
 * Valida e devolve a URL normalizada (string).
 * @throws {Error} 'Informe uma URL válida.' se não for http(s) válida
 */
function assertHttpUrl(input, message = DEFAULT_MESSAGE) {
  const parsed = parseHttpUrl(input);
  if (!parsed) throw new Error(message);
  return parsed.toString();
}

/** URL sem query string, fragmento e credenciais — para logs (a query pode carregar tokens). */
function redactUrl(input) {
  try {
    const p = new URL(String(input));
    return `${p.protocol}//${p.host}${p.pathname}`;
  } catch (_) {
    return '(url inválida)';
  }
}

module.exports = { parseHttpUrl, isHttpUrl, assertHttpUrl, redactUrl, MAX_URL_LENGTH };
