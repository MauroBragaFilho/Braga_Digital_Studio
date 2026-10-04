/**
 * Painel "Servidor de IA" da seção Configurações → Inteligência Artificial — escolhe o servidor de IA usado
 * pela análise de transcrições e pelo assistente (LM Studio, Ollama, OpenAI ou outro compatível). É opcional:
 * sem ele, a transcrição funciona normalmente. A configuração é a mesma do assistente (window.bds.ai*); a chave de API só é
 * gravada (criptografada) e nunca volta para a tela. Textos entram sempre por textContent.
 */

let config = null;
let root = null;
let editing = false;
let statusLine = null;       // { text, kind } mostrado sob o formulário/resumo

const $ = (id) => (root ? root.querySelector(`#${id}`) : null);

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'hidden') el[k] = !!v;
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

const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url || '');
const isOfficial = (url) => /^https:\/\/api\.openai\.com(\/|$)/i.test(url || '');
const isReady = () => Boolean(config && config.model && (config.isOfficialOpenAI ? config.hasKey : true));

function presetFor(url) {
  const normalized = String(url || '').replace(/\/+$/, '');
  return (config.presets.find((p) => p.baseUrl && p.baseUrl === normalized) || config.presets.find((p) => p.id === 'custom')).id;
}

function serverHint(url) {
  if (isOfficial(url)) return 'API oficial da OpenAI: o texto enviado à IA sai do computador pela internet.';
  if (isLocalUrl(url)) return 'Servidor na sua máquina: o texto enviado à IA não sai do computador.';
  return 'Servidor externo: o texto enviado à IA e a chave serão enviados a ele. Use https://.';
}

function keyHint(url) {
  if (!config.encryptionAvailable) return 'A criptografia do sistema não está disponível: não é possível guardar a chave com segurança.';
  const need = isOfficial(url) ? 'Obrigatória para a OpenAI. ' : (isLocalUrl(url) ? 'Opcional em servidores locais. ' : '');
  return need + (config.hasKey ? 'Há uma chave guardada (criptografada). Digite outra para substituí-la.' : 'Fica criptografada neste computador e nunca é exibida de novo.');
}

