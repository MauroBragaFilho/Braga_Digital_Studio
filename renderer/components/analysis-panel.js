/**
 * Card "Provedores" de Configurações → Inteligência Artificial. Reúne tudo da nuvem em quatro seções: Chat, Áudio,
 * Imagem e Vídeo. A seção Chat lista os servidores de IA do assistente e da análise de transcrições (Groq, Qwen,
 * LM Studio, Ollama, OpenAI ou outro compatível) na ORDEM DE PRIORIDADE: se o primeiro falhar, o próximo continua a
 * mesma conversa. Cada provedor é uma linha compacta (alça, nome, estado e interruptor); clicar abre a chave, o modelo
 * e o teste. Reordena arrastando ou pelas setas (que aparecem ao passar o mouse ou com o foco). A chave só é gravada
 * (criptografada no computador) e nunca volta para a tela: o campo fica sempre à vista e, com chave guardada, mostra
 * "Chave guardada, cole outra para trocar" (campo vazio não muda nada). As seções Áudio, Imagem e
 * Vídeo vêm de ai-audio-section.js e ai-media-sections.js. A configuração do chat é a mesma do assistente
 * (window.bds.ai*). Textos entram sempre por textContent.
 *
 * "Adicionar provedor" é um fluxo só: endereço + chave (ou um atalho que só preenche o endereço) -> "Procurar modelos"
 * (aiDiscoverProvider lista e classifica os modelos do servidor; nenhum conteúdo do usuário é enviado) -> resumo curto e
 * escolha do modelo de Conversa -> "Adicionar" (aiSaveConfig { commitDiscovery }). A chave digitada vai uma vez ao main,
 * que a segura num rascunho em memória; o campo é limpo assim que o pedido sai e o renderer nunca a guarda. As mensagens
 * de erro vêm do main (texto fixo do app), nunca do servidor.
 */
import { mountAudioSection, unmountAudioSection } from './ai-audio-section.js';
import { renderMediaSections } from './ai-media-sections.js';

let config = null;
let root = null;
let statusLine = null;                 // { text, kind } da linha geral (adicionar, ordem, fallback)
let cardStatus = new Map();            // id do provedor -> { text, kind } da linha do cartão
let expanded = new Set();              // provedores com os detalhes abertos
let confirmRemove = null;              // id do provedor cuja remoção está esperando confirmação
let modelLists = new Map();            // id -> ids de modelos listados pelo próprio provedor
let focusAfter = null;                 // seletor do elemento que recebe o foco depois de redesenhar
let addUrl = '';                       // endereço digitado em "Adicionar provedor" (a chave NÃO é guardada aqui)
let addShortcut = null;                // atalho tocado (id), só para saber se a chave é obrigatória
let addOpen = false;                   // bloco "Adicionar provedor" aberto pelo usuário
let addError = '';                     // erro da busca (texto fixo vindo do main)
let keyCleared = false;                // a chave foi enviada e apagada do campo: o texto de ajuda manda colar de novo
let discovery = null;                  // null | { busy } | { res, busy, error, chosen }: busca em andamento / resultado (chosen = escolha do usuário)
let addSeq = 0;                        // ignora respostas de buscas canceladas

const $ = (id) => (root ? root.querySelector(`#${id}`) : null);

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'hidden' || k === 'checked') el[k] = !!v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const icon = (name) => h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

async function call(fn, ...args) {
  if (typeof fn !== 'function') throw new Error('Recurso indisponível nesta versão do app.');
  const res = await fn(...args);
  if (!res || !res.ok) throw new Error(res?.error || 'Algo deu errado. Tente novamente.');
  return res.data;
}

const STATE_TEXT = { active: 'Ativo', standby: 'Em espera', nokey: 'Sem chave', consent: 'Aviso pendente', off: 'Desligado' };
const STATE_CLASS = { active: 'ok', standby: 'warn', nokey: 'warn', consent: 'warn', off: 'off' };

const stateText = (p) => (p.state === 'standby' ? `Em espera (${p.standbySeconds} s)` : STATE_TEXT[p.state] || '');

function whereItGoes(p) {
  if (p.isLocal) return 'Servidor na sua máquina ou na sua rede: o texto enviado à IA não sai dela.';
  return `Servidor externo (${p.serverHost}): o texto enviado à IA sai do computador.`;
}

function keyHint(p) {
  if (!config.encryptionAvailable) return 'A criptografia do sistema não está disponível: não é possível guardar a chave com segurança.';
  if (p.hasKey) return 'Chave guardada e criptografada neste computador; nunca é exibida de novo. Deixe o campo vazio para mantê-la.';
  return `${p.keyRequired ? 'Obrigatória. ' : 'Opcional. '}Fica criptografada neste computador e nunca é exibida de novo.`;
}

function setStatus(text, kind = '') {
  statusLine = text ? { text, kind } : null;
  paintStatus();
}

function paintStatus() {
  const el = $('anaStatus');
  if (!el) return;
  el.textContent = statusLine ? statusLine.text : '';
  el.className = `ana-status${statusLine && statusLine.kind ? ` ana-${statusLine.kind}` : ''}`;
}

function setCardStatus(id, text, kind = '') {
  if (text) cardStatus.set(id, { text, kind }); else cardStatus.delete(id);
  const el = root && root.querySelector(`[data-status="${id}"]`);
  if (!el) return;
  el.textContent = text || '';
  el.className = `ana-status${kind ? ` ana-${kind}` : ''}`;
}

