/**
 * Seção "Áudio" do card Provedores (Configurações → Inteligência Artificial → Provedores): os motores de transcrição
 * na MESMA lista ordenada — Neste computador, Groq, ElevenLabs (e os que vierem). A ordem é a ordem de tentativa do modo
 * Automático da tela de Transcrição; o interruptor diz se o motor entra nele. De fábrica só "Neste computador" está
 * ligado: o áudio nunca sai do computador sem o usuário ligar um serviço de nuvem (e confirmar). A chave de cada
 * serviço fica criptografada no computador e nunca volta para a tela; se o provedor de chat tem uma chave do mesmo
 * serviço, ela também vale aqui ("Usando a chave do provedor de chat"). Salva na hora (sem a barra "Salvar").
 * Textos entram sempre por textContent.
 */

let host = null;
let cloud = null;            // modulesCloudGet: { encryptionAvailable, providers:[{ id, label, hasKey, keySource, model, models }] }
let order = [];              // todos os motores, na ordem escolhida
let enabled = new Set();     // motores ligados
let localStatus = null;      // modulesGetStatus().whisper
let expanded = new Set();
let keyEdit = new Set();
let rowStatus = new Map();   // id -> { text, kind }
let found = [];              // catálogo de modelos de áudio por provedor de chat: [{ label, host, count }] (só informação)

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

const cloudOf = (id) => (cloud ? cloud.providers.find((p) => p.id === id) : null);
const labelOf = (id) => (id === 'local' ? 'Neste computador' : (cloudOf(id) || {}).label || id);

function setRowStatus(id, text, kind = '') {
  if (text) rowStatus.set(id, { text, kind }); else rowStatus.delete(id);
  const el = host && host.querySelector(`[data-aud-status="${id}"]`);
  if (!el) return;
  el.textContent = text || '';
  el.className = `aud-status${kind ? ` aud-${kind}` : ''}`;
}

/** Grava a ordem e os ligados na hora (settings.json). */
async function persist() {
  // saveSettings devolve as configurações salvas (não { ok, data }); falha do canal vira exceção
  if (typeof window.bds?.saveSettings !== 'function') throw new Error('Recurso indisponível nesta versão do app.');
  await window.bds.saveSettings({ transcriptionOrder: [...order], transcriptionFallback: order.filter((id) => enabled.has(id)) });
}

/** Provedores de chat que têm modelos de áudio no catálogo guardado (vem de aiGetConfig; só texto, sem seletor). */
function catalogOf(ai) {
  const list = ai && Array.isArray(ai.providers) ? ai.providers : [];
  const out = [];
  for (const p of list) {
    const count = p && p.modelCounts ? Number(p.modelCounts.audio) || 0 : 0;
    if (count <= 0) continue;
    let host = '';
    try { host = new URL(String(p.baseUrl)).hostname.toLowerCase(); } catch (_) { host = ''; }
    // o motor só reaproveita a chave do provedor quando ele está ligado e sem o aviso de servidor externo pendente
    out.push({ label: String(p.label || ''), host, count, shared: p.enabled !== false && !p.needsRemoteConsent });
  }
  return out;
}

const SERVICE_BY_HOST = { 'api.groq.com': 'Groq', 'api.openai.com': 'OpenAI' };

function buildFound(f) {
  const service = SERVICE_BY_HOST[f.host];
  return h('div', { class: 'aud-found' }, [
    h('strong', { text: `Modelos de áudio encontrados em ${f.label}: ${f.count}.` }),
    h('span', { class: 'mod-hint', text: !service ? 'Ainda não há motor de transcrição para este endereço.' : (f.shared ? `Ligue o ${service} acima: ele usa a chave deste provedor.` : `Ative o ${service} em Chat e aceite o aviso de servidor externo: o motor usa a chave dele.`) })
  ]);
}

