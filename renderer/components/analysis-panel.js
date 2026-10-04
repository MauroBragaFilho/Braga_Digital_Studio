/**
 * Painel "Provedores de IA" da seção Configurações → Inteligência Artificial. Lista os servidores de IA usados pela
 * análise de transcrições e pelo assistente (Groq, Qwen, LM Studio, Ollama, OpenAI ou outro compatível), na ORDEM DE
 * PRIORIDADE: se o primeiro falhar, o próximo continua a mesma conversa (interruptor de fallback). Cada provedor tem
 * a SUA chave de API, que só é gravada (criptografada no computador) e nunca volta para a tela: aqui só aparece
 * "Chave guardada". É opcional: sem provedores, a transcrição funciona normalmente. A configuração é a mesma do
 * assistente (window.bds.ai*). Textos entram sempre por textContent.
 */

let config = null;
let root = null;
let statusLine = null;                 // { text, kind } da linha geral (adicionar, ordem, fallback)
let cardStatus = new Map();            // id do provedor -> { text, kind } da linha do cartão
let keyEdit = new Set();               // provedores com o campo "trocar chave" aberto
let confirmRemove = null;              // id do provedor cuja remoção está esperando confirmação
let modelLists = new Map();            // id -> ids de modelos listados pelo próprio provedor
let focusAfter = null;                 // seletor do elemento que recebe o foco depois de redesenhar

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

async function addProvider(presetId) {
  const preset = config.presets.find((p) => p.id === presetId);
  if (presetId === 'custom') {
    // Personalizado precisa de endereço: pede no próprio cartão novo (campo em "Avançado" aberto)
    return save({ addProvider: { preset: 'custom', baseUrl: 'http://localhost:8080/v1' } }, { focus: '.ana-prov:last-child .ana-model' }).then((ok) => {
      if (ok) setStatus('Ajuste o endereço do servidor em Avançado e informe o modelo.', 'ok');
    });
  }
  const ok = await save({ addProvider: { preset: presetId } }, { focus: '.ana-prov:last-child input[type="password"], .ana-prov:last-child .ana-model' });
  if (ok && preset) setStatus(preset.warning ? preset.warning : `${preset.label} adicionado. Informe a chave e clique em Salvar e testar.`, preset.warning ? 'warn' : 'ok');
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
    keyEdit.delete(p.id);
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
    keyEdit.delete(p.id);
    const models = await call(window.bds?.aiListModels, p.id);
    modelLists.set(p.id, models.map((m) => m.id));
    const wanted = models.length === 1 && !(readCardModel(p.id)) ? models[0].id : null;
    cardStatus.set(p.id, { text: models.length ? `${models.length} modelo(s) disponível(is): clique no campo Modelo para escolher.` : 'O servidor não listou nenhum modelo.', kind: models.length ? 'ok' : 'error' });
    render();
    if (wanted) { const field = root.querySelector(`.ana-prov[data-id="${p.id}"] .ana-model`); if (field) field.value = wanted; }
  } catch (err) {
    try { config = await call(window.bds?.aiGetConfig); } catch (_) { /* mantém */ }
    cardStatus.set(p.id, { text: err.message, kind: 'error' });
    render();
  }
}

const readCardModel = (id) => { const el = root.querySelector(`.ana-prov[data-id="${id}"] .ana-model`); return el ? el.value.trim() : ''; };

// ------------------------------------------------------------------ cartões

