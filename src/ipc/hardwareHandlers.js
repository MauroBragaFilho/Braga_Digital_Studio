'use strict';

const { handle } = require('./channelRegistry');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');

/** Informações de hardware/encoders (GPU + FFmpeg). `deps` = { settingsManager }. */
module.exports = function registerHardwareHandlers({ settingsManager }) {
  // Informações de hardware (GPU + encoders) para a aba Sistema das Configurações.
  handle('system:getHardwareInfo', async () => {
    const hardwareDetection = require('../core/HardwareDetectionService');
    hardwareDetection.configure(settingsManager.load());
    const ffmpegPath = ffmpegTool.resolve({ mustExist: false });
    return await hardwareDetection.getSystemHardwareInfo(ffmpegPath || null);
  });

  // Lista de encoders disponíveis no FFmpeg (para validação na tela Conversor).
  handle('system:checkEncoders', async () => {
    const hardwareDetection = require('../core/HardwareDetectionService');
    hardwareDetection.configure(settingsManager.load());
    const ffmpegPath = ffmpegTool.resolve({ mustExist: false });
    if (!ffmpegPath) return [];
    const set = await hardwareDetection.listEncoders(ffmpegPath);
    return [...set].sort();
  });
};
