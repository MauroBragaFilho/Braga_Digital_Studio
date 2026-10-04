'use strict';

/**
 * ToolSources — tabela explícita (plataforma, arquitetura) -> fonte OFICIAL de cada motor externo.
 *
 * Regra do projeto: SOMENTE FONTES OFICIAIS. Cada entrada aponta para um asset publicado pelo próprio
 * projeto (ou, no caso do FFmpeg, pelo repositório de builds que o site oficial indica) em GitHub Releases.
 * Nada é compilado nem baixado de build de terceiros não oficial. Combinação sem entrada = "indisponível
 * neste sistema": o recurso mostra uma mensagem clara, em vez de baixar um binário errado.
 *
 * Esta tabela não faz rede nem toca em disco: só descreve de onde baixar (o ToolUpdater baixa, confere o
 * SHA-256 publicado pela release e instala).
 *
 * Observações honestas sobre cada fonte:
 *  - ffmpeg/ffprobe: o ffmpeg.org só distribui código-fonte e aponta builds de terceiros. Usamos BtbN/FFmpeg-Builds
 *    (a mais usada, citada em ffmpeg.org/download), que publica win64, winarm64, linux64 e linuxarm64 e NÃO publica
 *    macOS. No macOS o BDS usa o ffmpeg/ffprobe do sistema se achar no PATH (ex.: Homebrew) e, senão, informa
 *    que não há fonte oficial. ffmpeg e ffprobe vêm no MESMO pacote: são um componente só (um download).
 *  - yt-dlp: publica yt-dlp.exe, yt-dlp_x86.exe, yt-dlp_arm64.exe, yt-dlp_linux, yt-dlp_linux_aarch64 e
 *    yt-dlp_macos (universal: Intel e Apple Silicon).
 *  - deno: um zip por triplo (Windows/Linux/macOS, x64 e arm64).
 *  - spotDL: publica só Windows (win32.exe, x64), Linux (x64) e um binário macOS sem arquitetura documentada;
 *    macOS e arm64 ficam indisponíveis (não adivinhamos).
 *  - untrunc (anthwlock): só publica zips para Windows (x64 e x32).
 *  - exiftool: Windows usa o pacote do ShareX/ExifTool (único pré-compilado mantido); Linux/macOS usam o código
 *    do repositório oficial exiftool/exiftool (script Perl, independe da arquitetura, exige Perl no sistema).
 */

const GH = 'https://github.com';

/** Erro de "este componente não existe para este sistema" (código estável para a interface). */
class ToolUnavailableError extends Error {
  constructor(message, toolKey) {
    super(message);
    this.name = 'ToolUnavailableError';
    this.code = 'TOOL_UNAVAILABLE';
    this.tool = toolKey;
  }
}

const SYSTEM_NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
const ARCH_NAMES = { x64: '64 bits (x64)', arm64: 'ARM 64 bits', ia32: '32 bits', arm: 'ARM 32 bits' };

const TOOL_LABELS = {
  ffmpeg: 'O componente de mídia',
  ffprobe: 'O componente de análise de mídia',
  ytdlp: 'O componente de download',
  spotdl: 'O componente de download de músicas',
  deno: 'O ambiente de execução do download',
  untrunc: 'O componente de recuperação de vídeo',
  exiftool: 'O leitor de metadados'
};

/** ffprobe vem no mesmo pacote do ffmpeg: os dois são um componente (um único download). */
function componentFor(toolKey) {
  return toolKey === 'ffprobe' ? 'ffmpeg' : toolKey;
}

const BTBN = (name) => `${GH}/BtbN/FFmpeg-Builds/releases/latest/download/${name}`;
const YTDLP = (name) => `${GH}/yt-dlp/yt-dlp/releases/latest/download/${name}`;
const DENO = (triple) => `${GH}/denoland/deno/releases/latest/download/deno-${triple}.zip`;

/**
 * chave "<plataforma>-<arquitetura>" (valores de process.platform / process.arch) -> (tag) => URL.
 * A tag só é usada pelas fontes cujo nome do asset carrega a versão (spotDL, ExifTool).
 */
