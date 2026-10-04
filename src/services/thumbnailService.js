const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const logger = require('./logService');
const { assertHttpUrl, redactUrl } = require('./urlValidator');
const { cookiesFileFor } = require('./youtubeCookies');
const { toolRunner } = require('../infrastructure/external-tools/ToolRunner');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ytDlpTool } = require('../infrastructure/external-tools/adapters/YtDlpTool');
const { spotDlTool } = require('../infrastructure/external-tools/adapters/SpotDlTool');

class ThumbnailService {
  constructor({ paths, getSettings }) {
    this.paths = paths;
    this.getSettings = getSettings;
  }

  async getMetadata(url) {
    this.assertValidUrl(url);

    if (this.isSpotifyUrl(url)) {
      const raw =
        await this.runSpotifyMetadata(url);

      const isList = Array.isArray(raw);
      const meta = isList ? (raw[0] || {}) : (raw || {});

      return {
        title:
          meta.name ||
          'Spotify',

        thumbnail:
          meta.cover_url ||
          '',

        duration:
          meta.duration ||
          null,

        channel:
          meta.artist ||
          '',

        webpageUrl:
          meta.url ||
          url,

        type:
          this.getSpotifyType(url),

        itemCount:
          (isList ? raw.length : null) ||
          meta.tracks_count ||
          meta.list_length ||
          null,

        source: 'spotify',

        album:
          meta.album_name || '',

        year:
          meta.year || ''
      };
    }

    const json = await this.runYtDlpJson(
      url,
      [
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '--socket-timeout', '10'
      ]
    );

    const isYoutubeMusic =
      json.extractor_key === 'YoutubeMusic' ||
      json.webpage_url?.includes(
        'music.youtube.com'
      ) ||
      json.original_url?.includes(
        'music.youtube.com'
      );

    let thumbnail =
      json.thumbnail ||
      this.pickThumbnail(
        json.thumbnails
      );

    if (isYoutubeMusic) {
      const squareThumbnail =
        this.pickSquareThumbnail(
          json.thumbnails
        );

      if (squareThumbnail) {
        thumbnail = squareThumbnail;
      } else if (thumbnail) {
        // [THUMB] Nenhuma miniatura nativa 1:1 — recorta a melhor disponível via FFmpeg
        try {
          const squarePath = await this.createSquareThumbnailFromUrl(
            thumbnail,
            json.webpage_url || url
          );
          if (squarePath) {
            // Converte para bds-thumb:// com barras normais (URL-safe)
            const urlPath = squarePath.replace(/\\/g, '/');
            thumbnail = `bds-thumb://${urlPath}`;
          }
        } catch (err) {
          logger.warn('[ThumbnailService] Falha ao gerar miniatura quadrada:', err.message);
          // mantém a thumbnail original em caso de erro
        }
      }
    }

    return {
      title:
        json.title ||
        json.fulltitle ||
        'Mídia sem título',

      thumbnail,

      duration:
        json.duration ||
        null,

      channel:
        json.channel ||
        json.uploader ||
        json.artist ||
        '',

      webpageUrl:
        json.webpage_url ||
        url,

      type:
        json._type ||
        'video',

      itemCount:
        Array.isArray(json.entries)
          ? json.entries.length
          : json.playlist_count ||
            null,

      isYoutubeMusic
    };
  }

    async inspectPlaylist(url) {
    this.assertValidUrl(url);

    if (this.isSpotifyUrl(url)) {
      const type = this.getSpotifyType(url);
      const isPlaylist = type === 'playlist' || type === 'album' || type === 'artist';
      return {
        isPlaylist,
        source: 'spotify',
        title: isPlaylist ? 'Playlist de músicas' : 'Música',
        itemCount: null
      };
    }

    // Link de vídeo com "&list=" (watch?v=ID&list=...) é um item único: sem --no-playlist o
    // yt-dlp o trataria como playlist inteira e a UI expandiria dezenas de itens.
    const ytArgs = ['--dump-single-json', '--flat-playlist', '--no-warnings'];
    if (this.isVideoWithPlaylistParam(url)) ytArgs.push('--no-playlist');
    const json = await this.runYtDlpJson(url, ytArgs);

    return {
      isPlaylist: json._type === 'playlist' || Array.isArray(json.entries),
      title: json.title || json.playlist_title || 'Playlist',
      itemCount: Array.isArray(json.entries)
        ? json.entries.length
        : json.playlist_count || 0
    };
  }