async function load() {
  const get = async (fn, ...a) => { try { return await call(fn, ...a); } catch (_) { return null; } };
  const [c, s, st, ai] = await Promise.all([
    get(window.bds?.modulesCloudGet),
    (async () => { try { return await window.bds?.getSettings?.(); } catch (_) { return null; } })(),
    get(window.bds?.modulesGetStatus),
    get(window.bds?.aiGetConfig)
  ]);
  cloud = c;
  found = catalogOf(ai);
  localStatus = st && st.whisper ? st.whisper : null;
  const known = ['local', ...(cloud ? cloud.providers.map((p) => p.id) : [])];
  const saved = s && Array.isArray(s.transcriptionOrder) ? s.transcriptionOrder.filter((id) => known.includes(id)) : [];
  order = [...new Set([...saved, ...known])];
  const on = s && Array.isArray(s.transcriptionFallback) ? s.transcriptionFallback : ['local'];
  enabled = new Set(on.filter((id) => known.includes(id)));
}

// ------------------------------------------------------------------ estado e ações

function stateOf(id) {
  if (id === 'local') {
    const ready = Boolean(localStatus && localStatus.ready);
    if (!enabled.has('local')) return { text: 'Desligado', cls: 'off' };
    return ready ? { text: 'Pronto', cls: 'ok' } : { text: 'Falta instalar', cls: 'warn' };
  }
  const p = cloudOf(id);
  if (!p || !p.hasKey) return { text: 'Sem chave', cls: 'warn' };
  return enabled.has(id) ? { text: 'Ligado', cls: 'ok' } : { text: 'Desligado', cls: 'off' };
}

async function toggle(id, on, input) {
  if (on && id !== 'local') {
    const ok = await window.bdsModal.confirm(`Ligar o ${labelOf(id)}? No modo Automático da tela de Transcrição, o áudio dos arquivos será enviado a ele pela internet. A cobrança (se houver) é do seu plano nele.`);
    if (!ok) { input.checked = false; return; }
  }
  if (on) enabled.add(id); else enabled.delete(id);
  try { await persist(); render(); } catch (err) {
    if (on) enabled.delete(id); else enabled.add(id);
    input.checked = !on;
    setRowStatus(id, err.message, 'error');
  }
}

async function move(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= order.length) return;
  const before = [...order];
  [order[index], order[to]] = [order[to], order[index]];
  try { await persist(); render(); } catch (err) { order = before; render(); }
}

async function saveAndTest(id, btn) {
  const p = cloudOf(id);
  if (!p) return;
  btn.disabled = true;
  try {
    const card = host.querySelector(`.aud-row[data-id="${id}"]`);
    const key = card.querySelector('.aud-key');
    const model = card.querySelector('.aud-model');
    const patch = { provider: id };
    if (key && key.value.trim()) patch.apiKey = key.value.trim();
    if (model) patch.model = model.value;
    setRowStatus(id, 'Salvando…');
    cloud = await call(window.bds?.modulesCloudSet, patch);
    keyEdit.delete(id);
    setRowStatus(id, 'Testando a chave…');
    const res = await call(window.bds?.modulesCloudTest, id);
    rowStatus.set(id, { text: res && res.limited ? `A chave do ${p.label} é válida (com permissões restritas).` : `A chave do ${p.label} está funcionando.`, kind: 'ok' });
    render();
  } catch (err) {
    try { cloud = await call(window.bds?.modulesCloudGet); } catch (_) { /* mantém */ }
    rowStatus.set(id, { text: err.message, kind: 'error' });
    render();
  }
}

async function removeKey(id) {
  const ok = await window.bdsModal.confirm(`Remover a chave do ${labelOf(id)} deste computador?`);
  if (!ok) return;
  try {
    cloud = await call(window.bds?.modulesCloudSet, { provider: id, clearApiKey: true });
    enabled.delete(id);
    await persist();
    rowStatus.delete(id);
    render();
  } catch (err) { setRowStatus(id, err.message, 'error'); }
}

// ------------------------------------------------------------------ linhas

