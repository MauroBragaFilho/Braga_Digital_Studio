const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');
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
        '--no-warnings'
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
        thumbnail =
          squareThumbnail;
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
        title: isPlaylist ? 'Spotify Playlist' : 'Spotify Track',
        itemCount: null
      };
    }

    const json = await this.runYtDlpJson(
      url,
      ['--dump-single-json', '--flat-playlist', '--no-warnings']
    );

    return {
      isPlaylist: json._type === 'playlist' || Array.isArray(json.entries),
      title: json.title || json.playlist_title || 'Playlist',
      itemCount: Array.isArray(json.entries)
        ? json.entries.length
        : json.playlist_count || 0
    };
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
            title: track.name ? `${track.name} - ${track.artist}` : 'Spotify Track',
            thumbnail: track.cover_url || ''
          }));
        }
        // Faixa única: reaproveita o metadata em vez de descartar
        if (meta) {
          return [{
            url: meta.url || url,
            title: meta.name ? `${meta.name} - ${meta.artist}` : 'Spotify Track',
            thumbnail: meta.cover_url || ''
          }];
        }
      } catch (e) {
        logger.warn('[ThumbnailService] Falha ao expandir playlist Spotify:', e.message);
      }
      return [{ url, title: 'Spotify Track', thumbnail: '' }];
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
    return new Promise((resolve, reject) => {
      const child = spawn(
        exe,
        [
          'save',
          url,
          '--save-file',
          '-'
        ],
        {
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', code => {
        if (code !== 0) {
          return reject(
            new Error(stderr)
          );
        }
        try {
          const jsonMatch =
            stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);

        if (!jsonMatch) {

            throw new Error(
                `Resposta inesperada do SpotDL:\n${stdout}`
            );

        }

        const parsed =
            JSON.parse(jsonMatch[0]);
          resolve(parsed);
        } catch (err) {
          reject(
            new Error(
              `Erro ao interpretar JSON Spotify: ${err.message}`
            )
          );
        }
      });
    });
  }

  runYtDlpJson(url, args) {
    const exe = ytDlpTool.resolve();

    const finalArgs = [...args];
    const cookiesFile = this.getSettings().cookiesFile;
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      finalArgs.push('--cookies', cookiesFile);
    }
    finalArgs.push(url);

    logger.info('metadata:start', { url });

    return new Promise((resolve, reject) => {
      const child = spawn(exe, finalArgs, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          logger.warn('metadata:failed', { code, stderr });
          reject(new Error(stderr.trim() || `yt-dlp finalizou com código ${code}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Falha ao ler JSON do yt-dlp: ${error.message}`));
        }
      });
    });
  }

  assertExecutable(exePath) {
    if (!fs.existsSync(exePath)) {
      throw new Error(
        `${path.basename(exePath)} não encontrado em ${exePath}`
      );
    }
  }

  assertValidUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo inválido');
    } catch {
      throw new Error('Informe uma URL válida.');
    }
  }
  
  async downloadThumbnail(url, outputFile) {
    const ytDlp = ytDlpTool.resolve();

    return new Promise((resolve, reject) => {
      const child = spawn(
        ytDlp,
        [
          '--skip-download',
          '--write-thumbnail',
          '--convert-thumbnails',
          'jpg',
          '-o',
          path.basename(outputFile, '.jpg'),
          url
        ],
        {
          cwd: path.dirname(outputFile),
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        }
      );

      child.on('close', code => {
        if (code === 0) {
          resolve(outputFile);
        } else {
          reject(
            new Error(
              `Falha ao baixar thumbnail (${code})`
            )
          );
        }
      });
    });
  }

  async createSquareThumbnail(inputFile, outputFile) {
    const ffmpeg = ffmpegTool.resolve();

    return new Promise((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-y',
          '-i',
          inputFile,
          '-vf',
          'scale=1000:1000:force_original_aspect_ratio=increase,crop=1000:1000',
          '-q:v',
          '2',
          outputFile
        ],
        {
          windowsHide: true
        }
      );

      let stderr = '';

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('close', code => {
        if (code === 0) {
          resolve(outputFile);
        } else {
          reject(
            new Error(
              stderr || `FFmpeg retornou ${code}`
            )
          );
        }
      });
    });
  }

  async createSquareThumbnailFromUrl(url) {
    const tempDir = path.join(
      this.paths.dataDir,
      'temp'
    );

    fs.mkdirSync(
      tempDir,
      { recursive: true }
    );

    const originalFile = path.join(
      tempDir,
      `thumb_${Date.now()}.jpg`
    );

    const squareFile = path.join(
      tempDir,
      `thumb_square_${Date.now()}.jpg`
    );

    await this.downloadThumbnail(
      url,
      originalFile
    );

    await this.createSquareThumbnail(
      originalFile,
      squareFile
    );

    return squareFile;
  }
  

}



module.exports = ThumbnailService;