  /** true se a URL tem um vídeo específico (v=ID) junto de um parâmetro de playlist (list=). */
  isVideoWithPlaylistParam(url) {
    try {
      const u = new URL(url);
      return u.searchParams.has('v') && u.searchParams.has('list');
    } catch (_) {
      return false;
    }
  }

  async expandPlaylist(url) {
    this.assertValidUrl(url);

    if (this.isSpotifyUrl(url)) {
      try {
        const meta = await this.runSpotifyMetadata(url);
        // Se for uma lista de tracks do Spotify
        if (Array.isArray(meta)) {
          return meta.map(track => ({
            url: track.url || url,
            title: track.name ? `${track.name} - ${track.artist}` : 'Música',
            thumbnail: track.cover_url || ''
          }));
        }
        // Faixa única: reaproveita o metadata em vez de descartar
        if (meta) {
          return [{
            url: meta.url || url,
            title: meta.name ? `${meta.name} - ${meta.artist}` : 'Música',
            thumbnail: meta.cover_url || ''
          }];
        }
      } catch (e) {
        logger.warn('[ThumbnailService] Falha ao expandir playlist Spotify:', e.message);
      }
      return [{ url, title: 'Música', thumbnail: '' }];
    }

    const json = await this.runYtDlpJson(
      url,
      ['--dump-single-json', '--flat-playlist', '--no-warnings']
    );

    if (Array.isArray(json.entries) && json.entries.length > 0) {
      return json.entries.map(entry => {
        let entryUrl = entry.url || entry.webpage_url;
        if (entryUrl && !entryUrl.startsWith('http')) {
          entryUrl = `https://www.youtube.com/watch?v=${entry.id || entryUrl}`;
        }
        return {
          url: entryUrl || url,
          title: entry.title || 'Vídeo de Playlist',
          thumbnail: this.pickThumbnail(entry.thumbnails)
        };
      });
    }

    return [{ url, title: json.title || 'Mídia', thumbnail: json.thumbnail || '' }];
  }

  isSpotifyUrl(url) {
    return (
      url.includes('spotify.com') ||
      url.startsWith('spotify:')
    );
  }

  getSpotifyType(url) {
    if (url.includes('/track/')) return 'track';
    if (url.includes('/album/')) return 'album';
    if (url.includes('/playlist/')) return 'playlist';
    if (url.includes('/artist/')) return 'artist';
    return 'spotify';
  }

  pickThumbnail(thumbnails = []) {
    if (
      !Array.isArray(thumbnails) ||
      thumbnails.length === 0
    ) {
      return '';
    }
    return [...thumbnails]
      .sort(
        (a, b) =>
          (b.width || 0) -
          (a.width || 0)
      )[0]?.url || '';
  }

  pickSquareThumbnail(
      thumbnails = []
    ) {

      if (
        !Array.isArray(thumbnails) ||
        thumbnails.length === 0
      ) {
        return '';
      }

      const squareThumbs =
        thumbnails.filter(
          thumb => {

            const width =
              Number(
                thumb.width || 0
              );

            const height =
              Number(
                thumb.height || 0
              );

            if (
              !width ||
              !height
            ) {
              return false;
            }

            return (
              Math.abs(
                width - height
              ) <= 20
            );

          }
        );

      if (
        squareThumbs.length === 0
      ) {
        return '';
      }

      return squareThumbs
        .sort(
          (a, b) =>
            (b.width || 0) -
            (a.width || 0)
        )[0].url;

    }

