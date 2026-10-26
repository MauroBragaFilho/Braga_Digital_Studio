'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { STUDIO_SELECTORS, PERCENT_RE, UPLOADED_RE } = require('./studioSelectors');

/**
 * YoutubeStudioDriver — dirige a página do YouTube Studio embutida na tela Envio (<webview>) para enviar um
 * vídeo como se fosse o usuário: abre o diálogo de envio, escolhe o arquivo (via protocolo DevTools,
 * `DOM.setFileInputFiles`), preenche título/descrição, marca "não é para crianças", avança até a visibilidade
 * e acompanha o progresso até o botão Concluir.
 *
 * Todos os seletores ficam em studioSelectors.js. Entre uma ação e outra há uma espera aleatória curta
 * (ritmo humano). Se a página cair em uma tela de verificação do Google, lança erro `code: 'EATTENTION'`.
 *
 * `guest` é o WebContents do webview (precisa estar em https://studio.youtube.com).
 */

const STEP_DELAY_MS = [500, 1500];       // espera aleatória entre ações
const FIND_TIMEOUT_MS = 60_000;          // para um elemento aparecer
const UPLOAD_TIMEOUT_MS = 6 * 3600_000;  // para o arquivo subir
const POLL_MS = 1500;

class AttentionError extends Error {
  constructor(message) { super(message); this.code = 'EATTENTION'; }
}
class CancelledError extends Error {
  constructor() { super('Envio cancelado.'); this.code = 'ECANCELLED'; }
}

const SAFE_VISIBILITY = new Set(['private', 'unlisted', 'public']);

/** Código executado NA PÁGINA: utilitários comuns (primeiro seletor existente, texto visível, clique). */
const PAGE_HELPERS = `
  const __bds = {
    one(sel) {
      const m = /^(.*)@@(\\d+)$/.exec(sel);
      if (!m) return document.querySelector(sel);
      return document.querySelectorAll(m[1])[Number(m[2])] || null;
    },
    find(list) {
      for (const sel of list) { try { const el = __bds.one(sel); if (el) return el; } catch (_) {} }
      return null;
    },
    // Retrato da página para o log quando algo esperado não aparece (o Studio muda sem aviso)
    snapshot() {
      const dlg = document.querySelector('ytcp-uploads-dialog');
      const ids = (root, tag) => [...root.querySelectorAll(tag)].map((e) => e.id || e.getAttribute('name') || e.tagName.toLowerCase()).slice(0, 25);
      return {
        url: location.href,
        title: document.title,
        dialog: !!dlg,
        dialogText: dlg ? String(dlg.innerText || '').replace(/\\s+/g, ' ').slice(0, 600) : '',
        textboxes: document.querySelectorAll('#textbox').length,
        fileInputs: [...document.querySelectorAll('input[type="file"]')].map((i) => (i.id || i.className || 'input') + ':' + (i.files ? i.files.length : '?')),
        buttons: ids(dlg || document, 'ytcp-button, button'),
        bodyText: String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 300)
      };
    },
    visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    },
    text(el) { return el ? String(el.innerText || el.textContent || '').trim() : ''; },
    click(el) {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      }
      return true;
    },
    type(el, value) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      if (value) document.execCommand('insertText', false, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return __bds.text(el);
    }
  };
`;

class YoutubeStudioDriver {
  /**
   * @param {import('electron').WebContents} guest
   * @param {{ sleep?: Function, random?: Function, logger?: object }} [opts]
   */
  constructor(guest, { sleep = null, random = null, logger = null } = {}) {
    if (!guest || typeof guest.executeJavaScript !== 'function') throw new Error('Página do YouTube Studio indisponível.');
    this.guest = guest;
    this.logger = logger;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._random = random || Math.random;
    this._cancelled = false;
    this._busy = false;
  }

  get busy() { return this._busy; }

  /** Pede para abortar o envio atual (a fila chama ao pausar/remover). */
  cancel() { this._cancelled = true; }

