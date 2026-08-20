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
};

/**
 * Retorna o nome do executável para a plataforma atual.
 *
 * @param {keyof typeof ToolManifest} toolKey - 'ffmpeg' | 'ffprobe' | 'ytdlp' | 'spotdl'
 * @returns {string} Nome do executável (sem path)
 * @throws {Error} Se toolKey for inválido
 */
function getExecutableName(toolKey) {
  const entry = ToolManifest[toolKey];
  if (!entry) {
    throw new Error(`Ferramenta desconhecida no ToolManifest: '${toolKey}'. Use: ${Object.keys(ToolManifest).join(', ')}`);
  }
  const platform = process.platform;
  return entry[platform] || entry.linux;
}

module.exports = { ToolManifest, getExecutableName };