/** Avisa o assistente flutuante (nome do provedor no cabeçalho, botão ligado/desligado). */
function notifyChanged() {
  try { window.dispatchEvent(new CustomEvent('bds:ai-assistant-changed')); } catch (_) { /* sem janela: nada a avisar */ }
}

/** Grava um patch e redesenha. Devolve true se deu certo. */
async function save(patch, { focus = null, quiet = false } = {}) {
  try {
    config = await call(window.bds?.aiSaveConfig, patch);
    if (focus) focusAfter = focus;
    if (!quiet) statusLine = null;
    render();
    notifyChanged();
    return true;
  } catch (err) {
    setStatus(err.message, 'error');
    return false;
  }
}

// ------------------------------------------------------------------ ações

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Apaga o rascunho no main (zera a chave que ele segurava). Falha silenciosa: o rascunho expira sozinho em 10 minutos. */
async function discardDraft(draftId) {
  try { await call(window.bds?.aiDiscoverProvider, { discard: draftId }); } catch (_) { /* expira sozinho */ }
}

/** Foca o primeiro seletor (separados por "||") que existe e não está desabilitado. */
function focusFirst(selectors) {
  const target = String(selectors).split('||').map((sel) => root && root.querySelector(sel)).find((el) => el && !el.disabled);
  if (target && typeof target.focus === 'function') target.focus();
}

/** Redesenha só o bloco "Adicionar provedor" (o resto do card não muda durante a busca). `focus`: onde o foco cai depois (teclado e leitor de tela). */
function paintAdd(focus = null) {
  const old = root && root.querySelector('.ana-add');
  if (old && old.parentNode && config) old.parentNode.replaceChild(buildAdd(), old);
  if (focus) focusFirst(focus);
}

function showAddError(text) {
  addError = text || '';
  const el = root && root.querySelector('.ana-add-error');
  if (el) el.textContent = addError;
}

async function searchModels(urlEl, keyEl) {
  if (discovery && discovery.busy) return;
  const baseUrl = urlEl.value.trim();
  const apiKey = keyEl.value.trim();
  const shortcut = addShortcut ? (config.shortcuts || []).find((s) => s.id === addShortcut) : null;
  if (!baseUrl) { showAddError('Informe o endereço do servidor.'); return; }
  if (shortcut && shortcut.keyRequired && !apiKey) { showAddError('Cole a chave de API deste serviço.'); return; }
  keyEl.value = '';   // o renderer não guarda a chave: ela já sai agora e o campo é limpo
  keyCleared = false;
  addUrl = baseUrl;
  addOpen = true;
  addError = '';
  const seq = ++addSeq;
  discovery = { busy: true };
  paintAdd('.ana-add-cancel');   // o foco não se perde: fica no Cancelar, que continua habilitado durante a busca
  const input = apiKey ? { baseUrl, apiKey } : { baseUrl };
  try {
    const res = await call(window.bds?.aiDiscoverProvider, input);
    if (seq !== addSeq || !root) { if (res && res.draftId) discardDraft(res.draftId); return; }
    discovery = { res, busy: false, error: res.error && res.error.message ? res.error.message : '', chosen: '' };
    paintAdd('.ana-disc-chat||.ana-disc-force');
  } catch (err) {
    if (seq !== addSeq || !root) return;
    discovery = null;
    addError = err.message;
    keyCleared = Boolean(apiKey);   // a chave já saiu do campo: o texto de ajuda avisa que é preciso colar de novo
    paintAdd('.ana-add-key||.ana-discover');
  }
}

async function cancelDiscovery() {
  const draftId = discovery && discovery.res ? discovery.res.draftId : null;
  addSeq++;   // uma resposta que ainda esteja a caminho é descartada (e o rascunho dela apagado) quando chegar
  discovery = null;
  addError = '';
  keyCleared = false;
  paintAdd('.ana-add-url');
  if (draftId) await discardDraft(draftId);
}

async function commitDiscovery(chat) {
  const d = discovery;
  if (!d || !d.res || d.busy) return;
  discovery = { res: d.res, busy: true, error: '', chosen: d.chosen };
  paintAdd();
  try {
    config = await call(window.bds?.aiSaveConfig, { commitDiscovery: { draftId: d.res.draftId, chat } });
    const id = config.addedId;
    const made = id ? config.providers.find((p) => p.id === id) : null;
    discovery = null;
    addOpen = false;
    addUrl = '';
    addShortcut = null;
    addError = '';
    if (id) {
      expanded.add(id);
      focusAfter = `.ana-prov[data-id="${id}"] .ana-accept||.ana-prov[data-id="${id}"] .ana-key||.ana-prov[data-id="${id}"] .ana-model`;
    }
    statusLine = null;
    render();
    notifyChanged();
    if (made) {
      if (made.needsRemoteConsent) setStatus(`${made.label} adicionado. Para usá-lo, aceite o aviso de servidor externo nos detalhes.`, 'warn');
      else if (made.keyRequired && !made.hasKey) setStatus(`${made.label} adicionado. Informe a chave nos detalhes.`, 'warn');
      else setStatus(`${made.label} adicionado.`, 'ok');
    }
  } catch (err) {
    discovery = { res: d.res, busy: false, error: err.message, chosen: d.chosen };
    paintAdd('.ana-disc-add');
  }
}