  /**
   * Envia um vídeo. `onProgress({ progress, stage })` é chamado ao longo do caminho.
   * @returns {Promise<{ videoUrl: string|null }>}
   */
  async upload(item, { onProgress = () => {} } = {}) {
    if (this._busy) throw new Error('Já existe um envio em andamento.');
    if (!item || !item.path || !fs.existsSync(item.path)) throw new Error('Arquivo de vídeo não encontrado.');
    this._busy = true;
    this._cancelled = false;
    const S = STUDIO_SELECTORS;
    try {
      await this._ensureStudio();
      onProgress({ progress: 0, stage: 'Abrindo o envio' });

      await this._openUploadDialog();
      await this._humanPause();

      // Arquivo: o input de arquivo só aceita caminho via DevTools
      const inputSel = await this._waitFor(S.fileInput, { visibleOnly: false });
      await this._setFileInput(inputSel, item.path);
      await this._confirmFileAccepted(inputSel);
      onProgress({ progress: 1, stage: 'Enviando' });

      // Detalhes (o diálogo troca o seletor de arquivo pelo formulário)
      await this._waitFor(S.titleBox);
      await this._humanPause();
      await this._typeInto(S.titleBox, item.title || path.basename(item.path, path.extname(item.path)));
      await this._humanPause();
      if (item.description) await this._typeInto(S.descriptionBox, item.description);
      await this._humanPause();
      // Miniatura e playlist não derrubam o envio: se o Studio não cooperar, vira um aviso no item
      const warnings = [];
      if (item.thumbnail) {
        try { await this._setThumbnail(item.thumbnail); } catch (err) { if (err && (err.code === 'EATTENTION' || err.code === 'ECANCELLED')) throw err; warnings.push(`Miniatura não aplicada: ${err.message}`); }
        await this._humanPause();
      }
      if (item.playlist) {
        try { await this._selectPlaylist(item.playlist); } catch (err) { if (err && (err.code === 'EATTENTION' || err.code === 'ECANCELLED')) throw err; warnings.push(`Playlist não aplicada: ${err.message}`); }
        await this._humanPause();
      }
      await this._clickIfPresent(S.notMadeForKids);

      // Próximo ×3 (Detalhes → Elementos → Verificações → Visibilidade)
      for (let i = 0; i < 3; i++) {
        await this._humanPause();
        await this._click(S.nextButton);
      }
      const vis = SAFE_VISIBILITY.has(item.visibility) ? item.visibility : 'private';
      await this._humanPause();
      await this._click(S.visibility[vis]);

      // Espera o upload do arquivo terminar (o processamento pode continuar depois)
      const videoUrl = await this._waitUpload(onProgress);
      onProgress({ progress: 100, stage: 'Concluindo' });
      await this._humanPause();
      await this._click(S.doneButton);
      await this._humanPause();
      await this._clickIfPresent(S.closeButton); // "ainda processando" (quando aparece)
      return { videoUrl, warnings };
    } finally {
      this._busy = false;
    }
  }

  // ------------------------------------------------------------------ passos

  async _ensureStudio() {
    const url = this._url();
    if (!/^https:\/\/studio\.youtube\.com\//.test(url)) {
      await this._checkAttention();
      await this.guest.loadURL('https://studio.youtube.com/');
      await this._sleep(2000);
    }
    await this._checkAttention();
  }

  async _openUploadDialog() {
    const S = STUDIO_SELECTORS;
    // Diálogo já aberto (o usuário pode ter clicado antes)? Usa-o.
    if (await this._exists(S.fileInput)) return;
    // Caminho direto: o Studio abre o diálogo de envio com ?d=ud na página de vídeos do canal
    const m = this._url().match(/studio\.youtube\.com\/channel\/(UC[\w-]+)/);
    if (m) {
      await this.guest.loadURL(`https://studio.youtube.com/channel/${m[1]}/videos/upload?d=ud`);
      try { await this._waitFor(S.fileInput, { timeout: 20_000, visibleOnly: false }); return; } catch (_) { /* cai no clique */ }
    }
    await this._click(S.createButton);
    await this._humanPause();
    await this._click(S.uploadMenuItem);
  }

