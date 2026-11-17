const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegTool } = require('../../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../../infrastructure/external-tools/adapters/FfprobeTool');
const ffmpegLimiter = require('../media/FfmpegLimiter');

// Limites da varredura: evita laço por junção/atalho e pastas absurdamente profundas
const MAX_DEPTH = 32;
// Tempo máximo de cada ffprobe/ffmpeg (um arquivo corrompido ou travado não segura a varredura)
const PROC_TIMEOUT_MS = 30000;

/** Executa um processo dentro do limitador global de ffmpeg, com prazo; resolve { code, stdout }. */
function runTool(bin, args, timeoutMs = PROC_TIMEOUT_MS) {
    return ffmpegLimiter.run((signal) => new Promise((resolve) => {
        let stdout = '';
        let proc;
        try {
            proc = spawn(bin, args, { windowsHide: true });
        } catch (_) {
            resolve({ code: -1, stdout: '' });
            return;
        }
        const kill = () => { try { proc.kill('SIGKILL'); } catch (_) { /* já saiu */ } };
        if (signal) signal.addEventListener('abort', kill, { once: true });
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('close', (code) => resolve({ code, stdout }));
        proc.on('error', () => resolve({ code: -1, stdout: '' }));
    }), undefined, { timeoutMs }).catch(() => ({ code: -1, stdout: '' }));
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

class UploadScannerService {
    constructor(options = {}) {
        this.paths = options.paths || {};
        this.ffprobePath = options.ffprobePath || (this.paths.dataDir ? ffprobeTool.resolve({ mustExist: false }) : '');
        this.ffmpegPath = options.ffmpegPath || (this.paths.dataDir ? ffmpegTool.resolve({ mustExist: false }) : '');
        // Só com dataDir absoluto: antes, sem ele, a pasta Thumbnails era criada no diretório atual.
        const dataDir = this.paths.dataDir;
        this.thumbnailsDir = (typeof dataDir === 'string' && path.isAbsolute(dataDir))
            ? path.join(dataDir, 'Thumbnails')
            : null;

        if (this.thumbnailsDir && !fs.existsSync(this.thumbnailsDir)) {
            fs.mkdirSync(this.thumbnailsDir, { recursive: true });
        }
    }

    async scanDirectory(dirPath) {
        if (!dirPath || !fs.existsSync(dirPath)) {
            return { tree: [], files: [] };
        }

        const files = [];
        const tree = await this._walk(dirPath, files, new Set(), 0);

        return { tree, files };
    }

    /**
     * Percorre a pasta uma vez só (monta a árvore e coleta os vídeos juntos), de forma assíncrona,
     * sem seguir atalhos/junções e sem repetir pastas já visitadas.
     */
    async _walk(dirPath, fileList, visited, depth) {
        let real;
        try {
            const stats = await fs.promises.stat(dirPath);
            if (!stats.isDirectory()) return null;
            real = await fs.promises.realpath(dirPath);
        } catch (_) {
            return null;
        }
        const key = process.platform === 'win32' ? real.toLowerCase() : real;
        if (visited.has(key)) return null;
        visited.add(key);

        const node = { name: path.basename(dirPath), path: dirPath, type: 'folder', children: [] };
        if (depth >= MAX_DEPTH) return node;

        let entries;
        try {
            entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch (e) {
            console.error(`Erro ao ler diretório ${dirPath}:`, e);
            return node;
        }

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const child = await this._walk(fullPath, fileList, visited, depth + 1);
                if (child) node.children.push(child);
            } else if (entry.isFile() && this._isVideoFile(entry.name)) {
                let stats;
                try { stats = await fs.promises.stat(fullPath); } catch (_) { continue; }
                const metadata = await this.getVideoMetadata(fullPath);
                fileList.push({
                    id: Buffer.from(fullPath).toString('base64'),
                    name: entry.name,
                    path: fullPath,
                    dir: dirPath,
                    sizeBytes: stats.size,
                    sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                    createdAt: stats.birthtime,
                    modifiedAt: stats.mtime,
                    ...metadata
                });
            }
        }

        return node;
    }

    _isVideoFile(filename) {
        const ext = path.extname(filename).toLowerCase();
        return ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.ts'].includes(ext);
    }

    async getVideoMetadata(filePath) {
        const defaultMeta = {
            title: path.basename(filePath, path.extname(filePath)),
            duration: '00:00',
            durationSec: 0,
            resolution: '1920x1080',
            fps: 30,
            thumbnail: null,
            status: 'Pronto para envio'
        };

        if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) {
            return defaultMeta;
        }

        const { code, stdout } = await runTool(this.ffprobePath, [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ]);
        if (code !== 0 || !stdout) {
            return defaultMeta;
        }

        try {
            const parsed = JSON.parse(stdout);
            const videoStream = parsed.streams?.find(s => s.codec_type === 'video');
            const durationSec = parseFloat(parsed.format?.duration || videoStream?.duration || 0) || 0;

            const width = videoStream?.width || 1920;
            const height = videoStream?.height || 1080;

            let fps = 30;
            if (videoStream?.r_frame_rate) {
                const parts = videoStream.r_frame_rate.split('/');
                if (parts.length === 2 && parseFloat(parts[1]) > 0) {
                    fps = Math.round(parseFloat(parts[0]) / parseFloat(parts[1]));
                }
            }

            const thumbPath = await this._generateThumbnail(filePath, durationSec);

            return {
                title: path.basename(filePath, path.extname(filePath)),
                duration: formatTime(durationSec),
                durationSec,
                resolution: `${width}x${height}`,
                fps,
                thumbnail: thumbPath,
                status: 'Pronto para envio'
            };
        } catch (e) {
            return defaultMeta;
        }
    }

    async _generateThumbnail(filePath, durationSec = 0) {
        if (!this.thumbnailsDir || !this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) return null;

        // Chave pelo caminho completo + data de modificação: arquivos diferentes não dividem miniatura
        // e uma versão nova do mesmo arquivo gera outra.
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch (_) { /* sem data */ }
        const hash = crypto.createHash('sha1').update(`${path.resolve(filePath)}|${mtime}`).digest('hex').substring(0, 24);
        const thumbName = `thumb_upl_${hash}.jpg`;
        const outputPath = path.join(this.thumbnailsDir, thumbName);

        if (fs.existsSync(outputPath)) {
            return `file://${outputPath.replace(/\\/g, '/')}`;
        }

        // Quadro em 2 s, ou na metade de vídeos curtos (antes era sempre 2 s e falhava nos menores)
        const seek = durationSec > 0 && durationSec < 4 ? durationSec / 2 : 2;
        const { code } = await runTool(this.ffmpegPath, [
            '-ss', seek.toFixed(2),
            '-i', filePath,
            '-frames:v', '1',
            '-q:v', '2',
            '-y',
            outputPath
        ]);
        if (code === 0 && fs.existsSync(outputPath)) {
            return `file://${outputPath.replace(/\\/g, '/')}`;
        }
        return null;
    }
}

module.exports = UploadScannerService;