function setStatus(text, kind = '') {
  statusLine = text ? { text, kind } : null;
  const el = $('anaStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `ana-status${kind ? ` ana-${kind}` : ''}`;
}

// ------------------------------------------------------------------ formulário

function readPatch() {
  const patch = {
    baseUrl: $('anaUrl').value,
    model: $('anaModel').value,
    maxTokens: Number($('anaMaxTokens').value)
  };
  const key = $('anaKey').value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

function refreshHints() {
  const url = $('anaUrl').value.trim();
  $('anaUrlHint').textContent = serverHint(url);
  $('anaKeyHint').textContent = keyHint(url);
  $('anaPreset').value = presetFor(url);
}

async function saveAndTest() {
  const btn = $('anaSave');
  btn.disabled = true;
  try {
    setStatus('Salvando…');
    config = await call(window.bds?.aiSaveConfig, readPatch());
    if (!config.model) throw new Error('Informe o modelo (o botão de atualizar lista os modelos do servidor).');
    setStatus('Testando a conexão…');
    const res = await call(window.bds?.aiTestConnection);
    editing = false;
    statusLine = { text: res.message, kind: 'ok' };
    render();
  } catch (err) {
    setStatus(err.message, 'error');
    btn.disabled = false;
  }
}

async function listModels() {
  const btn = $('anaRefresh');
  btn.disabled = true;
  try {
    setStatus('Buscando modelos…');
    config = await call(window.bds?.aiSaveConfig, readPatch());
    const models = await call(window.bds?.aiListModels);
    const list = clear($('anaModelList'));
    models.forEach((m) => list.append(h('option', { value: m.id })));
    const field = $('anaModel');
    if (!field.value.trim() && models.length === 1) field.value = models[0].id; // LM Studio: um modelo carregado
    setStatus(models.length ? `${models.length} modelo(s) disponível(is): clique no campo Modelo para escolher.` : 'O servidor não listou nenhum modelo.', models.length ? 'ok' : 'error');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function removeKey() {
  try {
    config = await call(window.bds?.aiSaveConfig, { clearApiKey: true });
    statusLine = { text: 'Chave removida.', kind: 'ok' };
    render();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function buildForm() {
  const preset = h('select', { id: 'anaPreset', class: 'mod-input', 'aria-label': 'Servidor' },
    config.presets.map((p) => h('option', { value: p.id, text: p.label })));
  preset.value = presetFor(config.baseUrl);
  preset.addEventListener('change', () => {
    const p = config.presets.find((x) => x.id === preset.value);
    if (p && p.baseUrl) $('anaUrl').value = p.baseUrl;
    if (p && p.id === 'custom') $('anaUrl').focus();
    refreshHints();
  });

  const url = h('input', { id: 'anaUrl', class: 'mod-input', type: 'text', spellcheck: 'false', value: config.baseUrl || '', placeholder: 'http://localhost:1234/v1' });
  url.addEventListener('input', refreshHints);

  return h('div', { class: 'ana-form' }, [
    h('label', { class: 'mod-field' }, [h('span', { class: 'mod-field-label', text: 'Servidor' }), preset]),
    h('label', { class: 'mod-field' }, [
      h('span', { class: 'mod-field-label', text: 'Endereço' }), url,
      h('span', { id: 'anaUrlHint', class: 'mod-hint' })
    ]),
    h('div', { class: 'mod-field' }, [
      h('label', { class: 'mod-field-label', for: 'anaModel', text: 'Modelo' }),
      h('div', { class: 'ana-row' }, [
        h('input', { id: 'anaModel', class: 'mod-input', type: 'text', list: 'anaModelList', spellcheck: 'false', autocomplete: 'off', value: config.model || '', placeholder: 'ex.: o modelo carregado no LM Studio' }),
        h('button', { id: 'anaRefresh', class: 'mod-btn mod-btn-secondary', type: 'button', title: 'Buscar os modelos do servidor', 'aria-label': 'Buscar os modelos do servidor', onclick: listModels }, [icon('refresh')])
      ]),
      h('datalist', { id: 'anaModelList' })
    ]),
    h('div', { class: 'mod-field' }, [
      h('label', { class: 'mod-field-label', for: 'anaKey', text: 'Chave de API' }),
      h('input', { id: 'anaKey', class: 'mod-input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-…' }),
      h('span', { id: 'anaKeyHint', class: 'mod-hint' }),
      config.hasKey ? h('button', { class: 'mod-btn mod-btn-danger mod-btn-sm ana-self-start', type: 'button', onclick: removeKey }, [icon('delete'), 'Remover a chave guardada']) : null
    ]),
    h('details', { class: 'ana-adv' }, [
      h('summary', { text: 'Avançado' }),
      h('label', { class: 'mod-field' }, [
        h('span', { class: 'mod-field-label', text: 'Tamanho máximo de cada resposta (tokens)' }),
        h('input', { id: 'anaMaxTokens', class: 'mod-input mod-input-short', type: 'number', min: '64', max: '8192', step: '64', value: String(config.maxTokens) }),
        h('span', { class: 'mod-hint', text: 'Se a análise vier cortada no meio, aumente este valor.' })
      ])
    ]),
    h('div', { class: 'mod-actions' }, [
      h('button', { id: 'anaSave', class: 'mod-btn mod-btn-primary', type: 'button', onclick: saveAndTest }, [icon('wifi_tethering'), 'Salvar e testar']),
      isReady() ? h('button', { class: 'mod-btn mod-btn-ghost', type: 'button', onclick: () => { editing = false; statusLine = null; render(); } }, 'Cancelar') : null
    ])
  ]);
}

// ------------------------------------------------------------------ cartão

function render() {
  if (!root || !config) return;
  const host = $('anaHost');
  const ready = isReady();
  let serverName = config.baseUrl;
  try { serverName = new URL(config.baseUrl).host; } catch (_) { /* usa o endereço como está */ }

  const head = h('div', { class: 'mod-head' }, [
    h('div', { class: 'mod-head-icon' }, [icon('auto_awesome')]),
    h('div', { class: 'mod-head-text' }, [
      h('h3', { text: 'Servidor de IA' }),
      h('p', { text: 'Opcional. Usado para resumir transcrições (em um arquivo .analise.md) e pelo assistente. Funciona com LM Studio, Ollama ou OpenAI.' })
    ]),
    h('span', { class: `mod-state mod-state-${ready ? 'ok' : 'off'}`, text: ready ? 'Pronta' : 'Não configurada' })
  ]);

  let body;
  if (editing || !ready) {
    body = h('div', { class: 'mod-section' }, [buildForm(), h('div', { id: 'anaStatus', class: 'ana-status' })]);
  } else {
    body = h('div', { class: 'mod-section' }, [
      h('div', { class: 'mod-row' }, [
        h('div', { class: 'mod-row-text' }, [
          h('strong', { text: `${serverName} · ${config.model}` }),
          h('span', { class: 'mod-muted', text: config.isLocal ? 'Servidor na sua máquina: o texto enviado à IA não sai do computador.' : 'Servidor externo: o texto enviado à IA sai do computador.' })
        ]),
        h('div', { class: 'mod-actions' }, [
          h('button', { class: 'mod-btn mod-btn-ghost', type: 'button', onclick: () => { editing = true; statusLine = null; render(); } }, [icon('edit'), 'Alterar'])
        ])
      ]),
      h('div', { id: 'anaStatus', class: 'ana-status' })
    ]);
  }

  clear(host).append(head, body);
  if (editing || !ready) refreshHints();
  if (statusLine) setStatus(statusLine.text, statusLine.kind);
}

// ------------------------------------------------------------------ ciclo de vida

/** Monta o cartão dentro de `container` (Configurações → Inteligência Artificial) e carrega a configuração. */
export async function mountAnalysisPanel(container) {
  root = container;
  clear(root);
  root.append(h('div', { class: 'mod-screen mod-embedded' }, [h('section', { id: 'anaHost', class: 'mod-card ana-card', 'aria-label': 'Servidor de IA' })]));
  statusLine = null;
  try {
    config = await call(window.bds?.aiGetConfig);
    editing = !isReady();
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
}