  /** Define o arquivo no <input type=file> via protocolo DevTools (JS da página não pode fazê-lo). */
  async _setFileInput(selector, filePath) {
    const dbg = this.guest.debugger;
    if (!dbg) throw new Error('Depurador indisponível para escolher o arquivo.');
    let attached = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      let nodeId = 0;
      // querySelector do protocolo não atravessa shadow DOM: tenta o seletor normal e, se falhar, usa pierce via JS
      try { ({ nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })); } catch (_) { nodeId = 0; }
      if (!nodeId) {
        const { result } = await dbg.sendCommand('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el; })()`,
          returnByValue: false
        });
        if (!result || !result.objectId) throw new Error('Campo de arquivo não encontrado no YouTube Studio.');
        const node = await dbg.sendCommand('DOM.requestNode', { objectId: result.objectId });
        nodeId = node.nodeId;
      }
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    } finally {
      if (attached) { try { dbg.detach(); } catch (_) { /* já desanexado */ } }
    }
  }

  /** Miniatura personalizada: o campo de arquivo do editor de miniaturas recebe a imagem (via DevTools). */
  async _setThumbnail(imagePath) {
    if (!fs.existsSync(imagePath)) throw new Error('arquivo de imagem não encontrado.');
    const S = STUDIO_SELECTORS;
    // O editor de miniaturas só fica disponível depois que o Studio reconhece o vídeo
    const sel = await this._waitFor(S.thumbnailInput, { timeout: 45_000, visibleOnly: false });
    await this._setFileInput(sel, imagePath);
    this._log('info', '[YoutubeUpload] Miniatura definida', { file: path.basename(imagePath) });
  }

  /**
   * Playlist: abre o menu de playlists, marca a que tem exatamente o nome pedido (sem diferenciar maiúsculas) e
   * clica em Concluído. Se não existir uma playlist com esse nome, fecha o menu e lança erro (vira aviso no item).
   */
  async _selectPlaylist(name) {
    const S = STUDIO_SELECTORS;
    const wanted = String(name).trim().toLowerCase();
    await this._click(S.playlistTrigger);
    await this._waitFor(S.playlistDialog);
    await this._sleep(1200); // a lista carrega depois que o diálogo abre
    const result = await this._eval(`
      const items = [];
      for (const sel of ${JSON.stringify(S.playlistItems)}) { try { const found = [...document.querySelectorAll(sel)]; if (found.length) { items.push(...found); break; } } catch (_) {} }
      const names = [];
      let hit = null;
      for (const li of items) {
        let label = null;
        for (const s of ${JSON.stringify(S.playlistItemLabel)}) { try { label = li.querySelector(s); } catch (_) {} if (label) break; }
        const text = __bds.text(label || li).toLowerCase();
        names.push(text);
        if (text === ${JSON.stringify(wanted)}) { hit = li; break; }
      }
      if (!hit) return { ok: false, names: names.slice(0, 50) };
      const box = hit.matches('[role="checkbox"], tp-yt-paper-checkbox, ytcp-checkbox-lit') ? hit : (hit.querySelector('[role="checkbox"], tp-yt-paper-checkbox, ytcp-checkbox-lit, #checkbox') || hit);
      const already = box.getAttribute('aria-checked') === 'true' || box.hasAttribute('checked');
      if (!already) __bds.click(box);
      return { ok: true, already };
    `);
    if (!result || !result.ok) {
      await this._clickIfPresent(S.playlistCancel) || await this._clickIfPresent(S.playlistDone);
      const list = result && result.names && result.names.length ? ` Playlists vistas: ${result.names.slice(0, 8).join(', ')}.` : '';
      throw new Error(`não há playlist chamada "${name}" na conta.${list}`);
    }
    await this._humanPause();
    await this._click(S.playlistDone);
    this._log('info', '[YoutubeUpload] Playlist escolhida', { playlist: name, already: result.already });
  }

  /**
   * Confere que o Studio recebeu o arquivo: o diálogo deve sair da tela de escolha em alguns segundos. Se o input
   * ficou com o arquivo mas a página não reagiu, dispara `change` à mão (alguns componentes só ouvem esse evento).
   */
  async _confirmFileAccepted(inputSel) {
    const S = STUDIO_SELECTORS;
    const state = await this._eval(`
      const input = __bds.one(${JSON.stringify(inputSel)});
      return { files: input && input.files ? input.files.length : -1, title: !!__bds.find(${JSON.stringify(S.titleBox)}) };
    `).catch(() => ({ files: -1, title: false }));
    this._log('info', '[YoutubeUpload] Arquivo definido no diálogo', state);
    if (state.title) return;
    await this._sleep(4000);
    const reacted = await this._exists(S.titleBox);
    if (reacted) return;
    await this._eval(`
      const input = __bds.one(${JSON.stringify(inputSel)});
      if (input) { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    `).catch(() => false);
  }

  async _waitUpload(onProgress) {
    const S = STUDIO_SELECTORS;
    const started = Date.now();
    let lastPercent = -1;
    let stableNoPercent = 0;
    while (Date.now() - started < UPLOAD_TIMEOUT_MS) {
      this._throwIfCancelled();
      await this._checkAttention();
      const info = await this._eval(`
        const label = __bds.text(__bds.find(${JSON.stringify(S.progressLabel)}));
        const error = __bds.text(__bds.find(${JSON.stringify(S.errorLabel)}));
        const link = __bds.find(${JSON.stringify(S.videoLink)});
        const done = __bds.find(${JSON.stringify(S.doneButton)});
        return { label, error, href: link ? link.href : null, doneEnabled: !!done && !done.hasAttribute('disabled') && done.getAttribute('aria-disabled') !== 'true' };
      `);
      if (info.error) {
        if (S.limitText.test(info.error)) throw new AttentionError('O YouTube informou que o limite diário de envios da conta foi atingido. Tente novamente amanhã.');
        throw new Error(`O YouTube recusou o envio: ${info.error}`);
      }
      const pm = info.label.match(PERCENT_RE);
      if (pm) {
        const pct = Number(pm[1]);
        if (pct !== lastPercent) { lastPercent = pct; onProgress({ progress: Math.max(1, Math.min(99, pct)), stage: 'Enviando' }); }
        stableNoPercent = 0;
      } else if (info.label && UPLOADED_RE.test(info.label)) {
        return info.href;
      } else if (lastPercent >= 0 || info.doneEnabled) {
        // Rótulo sem porcentagem depois de ter mostrado progresso: upload terminou (texto em idioma desconhecido)
        if (++stableNoPercent >= 3) return info.href;
      }
      await this._sleep(POLL_MS);
    }
    throw new Error('O envio demorou demais e foi interrompido.');
  }

  // ------------------------------------------------------------------ primitivas de página

  _url() { try { return String(this.guest.getURL() || ''); } catch (_) { return ''; } }

  async _eval(body) {
    if (this.guest.isDestroyed && this.guest.isDestroyed()) throw new Error('A página do YouTube Studio foi fechada.');
    return this.guest.executeJavaScript(`(() => { ${PAGE_HELPERS} ${body} })()`, true);
  }

  async _exists(selectors, visibleOnly = true) {
    try {
      return await this._eval(`const el = __bds.find(${JSON.stringify(selectors)}); return !!el && (${visibleOnly ? '__bds.visible(el)' : 'true'});`);
    } catch (_) { return false; }
  }

  /** Espera um dos seletores existir; devolve o seletor que casou. Um erro do diálogo interrompe a espera. */
  async _waitFor(selectors, { timeout = FIND_TIMEOUT_MS, visibleOnly = true } = {}) {
    const started = Date.now();
    const S = STUDIO_SELECTORS;
    while (Date.now() - started < timeout) {
      this._throwIfCancelled();
      await this._checkAttention();
      const r = await this._eval(`
        for (const sel of ${JSON.stringify(selectors)}) {
          let el = null; try { el = __bds.one(sel); } catch (_) {}
          if (el && (${visibleOnly ? '__bds.visible(el)' : 'true'})) return { found: sel };
        }
        const err = __bds.find(${JSON.stringify(S.errorLabel)});
        return { found: null, error: err && __bds.visible(err) ? __bds.text(err) : '' };
      `).catch(() => ({ found: null, error: '' }));
      if (r && r.found) return r.found;
      if (r && r.error) {
        if (S.limitText.test(r.error)) throw new AttentionError('O YouTube informou que o limite diário de envios da conta foi atingido. Tente novamente amanhã.');
        throw new Error(`O YouTube recusou o envio: ${r.error}`);
      }
      await this._sleep(500);
    }
    const snap = await this._eval('return __bds.snapshot();').catch(() => null);
    this._log('warn', '[YoutubeUpload] Elemento não encontrado no YouTube Studio', { selectors, snapshot: snap });
    const hint = snap ? ` Página: ${snap.dialog ? 'diálogo aberto' : 'sem diálogo de envio'}, ${snap.textboxes} caixa(s) de texto, arquivo: ${snap.fileInputs.join(' ') || 'nenhum'}.` : '';
    throw new Error(`O YouTube Studio não mostrou o elemento esperado (${selectors[0]}). A página pode ter mudado.${hint}`);
  }

  _log(level, msg, meta) {
    try { this.logger && this.logger[level] && this.logger[level](msg, meta); } catch (_) { /* log opcional */ }
  }

  async _click(selectors) {
    await this._waitFor(selectors);
    const ok = await this._eval(`const el = __bds.find(${JSON.stringify(selectors)}); if (!el) return false; __bds.click(el); return true;`);
    if (!ok) throw new Error(`Não foi possível clicar em ${selectors[0]}.`);
  }

  async _clickIfPresent(selectors) {
    try {
      return await this._eval(`const el = __bds.find(${JSON.stringify(selectors)}); if (!el || !__bds.visible(el)) return false; __bds.click(el); return true;`);
    } catch (_) { return false; }
  }

  async _typeInto(selectors, value) {
    await this._waitFor(selectors);
    await this._eval(`const el = __bds.find(${JSON.stringify(selectors)}); if (!el) return ''; return __bds.type(el, ${JSON.stringify(String(value))});`);
  }

  /** Página de login/verificação do Google ou texto de "confirme que é você": o usuário precisa agir. */
  async _checkAttention() {
    const url = this._url();
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { /* url vazia */ }
    if (STUDIO_SELECTORS.attentionHosts.includes(host)) {
      throw new AttentionError('O Google pediu para você confirmar a conta. Conclua a verificação na página e clique em Continuar.');
    }
    const text = await this._eval('return String(document.body ? document.body.innerText : "").slice(0, 4000);').catch(() => '');
    if (text && STUDIO_SELECTORS.attentionText.test(text) && !/studio\.youtube\.com\/channel\//.test(url)) {
      throw new AttentionError('O YouTube pediu uma confirmação. Resolva na página e clique em Continuar.');
    }
  }

  _throwIfCancelled() { if (this._cancelled) throw new CancelledError(); }

  async _humanPause() {
    const [min, max] = STEP_DELAY_MS;
    await this._sleep(Math.round(min + this._random() * (max - min)));
    this._throwIfCancelled();
  }
}

module.exports = YoutubeStudioDriver;
module.exports.AttentionError = AttentionError;
module.exports.CancelledError = CancelledError;
