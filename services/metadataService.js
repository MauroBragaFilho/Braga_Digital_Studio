const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('./logService');

class MetadataService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this.currentProcess = null;
    this.cancelRequested = false;
  }

  async probeFile(filePath) {
    const ffprobe = path.join(this.paths.dataDir, 'ffprobe.exe');
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        filePath
      ], { windowsHide: true });
      
      let stdout = '';
      child.stdout.on('data', chunk => stdout += chunk.toString('utf8'));
      child.on('close', code => {
        if (code !== 0) return reject(new Error('Erro no ffprobe'));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  async extractThumbnail(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;

      const tempDir = path.join(this.paths.dataDir, 'temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      
      const outPath = path.join(tempDir, `thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
      const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
      if (!fs.existsSync(ffmpeg)) return null;

      // 1. Avalia se existe capa/arte anexada (attached_pic)
      try {
        const info = await this.probeFile(filePath);
        const coverStream = info?.streams?.find(s => s.disposition && s.disposition.attached_pic === 1);
        if (coverStream) {
          await new Promise((resolve) => {
            const child = spawn(ffmpeg, [
              '-v', 'quiet',
              '-y',
              '-i', filePath,
              '-map', `0:${coverStream.index}`,
              '-frames:v', '1',
              outPath
            ], { windowsHide: true });
            child.on('close', resolve);
            child.on('error', resolve);
          });
          if (fs.existsSync(outPath)) return outPath;
        }
      } catch (e) {}

      // 2. Extrai o frame real do vídeo a 1s
      await new Promise((resolve) => {
        const child = spawn(ffmpeg, [
          '-v', 'quiet',
          '-y',
          '-ss', '00:00:01',
          '-i', filePath,
          '-frames:v', '1',
          '-q:v', '2',
          outPath
        ], { windowsHide: true });
        child.on('close', resolve);
        child.on('error', resolve);
      });

      if (fs.existsSync(outPath)) return outPath;

      // 3. Backup: extrai o frame a 0s caso o vídeo seja muito curto
      await new Promise((resolve) => {
        const child = spawn(ffmpeg, [
          '-v', 'quiet',
          '-y',
          '-ss', '00:00:00',
          '-i', filePath,
          '-frames:v', '1',
          '-q:v', '2',
          outPath
        ], { windowsHide: true });
        child.on('close', resolve);
        child.on('error', resolve);
      });

      return fs.existsSync(outPath) ? outPath : null;
    } catch (err) {
      logger.error('metadata:extractThumb-error', { error: err.message });
      return null;
    }
  }

  buildFfmetadataContent(tags, chapters) {
    let content = ';FFMETADATA1\n';
    
    // Global tags
    for (const [key, value] of Object.entries(tags)) {
      if (value) {
        // Escape characters: = ; # \ \n
        let safeVal = String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/=/g, '\\=');
        content += `${key}=${safeVal}\n`;
      }
    }
    
    // Chapters
    if (chapters && chapters.length > 0) {
      for (const ch of chapters) {
        content += '\n[CHAPTER]\n';
        content += 'TIMEBASE=1/1000\n';
        content += `START=${Math.round(ch.start * 1000)}\n`;
        content += `END=${Math.round(ch.end * 1000)}\n`;
        if (ch.title) {
          let safeTitle = String(ch.title).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/=/g, '\\=');
          content += `title=${safeTitle}\n`;
        }
      }
    }
    
    return content;
  }

  async saveMetadata(config) {
    const { filePath, outMode, outputPath, tags, streams, chapters, thumbnailAction, newThumbnailPath } = config;
    const ffmpeg = path.join(this.paths.dataDir, 'ffmpeg.exe');
    this.cancelRequested = false;

    // Se o modo for overwrite, usaremos arquivo temporário na mesma pasta
    const finalDest = outMode === 'overwrite' ? filePath : outputPath;
    const workingDest = outMode === 'overwrite' ? `${filePath}.tmp.mp4` : outputPath;
    
    // Gera arquivo de texto FFMETADATA
    const metaTxtPath = path.join(this.paths.dataDir, `meta_${Date.now()}.txt`);
    fs.writeFileSync(metaTxtPath, this.buildFfmetadataContent(tags, chapters), 'utf8');

    let args = ['-y', '-i', filePath, '-i', metaTxtPath];
    let inputsCount = 2;

    if (thumbnailAction === 'add' || thumbnailAction === 'replace') {
      if (fs.existsSync(newThumbnailPath)) {
        args.push('-i', newThumbnailPath);
        inputsCount = 3;
      }
    }

    // Configurando mapas e cópia de streams
    args.push('-map', '0'); // Mapeia todas as streams originais do arquivo 1 (índice 0)
    args.push('-map_metadata', '1'); // Metadados globais vêm do arquivo txt (índice 1)
    args.push('-map_chapters', '1'); // Capítulos vêm do arquivo txt (índice 1)
    args.push('-c', 'copy'); // Cópia direta sem reencodar

    // Se o usuário pediu para remover a capa, nós precisamos ignorar o mapeamento da stream de vídeo específica
    if (thumbnailAction === 'remove') {
      // Removeremos todas as covers usando a tag de mapeamento negativo
      args.push('-map', '-0:v:attached_pic?'); 
    } 
    else if ((thumbnailAction === 'add' || thumbnailAction === 'replace') && inputsCount === 3) {
      // Se for replace, a capa antiga do map 0 ainda existe, devemos removê-la e mapear a nova
      if (thumbnailAction === 'replace') {
         args.push('-map', '-0:v:attached_pic?'); 
      }
      args.push('-map', '2'); // Mapeia a nova imagem (índice 2)
      args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic'); // Define como attached_pic
    }

    // Atualiza metadados individuais de streams (ex: idioma)
    if (streams && streams.length > 0) {
      for (const s of streams) {
        if (s.language) {
          args.push(`-metadata:s:${s.type}:${s.typeIndex}`, `language=${s.language}`);
        }
        if (s.title) {
          args.push(`-metadata:s:${s.type}:${s.typeIndex}`, `title=${s.title}`);
        }
      }
    }

    args.push('-progress', 'pipe:1', workingDest);

    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true });
      this.currentProcess = child;

      child.stderr.on('data', chunk => this.emit('log', chunk.toString()));
      
      // Como é stream copy, será muito rápido, progresso simples
      child.stdout.on('data', chunk => {
          this.emit('progress', { status: 'Copiando dados...' });
      });

      child.on('close', code => {
        // Limpar temporários
        if (fs.existsSync(metaTxtPath)) fs.unlinkSync(metaTxtPath);

        if (this.cancelRequested) {
          if (fs.existsSync(workingDest)) fs.unlinkSync(workingDest);
          return resolve({ status: 'canceled' });
        }

        if (code !== 0) {
          if (fs.existsSync(workingDest)) fs.unlinkSync(workingDest);
          return reject(new Error(`FFmpeg erro código ${code}`));
        }

        // Se for modo overwrite, substitui o original pelo tmp
        if (outMode === 'overwrite') {
          try {
            fs.unlinkSync(filePath); // deleta original
            fs.renameSync(workingDest, filePath); // renomeia novo
          } catch (e) {
            return reject(new Error('Falha ao substituir arquivo original: ' + e.message));
          }
        }

        resolve({ status: 'success' });
      });
    });
  }

  async cancel() {
    this.cancelRequested = true;
    if (this.currentProcess) {
      spawn('taskkill', ['/PID', String(this.currentProcess.pid), '/T', '/F'], { windowsHide: true });
    }
  }
}

module.exports = MetadataService;
