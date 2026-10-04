const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const logger = require('./logService');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const { toolRunner } = require('../infrastructure/external-tools/ToolRunner');
const probeCache = require('../core/ffmpeg/ProbeCache');

// Progresso para a UI no máximo a cada 250 ms; stderr do ffmpeg guarda só o final (~4 KB)
const EMIT_THROTTLE_MS = 250;
const STDERR_TAIL_BYTES = 4096;

class MetadataService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this.currentProcess = null;
    this.cancelRequested = false;
  }

  async probeFile(filePath) {
    return probeCache.getOrLoad(filePath, () => this._probeFileRaw(filePath), 'metadata-probe');
  }

  async _probeFileRaw(filePath) {
    const ffprobe = ffprobeTool.resolve();
    let result;
    try {
      result = await toolRunner.run(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        filePath
      ], { timeout: 30000 });
    } catch (err) {
      if (/^Timeout/.test(err.message)) throw new Error('Tempo limite excedido ao ler os metadados do arquivo.');
      throw err;
    }
    if (result.code !== 0) throw new Error('Erro ao ler os metadados do arquivo');
    return JSON.parse(result.stdout);
  }

  /** Executa o ffmpeg com timeout (árvore encerrada no estouro); nunca rejeita (extração é "best effort"). */
  async _runFfmpegQuiet(ffmpeg, args) {
    try {
      await toolRunner.run(ffmpeg, args, { timeout: 60000 });
    } catch (_) { /* erro/timeout: o chamador confere se o arquivo de saída existe */ }
  }

  async extractThumbnail(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;

      const tempDir = path.join(this.paths.dataDir, 'temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      
      const outPath = path.join(tempDir, `thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
      let ffmpeg;
      try {
        ffmpeg = ffmpegTool.resolve();
      } catch (_) {
        return null;
      }

      // 1. Avalia se existe capa/arte anexada (attached_pic)
      try {
        const info = await this.probeFile(filePath);
        const coverStream = info?.streams?.find(s => s.disposition && s.disposition.attached_pic === 1);
        if (coverStream) {
          await this._runFfmpegQuiet(ffmpeg, [
            '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-y',
            '-i', filePath,
            '-map', `0:${coverStream.index}`,
            '-frames:v', '1',
            outPath
          ]);
          if (fs.existsSync(outPath)) return outPath;
        }
      } catch (e) {}

      // 2. Extrai o frame real do vídeo a 1s
      await this._runFfmpegQuiet(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-y',
        '-ss', '00:00:01',
        '-i', filePath,
        '-frames:v', '1',
        '-q:v', '2',
        outPath
      ]);

      if (fs.existsSync(outPath)) return outPath;

      // 3. Backup: extrai o frame a 0s caso o vídeo seja muito curto
      await this._runFfmpegQuiet(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-y',
        '-ss', '00:00:00',
        '-i', filePath,
        '-frames:v', '1',
        '-q:v', '2',
        outPath
      ]);

      return fs.existsSync(outPath) ? outPath : null;
    } catch (err) {
      logger.error('metadata:extractThumb-error', { error: err.message });
      return null;
    }
  }

  /** Escapa um valor do formato FFMETADATA: \ = ; # e quebra de linha. */
  _escapeFfmeta(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/=/g, '\\=').replace(/\r?\n/g, '\\\n');
  }

  buildFfmetadataContent(tags, chapters) {
    let content = ';FFMETADATA1\n';

    for (const [key, value] of Object.entries(tags || {})) {
      if (value) content += `${key}=${this._escapeFfmeta(value)}\n`;
    }

    // Chapters
    if (chapters && chapters.length > 0) {
      for (const ch of chapters) {
        content += '\n[CHAPTER]\n';
        content += 'TIMEBASE=1/1000\n';
        content += `START=${Math.round(ch.start * 1000)}\n`;
        content += `END=${Math.round(ch.end * 1000)}\n`;
        if (ch.title) {
          content += `title=${this._escapeFfmeta(ch.title)}\n`;
        }
      }
    }
    
    return content;
  }

  async saveMetadata(config) {
    const { filePath, outMode, outputPath, tags, streams, chapters, thumbnailAction, newThumbnailPath } = config;
    const ffmpeg = ffmpegTool.resolve();
    this.cancelRequested = false;

    // Se o modo for overwrite, usaremos arquivo temporário na mesma pasta
    const finalDest = outMode === 'overwrite' ? filePath : outputPath;
    if (!finalDest) throw new Error('Destino do arquivo não informado.');
    if (outMode !== 'overwrite') {
      if (path.resolve(outputPath).toLowerCase() === path.resolve(filePath).toLowerCase()) {
        throw new Error('O arquivo de saída não pode ser o mesmo arquivo de origem.');
      }
      if (fs.existsSync(outputPath)) throw new Error('Já existe um arquivo com esse nome na pasta escolhida.');
    }
    const ext = (path.extname(filePath) || '.mp4').toLowerCase();
    // O temporário mantém a extensão original (o ffmpeg escolhe o contêiner pela extensão)
    const workingDest = outMode === 'overwrite'
      ? path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.bds-tmp${ext}`)
      : outputPath;

    // `tags` traz só as tags alteradas (valor vazio remove a tag); as demais são preservadas por -map_metadata 0.
    // `chapters` só vem quando os capítulos foram editados; senão o ffmpeg copia os originais.
    const hasChapters = Array.isArray(chapters);
    let metaTxtPath = null;
    const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', filePath];
    let nextInput = 1;
    if (hasChapters) {
      metaTxtPath = path.join(this.paths.dataDir, `meta_${Date.now()}.txt`);
      fs.writeFileSync(metaTxtPath, this.buildFfmetadataContent({}, chapters), 'utf8');
      args.push('-i', metaTxtPath);
      nextInput++;
    }
    const chaptersInput = hasChapters ? 1 : 0;

    let coverInput = -1;
    if ((thumbnailAction === 'add' || thumbnailAction === 'replace') && newThumbnailPath && fs.existsSync(newThumbnailPath)) {
      args.push('-i', newThumbnailPath);
      coverInput = nextInput++;
    }

    args.push('-map', '0'); // todas as streams originais
    args.push('-map_metadata', '0'); // metadados globais originais; as alterações vêm abaixo
    args.push('-map_chapters', String(chaptersInput));
    args.push('-c', 'copy'); // cópia direta, sem reencodar

    let info = null;
    try { info = await this.probeFile(filePath); } catch (_) { /* sem sondagem: segue com padrões */ }
    const isCover = (st) => st.disposition && st.disposition.attached_pic === 1;
    const removeOldCover = thumbnailAction === 'remove' || (thumbnailAction === 'replace' && coverInput >= 0);
    if (removeOldCover) args.push('-map', '-0:disp:attached_pic');
    if (coverInput >= 0) {
      // A nova imagem vira a última stream de vídeo da saída: índice = vídeos que ficaram.
      const videoOut = (info?.streams || []).filter(st => st.codec_type === 'video' && !(removeOldCover && isCover(st))).length;
      args.push('-map', String(coverInput));
      args.push(`-disposition:v:${videoOut}`, 'attached_pic');
    }

    for (const [key, value] of Object.entries(tags || {})) {
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
      args.push('-metadata', `${key}=${value == null ? '' : value}`);
    }

    // Metadados por stream, pelo índice absoluto (igual na entrada e na saída com -map 0)
    for (const s of streams || []) {
      const sel = Number.isInteger(s.index) ? `-metadata:s:${s.index}` : `-metadata:s:${s.type}:${s.typeIndex}`;
      if (s.language) args.push(sel, `language=${s.language}`);
      if (s.title !== undefined && s.title !== null) args.push(sel, `title=${s.title}`);
    }

    // MP4/MOV: faststart mantém o início do arquivo leve. use_metadata_tags preserva tags livres, mas faz o
    // muxer descartar a capa embutida; por isso só entra quando a saída não terá capa.
    if (['.mp4', '.m4v', '.mov', '.m4a', '.3gp'].includes(ext)) {
      const keepsCover = coverInput >= 0 || (!removeOldCover && (info?.streams || []).some(isCover));
      args.push('-movflags', keepsCover ? '+faststart' : '+use_metadata_tags+faststart');
    }

    args.push('-progress', 'pipe:1', '-nostats', workingDest);

    return new Promise((resolve, reject) => {
      const child = processRunner.spawn(ffmpeg, args);
      this.currentProcess = child;

      let stderrTail = '';
      child.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
        this.emit('log', text);
      });

      // Como é stream copy, será muito rápido, progresso simples (com throttle)
      let lastProgressAt = 0;
      child.stdout.on('data', () => {
          const now = Date.now();
          if (now - lastProgressAt < EMIT_THROTTLE_MS) return;
          lastProgressAt = now;
          this.emit('progress', { status: 'Copiando dados...' });
      });

      child.on('error', err => {
        this.currentProcess = null;
        try { if (metaTxtPath && fs.existsSync(metaTxtPath)) fs.unlinkSync(metaTxtPath); } catch (_) {}
        reject(new Error(`Falha ao executar o motor de mídia: ${err.message}`));
      });

      child.on('close', code => {
        this.currentProcess = null;
        // Limpar temporários
        try { if (metaTxtPath && fs.existsSync(metaTxtPath)) fs.unlinkSync(metaTxtPath); } catch (_) {}

        if (this.cancelRequested) {
          try { if (fs.existsSync(workingDest)) fs.unlinkSync(workingDest); } catch (_) {}
          return resolve({ status: 'canceled' });
        }

        if (code !== 0) {
          try { if (fs.existsSync(workingDest)) fs.unlinkSync(workingDest); } catch (_) {}
          return reject(new Error(`Erro do motor de mídia (código ${code})${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ''}`));
        }

        // Se for modo overwrite, substitui o original pelo tmp SEM nunca apagar o original antes
        if (outMode === 'overwrite') {
          try {
            this._replaceFileAtomically(workingDest, filePath);
          } catch (e) {
            try { if (fs.existsSync(workingDest)) fs.unlinkSync(workingDest); } catch (_) {}
            return reject(new Error('Falha ao substituir arquivo original: ' + e.message));
          }
        }

        resolve({ status: 'success' });
      });
    });
  }

  /**
   * Substitui `dest` por `tmp` sem janela em que o original deixe de existir.
   * 1) rename direto (no Windows o Node usa MoveFileEx com REPLACE_EXISTING, então substitui);
   * 2) fallback: original -> .bak, tmp -> dest e só então apaga o .bak; em falha, restaura o original.
   */
  _replaceFileAtomically(tmp, dest) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (firstErr) {
      if (!fs.existsSync(dest)) throw firstErr;
    }
    const bak = `${dest}.bak_${Date.now()}`;
    fs.renameSync(dest, bak);
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      try { fs.renameSync(bak, dest); } catch (_) { /* restauração best effort */ }
      throw err;
    }
    try { fs.unlinkSync(bak); } catch (_) { /* sobra do .bak não afeta o resultado */ }
  }

  async cancel() {
    this.cancelRequested = true;
    if (this.currentProcess) {
      await processRunner.cancel(this.currentProcess);
    }
  }
}

module.exports = MetadataService;