function move(index, delta) {
  const ids = config.providers.map((p) => p.id);
  const to = index + delta;
  if (to < 0 || to >= ids.length) return;
  [ids[index], ids[to]] = [ids[to], ids[index]];
  const id = config.providers[index].id;
  // o foco acompanha o cartão movido; se o botão usado ficou desabilitado (chegou ao topo/fim), vai para o outro
  const sel = (dir) => `.ana-prov[data-id="${id}"] .ana-${dir}`;
  save({ order: ids }, { focus: delta < 0 ? `${sel('up')}||${sel('down')}` : `${sel('down')}||${sel('up')}` });
}

/** A chave que o usuário digita num cartão sobrevive a um redesenho (só passa pelo DOM, não é guardada); depois de enviada ao main o campo é limpo. */
function typedKeys() {
  const out = new Map();
  if (!root) return out;
  for (const li of root.querySelectorAll('.ana-prov')) {
    const el = li.querySelector('.ana-key');
    if (el && el.value) out.set(li.dataset.id, el.value);
  }
  return out;
}
function forgetTypedKey(id) {
  const el = root && root.querySelector(`.ana-prov[data-id="${id}"] .ana-key`);
  if (el) el.value = '';
}

function readCard(p) {
  const card = root.querySelector(`.ana-prov[data-id="${p.id}"]`);
  const val = (sel) => { const el = card.querySelector(sel); return el ? el.value : undefined; };
  const patch = { id: p.id, model: val('.ana-model') };
  const key = (val('.ana-key') || '').trim();
  if (key) patch.apiKey = key;
  const url = val('.ana-url');
  if (url !== undefined && url.trim() && url.trim() !== p.baseUrl) patch.baseUrl = url;
  const name = val('.ana-name');
  if (name !== undefined && name.trim() && name.trim() !== p.label) patch.label = name;
  return patch;
}

async function saveAndTest(p, btn) {
  btn.disabled = true;
  try {
    setCardStatus(p.id, 'Salvando…');
    const patch = readCard(p);
    if (!String(patch.model || '').trim()) throw new Error('Informe o modelo (o botão de atualizar lista os modelos do servidor).');
    config = await call(window.bds?.aiSaveConfig, { provider: patch });
    forgetTypedKey(p.id);
    setCardStatus(p.id, 'Testando a conexão…');
    const res = await call(window.bds?.aiTestConnection, p.id);
    cardStatus.set(p.id, { text: res.message, kind: 'ok' });
    render();
    notifyChanged();
  } catch (err) {
    // a chave digitada já foi gravada (se deu certo): atualiza o cartão sem perder a mensagem de erro
    try { config = await call(window.bds?.aiGetConfig); } catch (_) { /* mantém o que tem */ }
    cardStatus.set(p.id, { text: err.message, kind: 'error' });
    render();
  }
}

async function listModels(p, btn) {
  btn.disabled = true;
  try {
    setCardStatus(p.id, 'Buscando modelos…');
    config = await call(window.bds?.aiSaveConfig, { provider: readCard(p) });
    forgetTypedKey(p.id);
    let ids;
    let text;
    if (p.preset === 'embedded') {
      // o modelo local do app não tem catálogo para descobrir: continua a lista simples
      const models = await call(window.bds?.aiListModels, p.id);
      ids = models.map((m) => m.id);
      text = ids.length ? `${ids.length} modelo(s) disponível(is): clique no campo Modelo para escolher.` : 'O servidor não listou nenhum modelo.';
    } else {
      const res = await call(window.bds?.aiDiscoverProvider, { providerId: p.id });
      ids = (res.models || []).filter((m) => m.caps.includes('chat')).map((m) => m.id);
      const fresh = Number(res.added) || 0;
      text = ids.length
        ? `${plural(ids.length, 'modelo', 'modelos')} (${plural(fresh, 'novo', 'novos')}). Clique no campo Modelo para escolher.`
        : 'O servidor não listou nenhum modelo de conversa.';
      try { config = await call(window.bds?.aiGetConfig); } catch (_) { /* mantém: o catálogo aparece na próxima leitura */ }
    }
    modelLists.set(p.id, ids);
    const wanted = ids.length === 1 && !(readCardModel(p.id)) ? ids[0] : null;
    cardStatus.set(p.id, { text, kind: ids.length ? 'ok' : 'error' });
    render();
    if (wanted) { const field = root.querySelector(`.ana-prov[data-id="${p.id}"] .ana-model`); if (field) field.value = wanted; }
  } catch (err) {
    try { config = await call(window.bds?.aiGetConfig); } catch (_) { /* mantém */ }
    cardStatus.set(p.id, { text: err.message, kind: 'error' });
    render();
  }
}

/** Apaga a chave guardada do provedor depois de confirmar (o foco vai para o campo da chave, já que o botão some). */
async function removeKey(p) {
  const ok = await window.bdsModal.confirm(`Remover a chave guardada de ${p.label}?\n\nO provedor só volta a funcionar depois que você colar uma chave de novo.`);
  if (!ok) return;
  save({ provider: { id: p.id, clearApiKey: true } }, { quiet: true, focus: `.ana-prov[data-id="${p.id}"] .ana-key` });
}

