'use strict';

/**
 * Conserto automático da aceleração por placa de vídeo NVIDIA.
 *
 * A versão de desenvolvimento do FFmpeg (a padrão) exige uma interface NVENC nova (driver NVIDIA 610 ou mais). Em computador com
 * driver mais antigo o teste da placa falha ("Driver does not support the required nvenc API version"), o app cai para o
 * processador/Quick Sync e as conversões ficam lentas sem que ninguém saiba por quê. Este módulo percebe exatamente isso e
 * troca, no máximo duas vezes, o FFmpeg pela versão estável (que funciona com o driver mais antigo) e lembra a escolha
 * (configuração `ffmpegCanal`).
 *
 * Só age quando TODAS as condições valem: o teste de uma placa NVIDIA falhou por causa da versão da interface NVENC; o FFmpeg
 * instalado é de desenvolvimento ("N-123-g…"); não há conversão nem outro download em andamento; e ainda não tentou mais que 2
 * vezes (sem laço). Computadores onde a placa funciona nunca são tocados.
 */
const NVENC_VERSION_ERROR = /required nvenc API version|minimum required Nvidia driver/i;
const DEV_BUILD = /\bN-\d+/;
const MAX_TRIES = 2;
const MIN_GAP_MS = 6 * 3600 * 1000;

/** A mensagem de erro de um teste de encoder indica driver NVIDIA antigo para este FFmpeg? */
const isNvencVersionError = (message) => NVENC_VERSION_ERROR.test(String(message || ''));

/** A 1ª linha do "ffmpeg -version" é de uma versão de desenvolvimento ("ffmpeg version N-123456-gabcdef")? */
const isDevBuildVersion = (versionLine) => DEV_BUILD.test(String(versionLine || ''));

class FfmpegAutoFix {
  /**
   * @param {{ updater: { update: Function, ffmpegPreferStable?: boolean }, getSettings: () => object, saveSettings: (patch: object) => void,
   *           getFfmpegVersion: () => Promise<string|null>, isBusy?: () => boolean, onFixed?: () => void, logger?: object, now?: () => number }} o
   */
  constructor({ updater, getSettings, saveSettings, getFfmpegVersion, isBusy = () => false, onFixed = () => {}, logger = console, now = () => Date.now() }) {
    Object.assign(this, { updater, getSettings, saveSettings, getFfmpegVersion, isBusy, onFixed, logger, now });
    this.running = false;
  }

  _state() { const s = (this.getSettings() || {}).ffmpegAutoFix; return s && typeof s === 'object' ? s : { tentativas: 0, ultima: 0 }; }

  /** O canal já escolhido (estável) vale também nas próximas vezes que o FFmpeg for baixado. */
  applyChannel() { this.updater.ffmpegPreferStable = ((this.getSettings() || {}).ffmpegCanal === 'estavel'); }

  /**
   * Chamado quando o teste de uma placa NVIDIA falhou com `message`. Troca o FFmpeg se for o caso.
   * @returns {Promise<{ acao: 'trocou'|'nada'|'falhou'|'aguardando', motivo?: string }>}
   */
  async check(message) {
    if (this.running) return { acao: 'nada', motivo: 'já em andamento' };
    this.running = true; // vale desde já: duas chamadas ao mesmo tempo nunca trocam duas vezes
    try {
      if (!isNvencVersionError(message)) return { acao: 'nada', motivo: 'a placa não falhou por versão do driver' };
      let version = null;
      try { version = await this.getFfmpegVersion(); } catch (_) { /* sem versão: não troca */ }
      if (!isDevBuildVersion(version)) return { acao: 'nada', motivo: 'a versão instalada já é a estável' };
      const st = this._state();
      if (st.tentativas >= MAX_TRIES) return { acao: 'nada', motivo: 'já tentou o máximo de vezes' };
      if (st.tentativas > 0 && this.now() - st.ultima < MIN_GAP_MS) return { acao: 'aguardando', motivo: 'nova tentativa só daqui a algumas horas' };
      if (this.isBusy()) return { acao: 'aguardando', motivo: 'há trabalho em andamento' };
      // a tentativa é anotada ANTES: se o app fechar no meio ou o download falhar, não entra em laço
      this.saveSettings({ ffmpegAutoFix: { tentativas: st.tentativas + 1, ultima: this.now() }, ffmpegCanal: 'estavel' });
      this.updater.ffmpegPreferStable = true;
      if (this.logger.info) this.logger.info('[FfmpegAutoFix] NVENC pede driver mais novo: trocando o FFmpeg pela versão estável');
      try {
        await this.updater.update('ffmpeg', null, { force: true });
        this.onFixed();
        return { acao: 'trocou' };
      } catch (e) {
        if (this.logger.warn) this.logger.warn('[FfmpegAutoFix] não conseguiu trocar o FFmpeg', { error: e && e.message });
        return { acao: 'falhou', motivo: e && e.message };
      }
    } finally { this.running = false; }
  }
}

module.exports = { FfmpegAutoFix, isNvencVersionError, isDevBuildVersion, NVENC_VERSION_ERROR, MAX_TRIES };