function buildCard(p, index) {
  const total = config.providers.length;
  const titleId = `anaTitle-${p.id}`;
  const list = modelLists.get(p.id) || [];
  const st = cardStatus.get(p.id);

  const head = h('div', { class: 'ana-prov-head' }, [
    h('div', { class: 'ana-prov-title' }, [
      h('strong', { id: titleId, text: p.label }),
      h('span', { class: `mod-badge ana-state ana-state-${STATE_CLASS[p.state] || 'off'}`, text: stateText(p) })
    ]),
    h('div', { class: 'ana-prov-tools' }, [
      h('label', { class: 'ana-switch' }, [
        h('input', { type: 'checkbox', class: 'st-switch ana-enabled', checked: p.enabled, 'aria-label': `Ativar ${p.label}`, onchange: (e) => save({ provider: { id: p.id, enabled: e.target.checked } }, { focus: `.ana-prov[data-id="${p.id}"] .ana-enabled` }) }),
        h('span', { text: 'Ativar' })
      ]),
      h('button', { class: 'mod-icon-btn ana-up', type: 'button', title: 'Subir', 'aria-label': `Subir ${p.label}`, disabled: index === 0, onclick: () => move(index, -1) }, [icon('arrow_upward')]),
      h('button', { class: 'mod-icon-btn ana-down', type: 'button', title: 'Descer', 'aria-label': `Descer ${p.label}`, disabled: index === total - 1, onclick: () => move(index, 1) }, [icon('arrow_downward')])
    ])
  ]);

  const info = [h('p', { class: 'mod-hint ana-where', text: whereItGoes(p) })];
  if (p.unverifiedAddress) {
    const warning = (config.presets.find((x) => x.id === p.preset) || {}).warning || 'Endereço não confirmado como oficial: use só se você confia nele.';
    info.push(h('p', { class: 'ana-note', role: 'note' }, [icon('info'), h('span', { text: warning })]));
  }

  // Chave: só "Chave guardada" (nunca o valor). Trocar abre o campo; Remover apaga.
  let keyBlock;
  if (p.hasKey && !keyEdit.has(p.id)) {
    keyBlock = h('div', { class: 'mod-field' }, [
      h('span', { class: 'mod-field-label', text: 'Chave de API' }),
      h('div', { class: 'ana-keyrow' }, [
        h('span', { class: 'ana-keysaved' }, [icon('lock'), 'Chave guardada']),
        h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm ana-key-change', type: 'button', 'aria-label': `Trocar a chave de ${p.label}`, onclick: () => { keyEdit.add(p.id); focusAfter = `.ana-prov[data-id="${p.id}"] .ana-key`; render(); } }, 'Trocar'),
        h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-key-remove', type: 'button', 'aria-label': `Remover a chave de ${p.label}`, onclick: () => save({ provider: { id: p.id, clearApiKey: true } }, { quiet: true }) }, 'Remover')
      ])
    ]);
  } else {
    keyBlock = h('div', { class: 'mod-field' }, [
      h('label', { class: 'mod-field-label', for: `anaKey-${p.id}`, text: 'Chave de API' }),
      h('input', { id: `anaKey-${p.id}`, class: 'mod-input ana-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Cole a chave aqui', disabled: !config.encryptionAvailable }),
      h('span', { class: 'mod-hint', text: keyHint(p) })
    ]);
  }

  const modelBlock = h('div', { class: 'mod-field' }, [
    h('label', { class: 'mod-field-label', for: `anaModel-${p.id}`, text: 'Modelo' }),
    h('div', { class: 'ana-row' }, [
      h('input', { id: `anaModel-${p.id}`, class: 'mod-input ana-model', type: 'text', list: `anaModels-${p.id}`, spellcheck: 'false', autocomplete: 'off', value: p.model || '', placeholder: p.suggestedModel || 'nome do modelo' }),
      h('button', { class: 'mod-btn mod-btn-secondary ana-refresh', type: 'button', title: 'Buscar os modelos deste servidor', 'aria-label': `Buscar os modelos de ${p.label}`, onclick: (e) => listModels(p, e.currentTarget) }, [icon('refresh')])
    ]),
    h('datalist', { id: `anaModels-${p.id}` }, list.map((id) => h('option', { value: id })))
  ]);

  const consent = p.isLocal ? null : h('label', { class: 'ana-consent' }, [
    h('input', { type: 'checkbox', class: 'st-switch ana-accept', checked: !p.needsRemoteConsent, onchange: (e) => save({ provider: { id: p.id, acceptRemote: e.target.checked } }, { quiet: true, focus: `.ana-prov[data-id="${p.id}"] .ana-accept` }) }),
    h('span', { text: 'Entendo que o texto enviado à IA vai para este servidor externo.' })
  ]);

  const advanced = h('details', { class: 'ana-adv' }, [
    h('summary', { text: 'Avançado' }),
    h('div', { class: 'ana-adv-body' }, [
      h('label', { class: 'mod-field' }, [h('span', { class: 'mod-field-label', text: 'Nome' }), h('input', { class: 'mod-input ana-name', type: 'text', maxlength: '40', value: p.label })]),
      h('label', { class: 'mod-field' }, [
        h('span', { class: 'mod-field-label', text: 'Endereço' }),
        h('input', { class: 'mod-input ana-url', type: 'text', spellcheck: 'false', value: p.baseUrl }),
        h('span', { class: 'mod-hint', text: 'Mudar de servidor apaga a chave guardada deste provedor.' })
      ]),
      confirmRemove === p.id
        ? h('div', { class: 'ana-confirm', role: 'alertdialog', 'aria-label': `Remover ${p.label}` }, [
          h('span', { text: `Remover ${p.label}? A chave guardada dele também será apagada.` }),
          h('div', { class: 'mod-actions' }, [
            h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-remove-yes', type: 'button', onclick: () => { confirmRemove = null; cardStatus.delete(p.id); modelLists.delete(p.id); save({ removeProvider: p.id }); } }, 'Remover'),
            h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm ana-remove-no', type: 'button', onclick: () => { confirmRemove = null; focusAfter = `.ana-prov[data-id="${p.id}"] .ana-remove`; render(); } }, 'Cancelar')
          ])
        ])
        : h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-self-start ana-remove', type: 'button', onclick: () => { confirmRemove = p.id; focusAfter = `.ana-prov[data-id="${p.id}"] .ana-remove-yes`; render(); } }, [icon('delete'), 'Remover provedor'])
    ])
  ]);
  if (confirmRemove === p.id) advanced.open = true;

  return h('li', { class: `ana-prov${p.enabled ? '' : ' ana-prov-off'}`, 'data-id': p.id, role: 'group', 'aria-labelledby': titleId }, [
    head, ...info, keyBlock, modelBlock, consent,
    h('div', { class: 'mod-actions' }, [
      h('button', { class: 'mod-btn mod-btn-primary ana-save', type: 'button', onclick: (e) => saveAndTest(p, e.currentTarget) }, [icon('wifi_tethering'), 'Salvar e testar'])
    ]),
    h('div', { class: `ana-status${st && st.kind ? ` ana-${st.kind}` : ''}`, 'data-status': p.id, role: 'status', text: st ? st.text : '' }),
    advanced
  ]);
}