const readCardModel = (id) => { const el = root.querySelector(`.ana-prov[data-id="${id}"] .ana-model`); return el ? el.value.trim() : ''; };

// ------------------------------------------------------------------ linhas dos provedores

function buildCard(p, index) {
  const total = config.providers.length;
  const titleId = `anaTitle-${p.id}`;
  const detailId = `anaDetail-${p.id}`;
  const st = cardStatus.get(p.id);
  const open = expanded.has(p.id) || confirmRemove === p.id;

  // Linha fechada: alça, nome + estado (abre os detalhes), setas (só com mouse/foco) e interruptor
  const head = h('div', { class: 'ana-prov-head' }, [
    h('span', { class: 'ana-grip', title: 'Arraste para mudar a ordem', 'aria-hidden': 'true' }, [icon('drag_indicator')]),
    h('button', {
      class: 'ana-toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailId,
      onclick: () => { if (expanded.has(p.id)) expanded.delete(p.id); else expanded.add(p.id); render(); }
    }, [
      h('span', { class: 'ana-prov-title' }, [
        h('strong', { id: titleId, text: p.label }),
        h('span', { class: `mod-badge ana-state ana-state-${STATE_CLASS[p.state] || 'off'}`, text: stateText(p) })
      ]),
      icon(open ? 'expand_less' : 'expand_more')
    ]),
    h('div', { class: 'ana-prov-tools' }, [
      // com um provedor só não há o que reordenar: as setas nem são desenhadas
      total > 1 ? h('button', { class: 'mod-icon-btn ana-up', type: 'button', title: 'Subir', 'aria-label': `Subir ${p.label}`, disabled: index === 0, onclick: () => move(index, -1) }, [icon('arrow_upward')]) : null,
      total > 1 ? h('button', { class: 'mod-icon-btn ana-down', type: 'button', title: 'Descer', 'aria-label': `Descer ${p.label}`, disabled: index === total - 1, onclick: () => move(index, 1) }, [icon('arrow_downward')]) : null,
      h('input', { type: 'checkbox', class: 'st-switch ana-enabled', checked: p.enabled, 'aria-label': `Ativar ${p.label}`, onchange: (e) => save({ provider: { id: p.id, enabled: e.target.checked } }, { quiet: true, focus: `.ana-prov[data-id="${p.id}"] .ana-enabled` }) })
    ])
  ]);

  const info = [h('p', { class: 'mod-hint ana-where', text: whereItGoes(p) })];
  if (p.unverifiedAddress) {
    const warning = (config.presets.find((x) => x.id === p.preset) || {}).warning || 'Endereço não confirmado como oficial: use só se você confia nele.';
    info.push(h('p', { class: 'ana-note', role: 'note' }, [icon('info'), h('span', { text: warning })]));
  }

  // Chave: o campo fica sempre à vista e nunca mostra o valor. Com chave guardada o texto de apoio diz que colar outra troca;
  // vazio não muda nada. Remover a chave guardada fica em Avançado.
  const keyBlock = h('div', { class: 'mod-field' }, [
    h('label', { class: 'mod-field-label', for: `anaKey-${p.id}`, text: 'Chave de API' }),
    h('input', { id: `anaKey-${p.id}`, class: 'mod-input ana-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.hasKey ? 'Chave guardada, cole outra para trocar' : 'Cole a chave aqui', disabled: !config.encryptionAvailable }),
    h('span', { class: 'mod-hint', text: keyHint(p) })
  ]);

  const modelBlock = h('div', { class: 'mod-field' }, [
    h('label', { class: 'mod-field-label', for: `anaModel-${p.id}`, text: 'Modelo' }),
    h('div', { class: 'ana-row' }, [
      buildModelCombo(p),
      h('button', { class: 'mod-btn mod-btn-secondary ana-refresh', type: 'button', title: 'Buscar os modelos deste servidor', 'aria-label': `Buscar os modelos de ${p.label}`, onclick: (e) => listModels(p, e.currentTarget) }, [icon('refresh')])
    ])
  ]);

  // Aviso de servidor externo: à vista enquanto pendente; depois de aceito, fica em Avançado (dá para revogar)
  const consent = p.isLocal ? null : h('label', { class: 'ana-consent' }, [
    h('input', { type: 'checkbox', class: 'st-switch ana-accept', checked: !p.needsRemoteConsent, onchange: (e) => save({ provider: { id: p.id, acceptRemote: e.target.checked } }, { quiet: true, focus: `.ana-prov[data-id="${p.id}"] .ana-accept` }) }),
    h('span', { text: 'Entendo que o texto enviado à IA vai para este servidor externo.' })
  ]);
  const consentPending = Boolean(consent) && p.needsRemoteConsent;

  const advanced = h('details', { class: 'ana-adv' }, [
    h('summary', { text: 'Avançado' }),
    h('div', { class: 'ana-adv-body' }, [
      h('label', { class: 'mod-field' }, [h('span', { class: 'mod-field-label', text: 'Nome' }), h('input', { class: 'mod-input ana-name', type: 'text', maxlength: '40', value: p.label })]),
      h('label', { class: 'mod-field' }, [
        h('span', { class: 'mod-field-label', text: 'Endereço' }),
        h('input', { class: 'mod-input ana-url', type: 'text', spellcheck: 'false', value: p.baseUrl }),
        h('span', { class: 'mod-hint', text: 'Mudar de servidor apaga a chave guardada deste provedor.' })
      ]),
      consent && !consentPending ? consent : null,
      p.hasKey ? h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm ana-self-start ana-key-remove', type: 'button', 'aria-label': `Remover a chave de ${p.label}`, onclick: () => removeKey(p) }, 'Remover a chave guardada') : null,
      confirmRemove === p.id
        ? h('div', { class: 'ana-confirm', role: 'alertdialog', 'aria-label': `Remover ${p.label}` }, [
          h('span', { text: `Remover ${p.label}? A chave guardada dele também será apagada.` }),
          h('div', { class: 'mod-actions' }, [
            h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-remove-yes', type: 'button', onclick: () => { confirmRemove = null; expanded.delete(p.id); cardStatus.delete(p.id); modelLists.delete(p.id); save({ removeProvider: p.id }); } }, 'Remover'),
            h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm ana-remove-no', type: 'button', onclick: () => { confirmRemove = null; focusAfter = `.ana-prov[data-id="${p.id}"] .ana-remove`; render(); } }, 'Cancelar')
          ])
        ])
        : h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-self-start ana-remove', type: 'button', onclick: () => { confirmRemove = p.id; focusAfter = `.ana-prov[data-id="${p.id}"] .ana-remove-yes`; render(); } }, [icon('delete'), 'Remover provedor'])
    ])
  ]);
  if (confirmRemove === p.id) advanced.open = true;

  const detail = h('div', { class: 'ana-detail', id: detailId, hidden: !open }, [
    ...info, keyBlock, modelBlock, consentPending ? consent : null,
    h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-primary ana-save', type: 'button', 'aria-label': `Salvar e testar ${p.label}`, onclick: (e) => saveAndTest(p, e.currentTarget) }, [icon('wifi_tethering'), 'Salvar e testar'])
    ]),
    h('div', { class: `ana-status${st && st.kind ? ` ana-${st.kind}` : ''}`, 'data-status': p.id, role: 'status', text: st ? st.text : '' }),
    advanced
  ]);

  return h('li', { class: `ana-prov${p.enabled ? '' : ' ana-prov-off'}${open ? ' ana-prov-open' : ''}`, 'data-id': p.id, role: 'group', 'aria-labelledby': titleId }, [head, detail]);
}

