const logger = require('../../services/logService');
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const execFilePromise = util.promisify(execFile);

class FFProbe {
    /**
     * @param {Object} options
     * @param {string} options.ffprobePath - Caminho completo para o executável ffprobe
     */
    constructor({ ffprobePath }) {
        this.ffprobePath = ffprobePath;
    }

    /**
     * Analisa um arquivo de mídia e retorna seus metadados essenciais.
     * @param {string} filePath - Caminho do vídeo/áudio
     * @returns {Promise<Object>} Metadados parseados
     */
    async analyze(filePath) {
        const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];

        try {
            // maxBuffer de 10MB e timeout de 30 segundos
            const { stdout } = await execFilePromise(this.ffprobePath, args, { maxBuffer: 1024 * 1024 * 10, timeout: 30000 });
            const data = JSON.parse(stdout);

            let duration = data.format?.duration ? parseFloat(data.format.duration) : 0;
            let filesize = data.format?.size ? parseInt(data.format.size, 10) : 0;
            let bitrate = data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : 0;

            let width = 0, height = 0, fps = 0, video_codec = null, audio_codec = null;
            const audio_streams = [];

            if (data.streams) {
                let audioIndex = 0;
                for (const stream of data.streams) {
                    if (stream.codec_type === 'video') {
                        width = stream.width || width;
                        height = stream.height || height;
                        video_codec = stream.codec_name || video_codec;
                        if (stream.r_frame_rate) {
                            const [num, den] = stream.r_frame_rate.split('/');
                            fps = den && den !== '0' ? parseFloat(num) / parseFloat(den) : 0;
                        }
                    } else if (stream.codec_type === 'audio') {
                        if (!audio_codec) audio_codec = stream.codec_name || null;
                        audio_streams.push({
                            index: audioIndex,
                            stream_index: stream.index,
                            codec_name: stream.codec_name,
                            channels: stream.channels || 2,
                            sample_rate: stream.sample_rate ? parseInt(stream.sample_rate, 10) : 48000,
                            title: stream.tags?.title || stream.tags?.handler_name || `Audio Track ${audioIndex + 1}`
                        });
                        audioIndex++;
                    }
                }
            }

            let creation_time = null;
            if (data.format?.tags?.creation_time) {
                creation_time = data.format.tags.creation_time;
            }

            return {
                duration,
                filesize,
                width,
                height,
                fps: parseFloat(fps.toFixed(2)),
                video_codec,
                audio_codec,
                audio_streams,
                bitrate,
                creation_time
            };
        } catch (error) {
            logger.error(`[FFProbe] Erro ao analisar ${filePath}:`, error.message);
            throw error;
        }
    }
}

module.exports = FFProbe;