function buildAdd() {
  return h('details', { class: 'ana-add' }, [
    h('summary', { class: 'mod-btn mod-btn-secondary ana-add-btn' }, [icon('add'), 'Adicionar provedor']),
    h('ul', { class: 'ana-presets', 'aria-label': 'Tipos de provedor' }, config.presets.map((p) => h('li', {}, [
      h('button', { class: 'ana-preset', type: 'button', 'data-preset': p.id, onclick: (e) => { e.currentTarget.closest('details').open = false; addProvider(p.id); } }, p.label)
    ])))
  ]);
}

// ------------------------------------------------------------------ cartão geral

function render() {
  if (!root || !config) return;
  const host = $('anaHost');
  const has = config.providers.length > 0;

  const head = h('div', { class: 'mod-head' }, [
    h('div', { class: 'mod-head-icon' }, [icon('auto_awesome')]),
    h('div', { class: 'mod-head-text' }, [
      h('h3', { text: 'Provedores de IA' }),
      h('p', { text: 'Opcional. Usados para resumir transcrições (em um arquivo .analise.md) e pelo assistente. A ordem da lista é a prioridade: o primeiro responde e, se falhar, o próximo continua.' })
    ]),
    h('span', { class: `mod-state mod-state-${config.ready ? 'ok' : 'off'}`, text: config.ready ? 'Pronta' : 'Não configurada' })
  ]);

  const body = h('div', { class: 'mod-section' });
  if (has) {
    body.append(h('ul', { class: 'ana-list', 'aria-label': 'Provedores de IA, em ordem de prioridade' }, config.providers.map(buildCard)));
  } else {
    body.append(h('p', { class: 'mod-muted ana-empty', text: 'Nenhum provedor ainda. Adicione um para usar o assistente e a análise de transcrições.' }));
  }
  body.append(buildAdd());

  if (config.providers.length > 1) {
    body.append(h('label', { class: 'ana-fallback' }, [
      h('input', { type: 'checkbox', class: 'st-switch ana-fallback-input', id: 'anaFallback', checked: config.fallbackEnabled, onchange: (e) => save({ fallbackEnabled: e.target.checked }, { quiet: true, focus: '#anaFallback' }) }),
      h('span', { class: 'ana-fallback-text' }, [
        h('strong', { text: 'Usar o próximo provedor se este falhar (mantém a conversa)' }),
        h('span', { class: 'mod-hint', text: 'Se um servidor ficar fora do ar, atingir o limite de uso ou recusar a chave, a conversa continua no próximo da lista.' })
      ])
    ]));
  }

  body.append(h('details', { class: 'ana-adv' }, [
    h('summary', { text: 'Avançado' }),
    h('label', { class: 'mod-field' }, [
      h('span', { class: 'mod-field-label', text: 'Tamanho máximo de cada resposta (tokens)' }),
      h('input', { id: 'anaMaxTokens', class: 'mod-input mod-input-short', type: 'number', min: '64', max: '8192', step: '64', value: String(config.maxTokens), onchange: (e) => save({ maxTokens: Number(e.target.value) }, { quiet: true }) }),
      h('span', { class: 'mod-hint', text: 'Se a análise vier cortada no meio, aumente este valor.' })
    ])
  ]));
  body.append(h('div', { id: 'anaStatus', class: 'ana-status', role: 'status' }));

  clear(host).append(head, body);
  paintStatus();
  if (focusAfter) {
    // vários seletores separados por "||": foca o primeiro que existe e não está desabilitado
    const target = String(focusAfter).split('||').map((sel) => root.querySelector(sel)).find((el) => el && !el.disabled);
    focusAfter = null;
    if (target && typeof target.focus === 'function') target.focus();
  }
}

// ------------------------------------------------------------------ ciclo de vida

/** Monta o cartão dentro de `container` (Configurações → Inteligência Artificial) e carrega a configuração. */
export async function mountAnalysisPanel(container) {
  root = container;
  clear(root);
  root.append(h('div', { class: 'mod-screen mod-embedded' }, [h('section', { id: 'anaHost', class: 'mod-card ana-card', 'aria-label': 'Provedores de IA' })]));
  statusLine = null;
  cardStatus = new Map();
  keyEdit = new Set();
  modelLists = new Map();
  confirmRemove = null;
  focusAfter = null;
  try {
    config = await call(window.bds?.aiGetConfig);
    render();
  } catch (err) {
    clear($('anaHost')).append(h('p', { class: 'mod-muted', text: `Não foi possível carregar a configuração da IA: ${err.message}` }));
  }
}

/** Solta o conteúdo ao sair das Configurações. */
export function unmountAnalysisPanel() {
  if (root) clear(root);
  root = null;
  config = null;
  statusLine = null;
  cardStatus = new Map();
  keyEdit = new Set();
  modelLists = new Map();
  confirmRemove = null;
  focusAfter = null;
}