/**
 * Campo "Modelo": digita à vontade e, ao clicar, mostra TODOS os modelos do servidor (a lista nativa do navegador só
 * mostrava os que combinam com o texto, e era preciso apagá-lo para ver o resto). Ao digitar, a lista filtra pelo que
 * CONTÉM o texto. Setas navegam, Enter escolhe, Esc fecha. Se a lista ainda não foi buscada e há chave guardada (ou o
 * servidor não pede chave), busca sozinha ao focar.
 */
function buildModelCombo(p) {
  const listId = `anaModels-${p.id}`;
  const input = h('input', {
    id: `anaModel-${p.id}`, class: 'mod-input ana-model', type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    spellcheck: 'false', autocomplete: 'off', value: p.model || '', placeholder: p.suggestedModel || 'nome do modelo'
  });
  const box = h('ul', { id: listId, class: 'ana-combo-list', role: 'listbox', hidden: true, 'aria-label': `Modelos de ${p.label}` });
  let shown = [];
  let active = -1;
  let filtering = false;   // só filtra depois que o usuário digita; ao abrir mostra tudo
  let loading = false;
  const all = () => modelLists.get(p.id) || chatIds(p);   // lista buscada; antes dela, o catálogo guardado

  const paint = () => {
    const q = filtering ? input.value.trim().toLowerCase() : '';
    shown = all().filter((id) => !q || id.toLowerCase().includes(q));
    clear(box);
    if (!shown.length) {
      let text = 'Clique em atualizar para listar os modelos.';
      if (loading) text = 'Buscando modelos…';
      else if (all().length) text = 'Nenhum modelo com esse nome. O texto digitado vale como está.';
      box.append(h('li', { class: 'ana-combo-empty', role: 'presentation', text }));
      return;
    }
    const current = input.value.trim();
    shown.forEach((id, i) => box.append(h('li', {
      role: 'option', class: `ana-combo-opt${id === current ? ' selected' : ''}${i === active ? ' active' : ''}`, 'data-model': id, 'aria-selected': id === current ? 'true' : 'false', text: id,
      onmousedown: (e) => { e.preventDefault(); pick(id); } // mousedown: escolhe antes de o campo perder o foco
    })));
  };
  const open = () => { box.hidden = false; input.setAttribute('aria-expanded', 'true'); paint(); };
  const close = () => { box.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; filtering = false; };
  const pick = (id) => { input.value = id; close(); };

  const ensureLoaded = () => {
    if (all().length || loading || !(p.hasKey || !p.keyRequired)) return;   // com catálogo guardado não precisa buscar
    loading = true;
    if (!box.hidden) paint();
    call(window.bds?.aiListModels, p.id)
      .then((models) => { modelLists.set(p.id, (models || []).map((m) => m.id)); })
      .catch(() => { /* sem lista: o texto digitado continua valendo e o botão de atualizar mostra o motivo */ })
      .finally(() => { loading = false; if (!box.hidden) paint(); });
  };

  input.addEventListener('focus', () => { filtering = false; open(); ensureLoaded(); });
  input.addEventListener('click', () => { if (box.hidden) { filtering = false; open(); } });
  input.addEventListener('input', () => { filtering = true; active = -1; if (box.hidden) open(); else paint(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (box.hidden) { open(); return; }
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      paint();
      const el = box.querySelector('.ana-combo-opt.active');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !box.hidden && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape' && !box.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  return h('div', { class: 'ana-combo' }, [input, box]);
}

/** Ids dos modelos do catálogo de um provedor que servem para conversa. */
const chatIds = (p) => (Array.isArray(p.models) ? p.models : []).filter((m) => Array.isArray(m.caps) && m.caps.includes('chat')).map((m) => m.id);

function buildAddForm() {
  const shortcuts = Array.isArray(config.shortcuts) ? config.shortcuts : [];
  const busy = Boolean(discovery && discovery.busy);
  const hintEl = h('span', { class: 'mod-hint ana-add-keyhint' });
  const urlEl = h('input', {
    id: 'anaAddUrl', class: 'mod-input ana-add-url', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://api.exemplo.com/v1', value: addUrl, disabled: busy,
    oninput: (e) => { addUrl = e.target.value; addShortcut = null; paintChips(); paintHint(); }
  });
  const keyEl = h('input', {
    id: 'anaAddKey', class: 'mod-input ana-add-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Cole a chave aqui', disabled: busy || !config.encryptionAvailable,
    oninput: () => { if (keyCleared) { keyCleared = false; paintHint(); } }
  });
  const chips = shortcuts.map((s) => h('button', {
    class: 'ana-preset', type: 'button', 'data-preset': s.id, disabled: busy,
    onclick: () => { addShortcut = s.id; addUrl = s.baseUrl; urlEl.value = s.baseUrl; showAddError(''); paintChips(); paintHint(); }
  }, s.label));
  function paintChips() { chips.forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('data-preset') === addShortcut ? 'true' : 'false')); }
  function paintHint() {
    const s = addShortcut ? shortcuts.find((x) => x.id === addShortcut) : null;
    let text = 'Deixe em branco se o servidor não pedir chave.';
    if (!config.encryptionAvailable) text = 'A criptografia do sistema não está disponível: só dá para adicionar servidores sem chave.';
    else if (s) text = s.keyRequired ? 'Obrigatória para este serviço.' : 'Opcional neste servidor.';
    if (keyCleared && config.encryptionAvailable) text = 'A chave não fica na tela: cole-a de novo para tentar outra vez.';
    hintEl.textContent = text;
  }
  paintChips();
  paintHint();
  const submit = () => searchModels(urlEl, keyEl);
  const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  urlEl.addEventListener('keydown', onEnter);
  keyEl.addEventListener('keydown', onEnter);
  return h('div', { class: 'ana-add-form', 'aria-busy': busy ? 'true' : null }, [
    shortcuts.length ? h('ul', { class: 'ana-presets', 'aria-label': 'Atalhos de endereço' }, chips.map((b) => h('li', {}, [b]))) : null,
    h('div', { class: 'mod-field' }, [h('label', { class: 'mod-field-label', for: 'anaAddUrl', text: 'Endereço' }), urlEl]),
    h('div', { class: 'mod-field' }, [h('label', { class: 'mod-field-label', for: 'anaAddKey', text: 'Chave de API' }), keyEl, hintEl]),
    h('p', { class: 'mod-hint ana-add-note', text: 'A chave é enviada só a este endereço, para listar os modelos.' }),
    h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-primary ana-discover', type: 'button', disabled: busy, onclick: submit }, [icon('search'), busy ? 'Procurando…' : 'Procurar modelos']),
      busy ? h('button', { class: 'mod-btn mod-btn-ghost ana-add-cancel', type: 'button', onclick: cancelDiscovery }, 'Cancelar') : null
    ]),
    h('div', { class: 'ana-status ana-error ana-add-error', role: 'alert', text: addError })
  ]);
}

