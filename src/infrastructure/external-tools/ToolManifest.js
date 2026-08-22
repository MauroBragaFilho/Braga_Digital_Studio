'use strict';

/**
 * ToolManifest — Mapa de nomes de executáveis por plataforma.
 *
 * Regra do roadmap (seção 6):
 *   A aplicação deve trabalhar com uma abstração de ferramentas externas.
 *   O restante do BDS não deve saber qual nome ou caminho foi usado.
 *
 * Este é o ÚNICO arquivo da aplicação que mapeia os nomes de executáveis de cada SO.
 *
 * Chaves disponíveis: ffmpeg | ffprobe | ytdlp | spotdl | deno
 */
const ToolManifest = {
  ffmpeg: {
    win32:  'ffmpeg.exe',
    linux:  'ffmpeg',
    darwin: 'ffmpeg',
  },
  ffprobe: {
    win32:  'ffprobe.exe',
    linux:  'ffprobe',
    darwin: 'ffprobe',
  },
  ytdlp: {
    win32:  'yt-dlp.exe',
    linux:  'yt-dlp',
    darwin: 'yt-dlp',
  },
  spotdl: {
    win32:  'spotify-dlp.exe',
    linux:  'spotdl',
    darwin: 'spotdl',
  },
  // Runtime JS exigido pelo yt-dlp para resolver desafios de PO Token/JS challenges.
  // Distribuído como binário único e portátil — não precisa de instalador do sistema,
  // basta baixar e colocar dentro de AppPaths.tools, igual às outras ferramentas.
  deno: {
    win32:  'deno.exe',
    linux:  'deno',
    darwin: 'deno',
  },
  // Motor de recuperação de vídeos corrompidos (anthwlock/untrunc)
  untrunc: {
    win32:  'untrunc.exe',
    linux:  'untrunc',
    darwin: 'untrunc',
  },
};

/**
 * Mapeamento de componentes lógicos de alto nível do BDS para as chaves internas.
 */
const LogicalComponentAliases = {
  mediaEngine: 'ffmpeg',
  probeEngine: 'ffprobe',
  downloadEngine: 'ytdlp',
  audioEngine: 'spotdl',
  jsRuntime: 'deno',
  recoveryEngine: 'untrunc',
};

/**
 * Normaliza o identificador da ferramenta para a chave canônica do ToolManifest.
 *
 * @param {string} toolOrAlias
 * @returns {string}
 */
function resolveCanonicalToolKey(toolOrAlias) {
  if (!toolOrAlias) return toolOrAlias;
  if (LogicalComponentAliases[toolOrAlias]) {
    return LogicalComponentAliases[toolOrAlias];
  }
  const lower = toolOrAlias.toLowerCase().replace(/[-_]/g, '');
  if (lower === 'ytdlp' || lower === 'ytdl') return 'ytdlp';
  if (lower === 'spotdl' || lower === 'spotifydlp' || lower === 'spotify') return 'spotdl';
  if (lower === 'ffmpeg') return 'ffmpeg';
  if (lower === 'ffprobe') return 'ffprobe';
  if (lower === 'deno') return 'deno';
  if (lower === 'untrunc') return 'untrunc';
  return toolOrAlias;
}

/**
 * Retorna o nome do executável para a plataforma atual.
 *
 * @param {string} toolKey - 'ffmpeg' | 'ffprobe' | 'ytdlp' | 'spotdl' | 'deno' | 'untrunc' (ou alias lógico)
 * @returns {string} Nome do executável (sem path)
 * @throws {Error} Se toolKey for inválido
 */
function getExecutableName(toolKey) {
  const canonical = resolveCanonicalToolKey(toolKey);
  const entry = ToolManifest[canonical];
  if (!entry) {
    throw new Error(`Componente desconhecido no ToolManifest: '${toolKey}'. Use: ${Object.keys(ToolManifest).join(', ')}`);
  }
  const platform = process.platform;
  return entry[platform] || entry.linux;
}

module.exports = { ToolManifest, LogicalComponentAliases, resolveCanonicalToolKey, getExecutableName };