  async runSpotifyMetadata(url) {
    const exe = spotDlTool.resolve();
    let result;
    try {
      result = await toolRunner.run(exe, ['save', url, '--save-file', '-'], {
        timeout: 90000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao analisar o link de música.');
      throw err;
    }
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    try {
      const jsonMatch = result.stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (!jsonMatch) {
        throw new Error('Resposta inesperada do motor de download.');
      }
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      throw new Error('Não foi possível ler as informações deste link de música.');
    }
  }

  async runYtDlpJson(url, args) {
    const exe = ytDlpTool.resolve();

    const finalArgs = [...args];
    // Só links do YouTube recebem a sessão da conta, e só se ela ainda estiver válida
    const cookiesFile = cookiesFileFor(url, this.getSettings().cookiesFile);
    if (cookiesFile) {
      finalArgs.push('--cookies', cookiesFile);
    }
    // '--' encerra as opções: a URL nunca é interpretada como flag do yt-dlp.
    finalArgs.push('--', url);

    logger.info('metadata:start', { url: redactUrl(url) });

    let result;
    try {
      result = await toolRunner.run(exe, finalArgs, {
        timeout: 15000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao analisar metadados.');
      throw err;
    }

    if (result.code !== 0) {
      logger.warn('metadata:failed', { code: result.code, stderr: String(result.stderr || '').slice(-500) });
      throw new Error(result.stderr.trim() || `O motor de download finalizou com código ${result.code}`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Falha ao interpretar a resposta do motor de download: ${error.message}`);
    }
  }

  assertExecutable(exePath) {
    if (!fs.existsSync(exePath)) {
      throw new Error(
        `${path.basename(exePath)} não encontrado em ${exePath}`
      );
    }
  }

  assertValidUrl(url) {
    // Validador único (http/https) compartilhado com downloadService/metadataService
    assertHttpUrl(url);
  }

  async downloadThumbnail(url, outputFile) {
    const ytDlp = ytDlpTool.resolve();
    assertHttpUrl(url);

    let result;
    try {
      result = await toolRunner.run(ytDlp, [
        '--skip-download',
        '--write-thumbnail',
        '--convert-thumbnails',
        'jpg',
        '-o',
        path.basename(outputFile, '.jpg'),
        '--',
        url
      ], {
        cwd: path.dirname(outputFile),
        timeout: 60000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao baixar a miniatura.');
      throw err;
    }

    if (result.code === 0) return outputFile;
    throw new Error(`Falha ao baixar thumbnail (${result.code})`);
  }

  async createSquareThumbnail(inputFile, outputFile) {
    const ffmpeg = ffmpegTool.resolve();

    let result;
    try {
      result = await toolRunner.run(ffmpeg, [
        '-y',
        '-i',
        inputFile,
        '-vf',
        'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080',
        '-q:v',
        '2',
        outputFile
      ], { timeout: 60000 });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao gerar a miniatura.');
      throw err;
    }

    if (result.code === 0) return outputFile;
    throw new Error(result.stderr || `O motor de mídia retornou ${result.code}`);
  }

  async createSquareThumbnailFromUrl(thumbnailUrl, videoUrl) {
    // [CACHE] Usa thumbnailsDir com nome baseado no hash da URL do vídeo,
    // para evitar re-download e re-processamento em chamadas futuras.
    const cacheDir = this.paths.thumbnailsDir || path.join(this.paths.dataDir, 'Thumbnails');
    fs.mkdirSync(cacheDir, { recursive: true });

    const urlHash = crypto
      .createHash('sha1')
      .update(videoUrl || thumbnailUrl)
      .digest('hex')
      .slice(0, 16);

    const squareFile = path.join(cacheDir, `sq_${urlHash}.jpg`);

    // Retorna do cache se já existe
    if (fs.existsSync(squareFile)) {
      logger.info('[ThumbnailService] Miniatura quadrada em cache:', squareFile);
      return squareFile;
    }

    const tempDir = path.join(this.paths.dataDir, 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const originalFile = path.join(tempDir, `thumb_dl_${urlHash}.jpg`);

    await this.downloadThumbnail(thumbnailUrl, originalFile);

    try {
      await this.createSquareThumbnail(originalFile, squareFile);
      logger.info('[ThumbnailService] Miniatura quadrada gerada:', squareFile);
      return squareFile;
    } finally {
      // [PERF] Remove o arquivo temporário original para não acumular lixo em disco
      try { if (fs.existsSync(originalFile)) fs.unlinkSync(originalFile); } catch (_) {}
    }
  }
  

}



module.exports = ThumbnailService;