const SOURCES = {
  ffmpeg: {
    'win32-x64': () => BTBN('ffmpeg-master-latest-win64-gpl.zip'),
    'win32-arm64': () => BTBN('ffmpeg-master-latest-winarm64-gpl.zip'),
    'linux-x64': () => BTBN('ffmpeg-master-latest-linux64-gpl.tar.xz'),
    'linux-arm64': () => BTBN('ffmpeg-master-latest-linuxarm64-gpl.tar.xz')
  },
  ytdlp: {
    'win32-x64': () => YTDLP('yt-dlp.exe'),
    'win32-ia32': () => YTDLP('yt-dlp_x86.exe'),
    'win32-arm64': () => YTDLP('yt-dlp_arm64.exe'),
    'linux-x64': () => YTDLP('yt-dlp_linux'),
    'linux-arm64': () => YTDLP('yt-dlp_linux_aarch64'),
    'darwin-x64': () => YTDLP('yt-dlp_macos'),
    'darwin-arm64': () => YTDLP('yt-dlp_macos')
  },
  deno: {
    'win32-x64': () => DENO('x86_64-pc-windows-msvc'),
    'win32-arm64': () => DENO('aarch64-pc-windows-msvc'),
    'linux-x64': () => DENO('x86_64-unknown-linux-gnu'),
    'linux-arm64': () => DENO('aarch64-unknown-linux-gnu'),
    'darwin-x64': () => DENO('x86_64-apple-darwin'),
    'darwin-arm64': () => DENO('aarch64-apple-darwin')
  },
  spotdl: {
    'win32-x64': (tag) => `${GH}/spotDL/spotify-downloader/releases/download/${tag}/spotdl-${String(tag || '').replace(/^v/, '')}-win32.exe`,
    'linux-x64': (tag) => `${GH}/spotDL/spotify-downloader/releases/download/${tag}/spotdl-${String(tag || '').replace(/^v/, '')}-linux`
  },
  untrunc: {
    'win32-x64': () => `${GH}/anthwlock/untrunc/releases/latest/download/untrunc_x64.zip`,
    'win32-ia32': () => `${GH}/anthwlock/untrunc/releases/latest/download/untrunc_x32.zip`
  },
  exiftool: {
    'win32-x64': (tag) => `${GH}/ShareX/ExifTool/releases/download/${tag}/exiftool-${String(tag || '').replace(/^v/, '')}-win64.zip`,
    // Script Perl do repositório oficial (independe da arquitetura; exige Perl no sistema).
    'linux-x64': (tag) => `${GH}/exiftool/exiftool/archive/refs/tags/${tag}.tar.gz`,
    'linux-arm64': (tag) => `${GH}/exiftool/exiftool/archive/refs/tags/${tag}.tar.gz`,
    'darwin-x64': (tag) => `${GH}/exiftool/exiftool/archive/refs/tags/${tag}.tar.gz`,
    'darwin-arm64': (tag) => `${GH}/exiftool/exiftool/archive/refs/tags/${tag}.tar.gz`
  }
};

const keyFor = (platform, arch) => `${platform}-${arch}`;

/** Existe fonte oficial deste componente para o sistema e a arquitetura? */
function hasSource(toolKey, platform = process.platform, arch = process.arch) {
  const table = SOURCES[componentFor(toolKey)];
  return Boolean(table && table[keyFor(platform, arch)]);
}

/**
 * URL de download oficial. Lança ToolUnavailableError (mensagem em português) se a combinação não tem fonte.
 * @param {string} toolKey chave canônica (ffmpeg, ffprobe, ytdlp, spotdl, deno, untrunc, exiftool)
 * @param {string|null} tag tag da release (para fontes cujo nome do asset leva a versão)
 */
function resolveDownloadUrl(toolKey, tag, platform = process.platform, arch = process.arch) {
  const table = SOURCES[componentFor(toolKey)];
  const make = table && table[keyFor(platform, arch)];
  if (!make) throw new ToolUnavailableError(unavailableReason(toolKey, platform, arch), toolKey);
  return make(tag);
}

/** Mensagem, em português, para o recurso indisponível neste sistema. */
function unavailableReason(toolKey, platform = process.platform, arch = process.arch) {
  const label = TOOL_LABELS[toolKey] || `O componente ${toolKey}`;
  const sys = SYSTEM_NAMES[platform] || String(platform);
  const archName = ARCH_NAMES[arch] || String(arch);
  const where = platform === 'darwin' && !SOURCES[componentFor(toolKey)]?.['darwin-x64'] && !SOURCES[componentFor(toolKey)]?.['darwin-arm64']
    ? sys
    : `${sys}, ${archName}`;
  const extra = (platform === 'darwin' && (toolKey === 'ffmpeg' || toolKey === 'ffprobe'))
    ? ' Instale o componente de mídia pelo gerenciador de pacotes do seu sistema: o BDS usa o que já estiver instalado.'
    : '';
  return `${label} ainda não está disponível neste sistema (${where}): o projeto oficial não publica esse programa para essa combinação.${extra}`;
}

module.exports = { SOURCES, ToolUnavailableError, componentFor, hasSource, resolveDownloadUrl, unavailableReason };
