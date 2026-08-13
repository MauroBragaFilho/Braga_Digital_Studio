const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('../../services/logService');

class HardwareDetectionService {
  constructor() {
    this.cachedBestEncoder = {
      h264: null,
      hevc: null,
      av1: null
    };
  }

  async testEncoder(ffmpegPath, encoder) {
    if (!fs.existsSync(ffmpegPath)) return false;

    return new Promise((resolve) => {
      const child = spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-f', 'lavfi',
          '-i', 'nullsrc=s=64x64:d=1',
          '-c:v', encoder,
          '-f', 'null',
          '-'
        ],
        { windowsHide: true }
      );
      child.on('close', code => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  async detectEncoder(ffmpegPath, codecChoice = 'H.264') {
    if (codecChoice === 'H.264' || codecChoice === 'h264') {
      if (this.cachedBestEncoder.h264) return this.cachedBestEncoder.h264;

      if (await this.testEncoder(ffmpegPath, 'h264_nvenc')) {
        this.cachedBestEncoder.h264 = 'h264_nvenc';
        return 'h264_nvenc';
      }
      if (await this.testEncoder(ffmpegPath, 'h264_qsv')) {
        this.cachedBestEncoder.h264 = 'h264_qsv';
        return 'h264_qsv';
      }
      if (await this.testEncoder(ffmpegPath, 'h264_amf')) {
        this.cachedBestEncoder.h264 = 'h264_amf';
        return 'h264_amf';
      }
      
      this.cachedBestEncoder.h264 = 'libx264';
      return 'libx264';
    }

    if (codecChoice === 'H.265' || codecChoice === 'HEVC' || codecChoice === 'hevc' || codecChoice === 'h265') {
      if (this.cachedBestEncoder.hevc) return this.cachedBestEncoder.hevc;

      if (await this.testEncoder(ffmpegPath, 'hevc_nvenc')) {
        this.cachedBestEncoder.hevc = 'hevc_nvenc';
        return 'hevc_nvenc';
      }
      if (await this.testEncoder(ffmpegPath, 'hevc_qsv')) {
        this.cachedBestEncoder.hevc = 'hevc_qsv';
        return 'hevc_qsv';
      }
      if (await this.testEncoder(ffmpegPath, 'hevc_amf')) {
        this.cachedBestEncoder.hevc = 'hevc_amf';
        return 'hevc_amf';
      }
      
      this.cachedBestEncoder.hevc = 'libx265';
      return 'libx265';
    }

    if (codecChoice === 'AV1' || codecChoice === 'av1') {
      if (this.cachedBestEncoder.av1) return this.cachedBestEncoder.av1;

      if (await this.testEncoder(ffmpegPath, 'av1_nvenc')) {
        this.cachedBestEncoder.av1 = 'av1_nvenc';
        return 'av1_nvenc';
      }
      if (await this.testEncoder(ffmpegPath, 'av1_qsv')) {
        this.cachedBestEncoder.av1 = 'av1_qsv';
        return 'av1_qsv';
      }
      if (await this.testEncoder(ffmpegPath, 'av1_amf')) {
        this.cachedBestEncoder.av1 = 'av1_amf';
        return 'av1_amf';
      }
      
      this.cachedBestEncoder.av1 = 'libsvtav1';
      return 'libsvtav1';
    }

    return 'libx264';
  }

  getQualitySettings(encoder, quality = 'Alta') {
    let cqArg = '-crf';
    let isHw = !encoder.startsWith('lib');
    if (encoder.includes('nvenc')) cqArg = '-cq';
    if (encoder.includes('qsv')) cqArg = '-global_quality';
    
    // Baixa, Média, Alta, Muito Alta
    let crfVal = '23';
    if (quality === 'Baixa') crfVal = '28';
    if (quality === 'Alta') crfVal = '18';
    if (quality === 'Muito Alta') crfVal = '14';

    const args = [];
    if (isHw) {
        if (encoder.includes('nvenc')) {
             args.push('-preset', 'p5', '-cq', crfVal);
        } else if (encoder.includes('qsv')) {
             args.push('-global_quality', crfVal);
        } else if (encoder.includes('amf')) {
             args.push('-usage', 'transcoding', '-quality', 'quality', '-qp_i', crfVal, '-qp_p', crfVal);
        }
    } else {
        args.push('-preset', 'medium', '-crf', crfVal);
    }
    
    return args;
  }
}

module.exports = new HardwareDetectionService();