/** Passo 2: o que foi encontrado, o seletor de Conversa e Adicionar/Cancelar. Tudo por textContent. */
function buildDiscoveryResult() {
  const d = discovery;
  const r = d.res;
  const forced = r.canForce === true;
  const models = Array.isArray(r.models) ? r.models : [];
  const chat = models.filter((m) => m.caps.includes('chat'));
  const c = r.counts || {};
  const parts = [`${plural(c.chat || 0, 'modelo', 'modelos')} de conversa`, `${c.audio || 0} de áudio`, `${c.image || 0} de imagem`];
  if (c.video) parts.push(`${c.video} de vídeo`);

  // Com a lista vazia ou ilegível o app não reconheceu formato nenhum: não afirma "compatível com OpenAI"
  const els = [h('p', { class: 'ana-found', text: forced ? `Servidor: ${r.label}` : `Encontrado: ${r.label} · ${r.format === 'anthropic' ? 'Anthropic' : 'compatível com OpenAI'}` })];
  let selectEl = null;
  let forceEl = null;
  if (forced) {
    forceEl = h('input', {
      id: 'anaDiscForce', class: 'mod-input ana-disc-force', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'nome do modelo', maxlength: '120', disabled: d.busy, value: d.chosen || '',
      oninput: (e) => { d.chosen = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } }
    });
    els.push(
      h('div', { class: 'ana-status ana-error ana-disc-error', role: 'alert', text: d.error || (r.error && r.error.message) || '' }),
      h('div', { class: 'mod-field' }, [h('label', { class: 'mod-field-label', for: 'anaDiscForce', text: 'Modelo de conversa' }), forceEl])
    );
  } else {
    els.push(h('p', { class: 'ana-disc-summary', text: parts.join(', ') }));
    if (chat.length) {
      // a escolha do usuário sobrevive a um redesenho do card; sem escolha, vale o padrão sugerido
      const pick = chat.some((m) => m.id === d.chosen) ? d.chosen : r.defaultChat;
      selectEl = h('select', { id: 'anaDiscChat', class: 'mod-input ana-disc-chat', disabled: d.busy, onchange: (e) => { d.chosen = e.target.value; } }, chat.map((m) => {
        const o = h('option', { value: m.id, text: m.source === 'nome' ? `${m.id} · provável` : m.id });
        if (m.id === pick) o.selected = true;
        return o;
      }));
      if (!chat.some((m) => m.id === pick) && selectEl.firstChild) selectEl.firstChild.selected = true;
      els.push(h('div', { class: 'mod-field' }, [h('label', { class: 'mod-field-label', for: 'anaDiscChat', text: 'Conversa' }), selectEl]));
    } else {
      els.push(h('p', { class: 'mod-muted ana-disc-none', text: 'Nenhum modelo de conversa foi encontrado neste servidor.' }));
    }
    if (d.error) els.push(h('div', { class: 'ana-status ana-error ana-disc-error', role: 'alert', text: d.error }));
  }
  if (!r.isLocal) els.push(h('p', { class: 'mod-hint ana-disc-where', text: 'As conversas e as análises de texto vão para este serviço.' }));

  const canAdd = forced || chat.length > 0;
  function doAdd() {
    if (d.busy) return;
    const value = forced ? forceEl.value.trim() : (selectEl ? selectEl.value : '');
    if (!value) { const e = root.querySelector('.ana-disc-error'); if (e) e.textContent = 'Informe o modelo de conversa.'; return; }
    commitDiscovery(value);
  }
  els.push(h('div', { class: 'mod-actions' }, [
    canAdd ? h('button', { class: 'mod-btn mod-btn-primary ana-disc-add', type: 'button', disabled: d.busy, onclick: doAdd }, forced ? 'Adicionar mesmo assim' : 'Adicionar') : null,
    h('button', { class: 'mod-btn mod-btn-ghost ana-disc-cancel', type: 'button', disabled: d.busy, onclick: cancelDiscovery }, 'Cancelar')
  ]));
  return h('div', { class: 'ana-disc' }, els);
}