function buildLocalDetail() {
  const model = localStatus && Array.isArray(localStatus.models) ? localStatus.models.find((m) => m.active) : null;
  const text = !localStatus ? 'O estado da transcrição neste computador não está disponível agora.'
    : !localStatus.engine.installed ? 'A transcrição neste computador ainda não está instalada.'
      : model ? `Usa o modelo ${model.label}. Nada sai do computador.` : 'Nenhum modelo instalado ainda.';
  return [
    h('p', { class: 'mod-hint', text }),
    h('button', {
      class: 'mod-btn mod-btn-secondary mod-btn-sm aud-self-start', type: 'button',
      onclick: () => window.dispatchEvent(new CustomEvent('bds:ai-open-sub', { detail: 'local' }))
    }, [icon('tune'), 'Gerenciar modelos'])
  ];
}

function buildCloudDetail(p) {
  const st = rowStatus.get(p.id);
  const shared = p.keySource === 'chat';
  const editing = keyEdit.has(p.id);
  const parts = [h('p', { class: 'mod-hint', text: `O áudio é enviado ao ${p.label} pela internet. A cobrança é do seu plano nele.` })];

  if (p.hasKey && !editing) {
    parts.push(h('div', { class: 'mod-field' }, [
      h('span', { class: 'mod-field-label', text: 'Chave de API' }),
      h('div', { class: 'aud-keyrow' }, [
        h('span', { class: 'aud-keysaved' }, [icon('lock'), shared ? 'Usando a chave do provedor de chat' : 'Chave guardada']),
        h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm aud-key-change', type: 'button', 'aria-label': `Trocar a chave do ${p.label}`, onclick: () => { keyEdit.add(p.id); render(); } }, shared ? 'Usar outra' : 'Trocar')
      ])
    ]));
  } else {
    parts.push(h('div', { class: 'mod-field' }, [
      h('label', { class: 'mod-field-label', for: `audKey-${p.id}`, text: 'Chave de API' }),
      h('input', { id: `audKey-${p.id}`, class: 'mod-input aud-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Cole a chave aqui', disabled: !(cloud && cloud.encryptionAvailable) }),
      h('span', { class: 'mod-hint', text: cloud && cloud.encryptionAvailable ? 'Fica criptografada neste computador e nunca é exibida de novo.' : 'A criptografia do sistema não está disponível: não é possível guardar a chave.' })
    ]));
  }

  if (p.models.length > 1) {
    parts.push(h('div', { class: 'mod-field' }, [
      h('label', { class: 'mod-field-label', for: `audModel-${p.id}`, text: 'Modelo' }),
      h('select', { id: `audModel-${p.id}`, class: 'mod-input aud-model' }, p.models.map((m) => {
        const o = h('option', { value: m.id, text: `${m.label} — ${m.hint}` });
        if (m.id === p.model) o.selected = true;
        return o;
      }))
    ]));
  }
  parts.push(h('div', { class: 'mod-actions' }, [
    h('button', { class: 'mod-btn mod-btn-primary aud-save', type: 'button', onclick: (e) => saveAndTest(p.id, e.currentTarget) }, [icon('wifi_tethering'), 'Salvar e testar'])
  ]));
  parts.push(h('div', { class: `aud-status${st && st.kind ? ` aud-${st.kind}` : ''}`, 'data-aud-status': p.id, role: 'status', text: st ? st.text : '' }));
  if (p.hasKey && !shared) {
    parts.push(h('details', { class: 'ana-adv' }, [
      h('summary', { text: 'Avançado' }),
      h('button', { class: 'mod-btn mod-btn-ghost mod-btn-sm aud-self-start aud-key-remove', type: 'button', 'aria-label': `Remover a chave do ${p.label}`, onclick: () => removeKey(p.id) }, 'Remover a chave guardada')
    ]));
  }
  return parts;
}

