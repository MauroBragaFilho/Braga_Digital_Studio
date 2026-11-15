'use strict';

/**
 * youtubeCookieSession.js — ciclo de vida do arquivo com a sessão da conta do YouTube (uso opcional, desligado por padrão).
 *
 * O yt-dlp só consegue ler a sessão de um arquivo de texto (formato Netscape), em claro. Por isso o arquivo NÃO fica guardado:
 *   - só é criado quando um download ou uma consulta de link do YouTube precisa dele (`acquire`);
 *   - é apagado quando o último processo que o usa termina (`release`): o yt-dlp grava o arquivo de volta ao sair, então apagar
 *     no meio do processo não adiantaria;
 *   - restos de um travamento ou de versões anteriores são apagados ao abrir o app (`purgeStale`) e ao fechar (`disposeSync`).
 * Com o uso da conta desligado, `acquire` devolve null e nenhum arquivo é criado. O conteúdo do arquivo nunca é logado.
 */
class YoutubeCookieSession {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.isEnabled              o usuário ligou o uso da conta nos downloads?
   * @param {() => Promise<string|null>} opts.exportFile cria o arquivo a partir da sessão do app e devolve o caminho (ou null)
   * @param {() => Promise<any>} opts.deleteFile         apaga o arquivo
   * @param {() => void} [opts.deleteFileSync]           idem, síncrono (encerramento do app)
   * @param {() => Promise<number>} [opts.purge]         apaga restos gerados pelo app (versões antigas, travamentos)
   * @param {() => Promise<{valid:boolean, expiresAt:number|null, reason:string|null}>} [opts.inspectSession]
   *        estado da sessão lido direto da sessão do app (nada é gravado em disco)
   * @param {object} [opts.logger]
   */
  constructor({ isEnabled, exportFile, deleteFile, deleteFileSync = null, purge = null, inspectSession = null, logger = null } = {}) {
    this._isEnabled = typeof isEnabled === 'function' ? isEnabled : () => false;
    this._exportFile = exportFile;
    this._deleteFile = deleteFile;
    this._deleteFileSync = deleteFileSync;
    this._purge = purge;
    this._inspectSession = inspectSession;
    this.logger = logger;
    this._leases = 0;       // processos usando o arquivo agora
    this._file = null;      // caminho do arquivo criado (null = não existe)
    this._chain = Promise.resolve();
  }

  /** O uso da conta está ligado? */
  get enabled() {
    try { return this._isEnabled() === true; } catch (_) { return false; }
  }

  /** Quantos processos estão usando o arquivo agora (para testes e diagnóstico). */
  get leases() { return this._leases; }

  /** Operações no arquivo (criar e apagar) uma de cada vez: nunca se apaga o arquivo enquanto outro pedido o cria. */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  /**
   * Pede o arquivo da sessão. Devolve { file, release } ou null (uso da conta desligado, sem login ou falha).
   * Quem pede DEVE chamar release() quando o processo terminar.
   */
  acquire() {
    return this._serial(async () => {
      if (!this.enabled) return null;
      // Já em uso por outro processo: reaproveita o arquivo (reescrevê-lo agora poderia colidir com quem o está lendo)
      if (!(this._leases > 0 && this._file)) {
        let file = null;
        try { file = await this._exportFile(); } catch (err) {
          this._log('warn', 'Falha ao preparar a sessão da conta do YouTube', { error: err && err.message });
        }
        if (!file) return null;
        this._file = file;
      }
      this._leases += 1;
      let released = false;
      return {
        file: this._file,
        release: () => {
          if (released) return Promise.resolve();
          released = true;
          return this._serial(async () => {
            this._leases = Math.max(0, this._leases - 1);
            if (this._leases === 0) await this._remove();
          });
        }
      };
    });
  }

  /** Apaga o arquivo agora (sair da conta, desligar o uso da conta). Quem ainda usa o arquivo o apaga de novo ao terminar. */
  dispose() {
    return this._serial(() => this._remove());
  }

  /** Encerramento do app: apaga o arquivo sem esperar nada (best effort). */
  disposeSync() {
    try { if (this._deleteFileSync) this._deleteFileSync(); } catch (_) { /* encerrando */ }
    this._file = null;
  }

  /** Ao abrir o app: apaga arquivos de sessão que sobraram de um travamento ou de versões anteriores. */
  async purgeStale() {
    try { return this._purge ? await this._purge() : 0; } catch (err) {
      this._log('warn', 'Falha ao limpar arquivos antigos da sessão', { error: err && err.message });
      return 0;
    }
  }

  /** Estado da sessão para a tela: { enabled, valid, expiresAt, reason }. Não cria arquivo. */
  async status() {
    if (!this.enabled) return { enabled: false, valid: false, expiresAt: null, reason: 'desligado' };
    let info = { valid: false, expiresAt: null, reason: 'sem leitura' };
    try { if (this._inspectSession) info = await this._inspectSession(); } catch (_) { /* segue sem sessão */ }
    return { enabled: true, valid: info.valid === true, expiresAt: info.expiresAt || null, reason: info.reason || null };
  }

  async _remove() {
    try { await this._deleteFile(); } catch (err) {
      this._log('warn', 'Falha ao apagar o arquivo da sessão do YouTube', { error: err && err.message });
    }
    this._file = null;
  }

  _log(level, msg, meta) {
    try { this.logger && this.logger[level] && this.logger[level](msg, meta); } catch (_) { /* log opcional */ }
  }
}

module.exports = YoutubeCookieSession;
