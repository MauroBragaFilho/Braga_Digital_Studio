const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class UploadScannerService {
    constructor(options = {}) {
        this.paths = options.paths || {};
        this.ffprobePath = options.ffprobePath || path.join(this.paths.dataDir || '', 'ffprobe.exe');
        this.ffmpegPath = options.ffmpegPath || path.join(this.paths.dataDir || '', 'ffmpeg.exe');
        this.thumbnailsDir = path.join(this.paths.dataDir || '', 'Thumbnails');
        
        if (!fs.existsSync(this.thumbnailsDir)) {
            fs.mkdirSync(this.thumbnailsDir, { recursive: true });
        }
    }

    async scanDirectory(dirPath) {
        if (!dirPath || !fs.existsSync(dirPath)) {
            return { tree: [], files: [] };
        }

        const files = [];
        const tree = await this._buildTree(dirPath);
        await this._collectFiles(dirPath, files);

        return { tree, files };
    }

    async _buildTree(dirPath) {
        const stats = fs.statSync(dirPath);
        const name = path.basename(dirPath);

        if (!stats.isDirectory()) {
            return null;
        }

        const children = [];
        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                const fullPath = path.join(dirPath, item);
                const itemStats = fs.statSync(fullPath);
                if (itemStats.isDirectory()) {
                    const childTree = await this._buildTree(fullPath);
                    if (childTree) children.push(childTree);
                }
            }
        } catch (e) {
            console.error(`Erro ao ler diretório ${dirPath}:`, e);
        }

        return {
            name,
            path: dirPath,
            type: 'folder',
            children
        };
    }

    async _collectFiles(dirPath, fileList) {
        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                const fullPath = path.join(dirPath, item);
                const stats = fs.statSync(fullPath);

                if (stats.isDirectory()) {
                    await this._collectFiles(fullPath, fileList);
                } else if (this._isVideoFile(item)) {
                    const metadata = await this.getVideoMetadata(fullPath);
                    fileList.push({
                        id: Buffer.from(fullPath).toString('base64'),
                        name: item,
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
        } catch (e) {
            console.error(`Erro ao coletar arquivos de ${dirPath}:`, e);
        }
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

        if (!fs.existsSync(this.ffprobePath)) {
            return defaultMeta;
        }

        return new Promise((resolve) => {
            const args = [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                filePath
            ];

            const proc = spawn(this.ffprobePath, args);
            let output = '';

            proc.stdout.on('data', (data) => output += data.toString());
            proc.on('close', async (code) => {
                if (code !== 0 || !output) {
                    return resolve(defaultMeta);
                }

                try {
                    const parsed = JSON.parse(output);
                    const videoStream = parsed.streams?.find(s => s.codec_type === 'video');
                    const durationSec = parseFloat(parsed.format?.duration || videoStream?.duration || 0);
                    
                    const width = videoStream?.width || 1920;
                    const height = videoStream?.height || 1080;
                    
                    let fps = 30;
                    if (videoStream?.r_frame_rate) {
                        const parts = videoStream.r_frame_rate.split('/');
                        if (parts.length === 2 && parseFloat(parts[1]) > 0) {
                            fps = Math.round(parseFloat(parts[0]) / parseFloat(parts[1]));
                        }
                    }

                    const formatTime = (seconds) => {
                        const h = Math.floor(seconds / 3600);
                        const m = Math.floor((seconds % 3600) / 60);
                        const s = Math.floor(seconds % 60);
                        if (h > 0) {
                            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                        }
                        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                    };

                    const thumbPath = await this._generateThumbnail(filePath);

                    resolve({
                        title: path.basename(filePath, path.extname(filePath)),
                        duration: formatTime(durationSec),
                        durationSec,
                        resolution: `${width}x${height}`,
                        fps,
                        thumbnail: thumbPath,
                        status: 'Pronto para envio'
                    });
                } catch (e) {
                    resolve(defaultMeta);
                }
            });

            proc.on('error', () => resolve(defaultMeta));
        });
    }

    async _generateThumbnail(filePath) {
        if (!fs.existsSync(this.ffmpegPath)) return null;

        const hash = Buffer.from(filePath).toString('hex').substring(0, 16);
        const thumbName = `thumb_upl_${hash}.jpg`;
        const outputPath = path.join(this.thumbnailsDir, thumbName);

        if (fs.existsSync(outputPath)) {
            return `file://${outputPath.replace(/\\/g, '/')}`;
        }

        return new Promise((resolve) => {
            const args = [
                '-ss', '00:00:02',
                '-i', filePath,
                '-frames:v', '1',
                '-q:v', '2',
                '-y',
                outputPath
            ];

            const proc = spawn(this.ffmpegPath, args);
            proc.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    resolve(`file://${outputPath.replace(/\\/g, '/')}`);
                } else {
                    resolve(null);
                }
            });
            proc.on('error', () => resolve(null));
        });
    }
}

module.exports = UploadScannerService;