function buildRow(id, index) {
  const state = stateOf(id);
  const isLocal = id === 'local';
  const p = isLocal ? null : cloudOf(id);
  const open = expanded.has(id);
  const titleId = `audTitle-${id}`;
  const detailId = `audDetail-${id}`;
  const canEnable = isLocal || Boolean(p && p.hasKey);

  const head = h('div', { class: 'aud-row-head' }, [
    h('span', { class: 'ana-grip aud-grip', title: 'Arraste para mudar a ordem', 'aria-hidden': 'true' }, [icon('drag_indicator')]),
    h('button', {
      class: 'ana-toggle aud-toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailId,
      onclick: () => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); }
    }, [
      h('span', { class: 'ana-prov-title' }, [
        h('strong', { id: titleId, text: labelOf(id) }),
        h('span', { class: `mod-badge ana-state ana-state-${state.cls}`, text: state.text })
      ]),
      icon(open ? 'expand_less' : 'expand_more')
    ]),
    h('div', { class: 'ana-prov-tools' }, [
      h('button', { class: 'mod-icon-btn aud-up', type: 'button', title: 'Subir', 'aria-label': `Subir ${labelOf(id)}`, disabled: index === 0, onclick: () => move(index, -1) }, [icon('arrow_upward')]),
      h('button', { class: 'mod-icon-btn aud-down', type: 'button', title: 'Descer', 'aria-label': `Descer ${labelOf(id)}`, disabled: index === order.length - 1, onclick: () => move(index, 1) }, [icon('arrow_downward')]),
      h('input', {
        type: 'checkbox', class: 'st-switch aud-enabled', checked: enabled.has(id), disabled: !canEnable,
        title: canEnable ? '' : 'Informe a chave para ligar', 'aria-label': `Usar ${labelOf(id)} no modo Automático`,
        onchange: (e) => toggle(id, e.target.checked, e.target)
      })
    ])
  ]);
  const detail = h('div', { class: 'ana-detail aud-detail', id: detailId, hidden: !open }, isLocal ? buildLocalDetail() : (p ? buildCloudDetail(p) : []));
  return h('li', { class: `aud-row${enabled.has(id) ? '' : ' aud-row-off'}`, 'data-id': id, role: 'group', 'aria-labelledby': titleId }, [head, detail]);
}

/** Arrastar pela alça muda a ordem; grava ao soltar. */
function bindDrag(list) {
  let dragging = null;
  let before = '';
  const ids = () => [...list.querySelectorAll('.aud-row')].map((li) => li.dataset.id);
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.aud-row');
    if (li) li.draggable = Boolean(e.target.closest('.aud-grip'));
  });
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest && e.target.closest('.aud-row');
    if (!li || !li.draggable) { e.preventDefault(); return; }
    dragging = li;
    before = ids().join(',');
    li.classList.add('ana-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.dataset.id); }
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('.aud-row');
    if (!over || over === dragging) return;
    const rect = over.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY > rect.top + rect.height / 2 ? over.nextElementSibling : over);
  });
  list.addEventListener('dragend', async () => {
    if (!dragging) return;
    dragging.classList.remove('ana-dragging');
    dragging.draggable = false;
    const next = ids();
    dragging = null;
    if (next.join(',') === before) return;
    const previous = [...order];
    order = next;
    try { await persist(); } catch (_) { order = previous; }
    render();
  });
}

function render() {
  if (!host) return;
  clear(host);
  if (!cloud && !localStatus) {
    host.append(h('p', { class: 'mod-muted', text: 'Não foi possível carregar os motores de transcrição.' }));
    return;
  }
  const list = h('ul', { class: 'ana-list aud-list', 'aria-label': 'Motores de transcrição, em ordem de tentativa' }, order.map(buildRow));
  bindDrag(list);
  host.append(
    list,
    h('p', { class: 'mod-hint aud-note', text: 'Vale para o modo Automático da tela de Transcrição: o primeiro ligado e pronto transcreve; se falhar por causa do serviço, o próximo continua. De fábrica só este computador está ligado.' })
  );
  if (found.length) host.append(h('div', { class: 'aud-catalog' }, found.map(buildFound)));
}

// ------------------------------------------------------------------ ciclo de vida

/** Desenha a seção dentro de `container` (recarrega os dados toda vez). */
export async function mountAudioSection(container) {
  host = container;
  if (!host) return;
  await load();
  if (host !== container) return; // saiu da tela enquanto carregava
  render();
}

export function unmountAudioSection() {
  host = null;
  cloud = null;
  localStatus = null;
  found = [];
  order = [];
  enabled = new Set();
  expanded = new Set();
  keyEdit = new Set();
  rowStatus = new Map();
}
