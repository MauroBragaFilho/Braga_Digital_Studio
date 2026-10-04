'use strict';

/**
 * ytdlpErrors — transforma a saída de erro do yt-dlp em mensagens curtas, em português,
 * seguras para exibir ao usuário (sem caminhos locais, sem despejar o stderr inteiro).
 */

const { maskEngineNames } = require('./engineNames');

const MAX_MESSAGE_LENGTH = 300;

/** Remove caminhos locais (Windows/POSIX) e o nome de usuário de uma mensagem. */
function stripLocalPaths(text) {
  return String(text || '')
    // C:\Users\fulano\... , D:\Projetos\... , \\servidor\share\...
    .replace(/(?:[a-zA-Z]:\\|\\\\)[^\s"'<>|]*/g, '<caminho>')
    // /home/fulano/..., /Users/fulano/..., /tmp/...
    .replace(/(?:^|(?<=[\s"'(]))\/(?:home|Users|tmp|var|opt|root)\/[^\s"'<>|]*/g, '<caminho>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Linhas "ERROR: ..." do stderr (sem o prefixo), na ordem em que apareceram. */
function extractErrorLines(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const m = /^\s*ERROR:\s*(.*)$/i.exec(raw);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/**
 * Padrões comuns do yt-dlp -> mensagem em português. A ordem importa (mais específico primeiro).
 */
const PATTERNS = [
  [/confirm you.{0,3}re not a bot|sign in to confirm you/i,
    'O YouTube pediu confirmação de que você não é um robô. Exporte os cookies do YouTube nas configurações (ou faça login) e tente novamente.'],
  [/sign in to confirm your age|age[- ]restricted|inappropriate for some users/i,
    'Este vídeo tem restrição de idade. Exporte os cookies do YouTube (conta logada) nas configurações e tente novamente.'],
  [/private video|video is private|this video is private/i,
    'Este vídeo é privado. Só o dono (ou quem recebeu acesso) consegue baixá-lo.'],
  [/http error 403|403: forbidden|error 403/i,
    'O servidor recusou o download (HTTP 403). Atualize os componentes em Configurações > Atualizações ou tente novamente mais tarde.'],
  [/http error 429|too many requests/i,
    'O servidor limitou os pedidos (HTTP 429). Aguarde alguns minutos e tente novamente.'],
  [/ffmpeg.*(not found|not installed|no such file)|ffprobe.*(not found|not installed)|(avconv|ffmpeg) (or|and) ffprobe/i,
    'O componente de mídia não foi encontrado. Instale ou atualize os componentes em Configurações > Atualizações.'],
  [/video unavailable|this video (is )?(not available|unavailable)|has been removed|no longer available|account associated with this video has been terminated|not available in your country|blocked it in your country|live event will begin|premieres in/i,
    'Este vídeo está indisponível (removido, bloqueado na sua região ou ainda não publicado).'],
  [/unsupported url/i,
    'Esta URL não é suportada pelo motor de download.'],
  [/requested format is not available|no video formats found/i,
    'O formato ou a qualidade solicitados não estão disponíveis para este vídeo. Tente outra qualidade.'],
  [/no space left on device|not enough space|disk full/i,
    'Sem espaço em disco na pasta de destino.'],
  [/unable to download (webpage|video data)|getaddrinfo|name resolution|connection (reset|refused|aborted)|timed out|network is unreachable|temporary failure/i,
    'Falha de conexão ao baixar. Verifique sua internet e tente novamente.']
];

/**
 * Mensagem amigável para o usuário a partir do stderr do yt-dlp.
 *
 * - Usa apenas as linhas `ERROR:` (as demais são progresso/avisos);
 * - mapeia padrões conhecidos para mensagens em português;
 * - sem padrão conhecido: devolve o final (~300 chars) das linhas ERROR, sem caminhos locais;
 * - sem linhas ERROR: mensagem genérica com o código de saída.
 *
 * @param {string} stderr
 * @param {number|null} [exitCode]
 * @returns {string}
 */
function friendlyYtDlpError(stderr, exitCode = null) {
  return maskEngineNames(buildFriendlyMessage(stderr, exitCode));
}

function buildFriendlyMessage(stderr, exitCode) {
  const errorLines = extractErrorLines(stderr);
  const haystack = errorLines.length ? errorLines.join('\n') : String(stderr || '');

  for (const [regex, message] of PATTERNS) {
    if (regex.test(haystack)) return message;
  }

  if (errorLines.length) {
    const joined = stripLocalPaths(errorLines.join(' | '));
    return joined.length > MAX_MESSAGE_LENGTH ? joined.slice(-MAX_MESSAGE_LENGTH) : joined;
  }

  return exitCode !== null && exitCode !== undefined
    ? `O download falhou (código ${exitCode}).`
    : 'O download falhou.';
}

/** Para mensagens de exceção (ex.: "yt-dlp não encontrado em C:\\..."): remove caminhos locais. */
function sanitizeUserMessage(message) {
  const clean = maskEngineNames(stripLocalPaths(message));
  return clean.length > MAX_MESSAGE_LENGTH ? clean.slice(-MAX_MESSAGE_LENGTH) : clean;
}

module.exports = { friendlyYtDlpError, sanitizeUserMessage, extractErrorLines, stripLocalPaths };