function buildAdd() {
  const has = config.providers.length > 0;
  const details = h('details', { class: 'ana-add', open: !has || addOpen || discovery !== null }, [
    h('summary', { class: 'mod-btn mod-btn-secondary ana-add-btn' }, [icon('add'), 'Adicionar provedor']),
    discovery && discovery.res ? buildDiscoveryResult() : buildAddForm()
  ]);
  details.addEventListener('toggle', () => { if (has && !discovery) addOpen = details.open; });
  return details;
}

/** Arrastar pela alça muda a ordem; a ordem nova é gravada ao soltar. */
function bindDrag(list) {
  let dragging = null;
  let before = '';
  const ids = () => [...list.querySelectorAll('.ana-prov')].map((li) => li.dataset.id);
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.ana-prov');
    if (li) li.draggable = Boolean(e.target.closest('.ana-grip'));
  });
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest && e.target.closest('.ana-prov');
    if (!li || !li.draggable) { e.preventDefault(); return; }
    dragging = li;
    before = ids().join(',');
    li.classList.add('ana-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.dataset.id); }
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('.ana-prov');
    if (!over || over === dragging) return;
    const rect = over.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY > rect.top + rect.height / 2 ? over.nextElementSibling : over);
  });
  list.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('ana-dragging');
    dragging.draggable = false;
    const next = ids();
    dragging = null;
    if (next.join(',') !== before) save({ order: next }, { quiet: true });
  });
}

// ------------------------------------------------------------------ card geral

const section = (title, hint, children) => h('section', { class: 'ana-sec', 'aria-label': title }, [
  h('h4', { class: 'ana-sec-title' }, [title, hint ? h('span', { class: 'ana-sec-hint', text: hint }) : null]),
  ...children
]);

function render() {
  if (!root || !config) return;
  const host = $('anaHost');
  const has = config.providers.length > 0;
  // A chave que o usuário está digitando em "Adicionar provedor" sobrevive a um redesenho (só passa pelo DOM, não é guardada)
  const typing = root.querySelector('.ana-add-key');
  const typedKey = typing ? typing.value : '';
  const typedCards = typedKeys();

  const head = h('div', { class: 'mod-head' }, [
    h('div', { class: 'mod-head-icon' }, [icon('auto_awesome')]),
    h('div', { class: 'mod-head-text' }, [
      h('h3', { text: 'Provedores' }),
      h('p', { text: 'Serviços de IA que o app usa. A ordem de cada lista é a ordem de tentativa. As chaves ficam criptografadas neste computador.' })
    ]),
    h('span', { class: `mod-state mod-state-${config.ready ? 'ok' : 'off'}`, text: config.ready ? 'Pronta' : 'Não configurada' })
  ]);

  // Chat
  const chat = [];
  if (has) {
    const list = h('ul', { class: 'ana-list', 'aria-label': 'Provedores de chat, em ordem de prioridade' }, config.providers.map(buildCard));
    bindDrag(list);
    chat.push(list);
  } else {
    chat.push(h('p', { class: 'mod-muted ana-empty', text: 'Nenhum provedor ainda. Adicione um para usar o assistente e a análise de transcrições.' }));
  }
  chat.push(buildAdd());
  if (config.providers.length > 1) {
    chat.push(h('label', { class: 'ana-fallback' }, [
      h('input', { type: 'checkbox', class: 'st-switch ana-fallback-input', id: 'anaFallback', checked: config.fallbackEnabled, onchange: (e) => save({ fallbackEnabled: e.target.checked }, { quiet: true, focus: '#anaFallback' }) }),
      h('span', { class: 'ana-fallback-text' }, [
        h('strong', { text: 'Usar o próximo provedor se este falhar (mantém a conversa)' }),
        h('span', { class: 'mod-hint', text: 'Servidor fora do ar, limite de uso ou chave recusada: a conversa continua no próximo da lista.' })
      ])
    ]));
  }
  chat.push(h('details', { class: 'ana-adv' }, [
    h('summary', { text: 'Avançado' }),
    h('label', { class: 'mod-field' }, [
      h('span', { class: 'mod-field-label', text: 'Tamanho máximo de cada resposta (tokens)' }),
      h('input', { id: 'anaMaxTokens', class: 'mod-input mod-input-short', type: 'number', min: '64', max: '8192', step: '64', value: String(config.maxTokens), onchange: (e) => save({ maxTokens: Number(e.target.value) }, { quiet: true }) }),
      h('span', { class: 'mod-hint', text: 'Se a análise vier cortada no meio, aumente este valor.' })
    ])
  ]));
  chat.push(h('div', { id: 'anaStatus', class: 'ana-status', role: 'status' }));

  const body = h('div', { class: 'mod-section' }, [
    section('Chat', 'Assistente e análise de transcrições', chat),
    section('Áudio', 'Transcrição de áudio e vídeo', [h('div', { id: 'anaAudioHost' })]),
    section('Imagem', 'Entender fotos', [h('div', { id: 'anaImageHost' })]),
    // Vídeo só aparece quando algum provedor tem modelos de vídeo no catálogo (o app ainda não usa vídeo)
    config.providers.some((p) => p.modelCounts && p.modelCounts.video > 0) ? section('Vídeo', null, [h('div', { id: 'anaVideoHost' })]) : null
  ]);

  clear(host).append(head, body);
  if (typedKey) { const again = root.querySelector('.ana-add-key'); if (again && !again.disabled) again.value = typedKey; }
  for (const [id, value] of typedCards) {
    const again = root.querySelector(`.ana-prov[data-id="${id}"] .ana-key`);
    if (again && !again.disabled) again.value = value;
  }
  paintStatus();
  // As outras seções têm dados próprios: desenhadas depois, sem atrasar a lista de chat
  try { mountAudioSection($('anaAudioHost')); } catch (_) { /* a seção de áudio nunca derruba o card */ }
  try { renderMediaSections({ image: $('anaImageHost'), video: $('anaVideoHost') }); } catch (_) { /* idem */ }
  if (focusAfter) {
    const sel = focusAfter;
    focusAfter = null;
    focusFirst(sel);   // vários seletores separados por "||": o primeiro que existe e não está desabilitado
  }
}

// ------------------------------------------------------------------ ciclo de vida

/** Monta o card dentro de `container` (Configurações → Inteligência Artificial → Provedores) e carrega a configuração. */
export async function mountAnalysisPanel(container) {
  root = container;
  clear(root);
  root.append(h('div', { class: 'mod-screen mod-embedded' }, [h('section', { id: 'anaHost', class: 'mod-card ana-card', 'aria-label': 'Provedores' })]));
  statusLine = null;
  cardStatus = new Map();
  expanded = new Set();
  modelLists = new Map();
  confirmRemove = null;
  focusAfter = null;
  resetAddState();
  try {
    config = await call(window.bds?.aiGetConfig);
    render();
  } catch (err) {
    clear($('anaHost')).append(h('p', { class: 'mod-muted', text: `Não foi possível carregar a configuração da IA: ${err.message}` }));
  }
}

/** Recarrega a lista de provedores (ex.: o modelo local foi instalado ou removido em outro cartão). */
export async function reloadAnalysisPanel() {
  if (!root) return;
  try { config = await call(window.bds?.aiGetConfig); render(); } catch (_) { /* mantém o que já está na tela */ }
}

function resetAddState() {
  addUrl = '';
  addShortcut = null;
  addOpen = false;
  addError = '';
  keyCleared = false;
  discovery = null;
  addSeq++;
}

/** Solta o conteúdo ao sair das Configurações. */
export function unmountAnalysisPanel() {
  try { unmountAudioSection(); } catch (_) { /* nada a soltar */ }
  const pending = discovery && discovery.res ? discovery.res.draftId : null;
  if (pending) discardDraft(pending);   // o rascunho com a chave não fica esperando no main
  if (root) clear(root);
  root = null;
  config = null;
  statusLine = null;
  cardStatus = new Map();
  expanded = new Set();
  modelLists = new Map();
  confirmRemove = null;
  focusAfter = null;
  resetAddState();
}
