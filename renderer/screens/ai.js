/**
 * Tela "Assistente IA" — chat + configuração do servidor de IA.
 * Usa a API da OpenAI por padrão; a URL do servidor é editável (Ollama, LM Studio, etc.).
 * Toda comunicação passa por window.bds.ai* (IPC). A chave de API nunca é lida de volta:
 * o campo só serve para gravar uma nova.
 */

let config = null;
let history = [];          // { role: 'user'|'assistant', content: string } — mantido enquanto o app estiver aberto
let sending = false;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = '') {
  const el = $('aiConfigStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `ai-hint${kind ? ' ai-status-' + kind : ''}`;
}

function showNotice(text, kind = 'warn') {
  const el = $('aiNotice');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.className = `ai-notice ai-notice-${kind}`;
}

/** Chama a API e devolve data, ou lança Error com a mensagem do backend. */
async function call(fn, ...args) {
  if (typeof fn !== 'function') throw new Error('Recurso de IA indisponível nesta versão do app.');
  const res = await fn(...args);
  if (!res || !res.ok) throw new Error(res?.error || 'Falha desconhecida.');
  return res.data;
}

// ---------------------------------------------------------------- configuração

const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url || '');
const isOfficial = (url) => /^https:\/\/api\.openai\.com(\/|$)/i.test(url || '');

/** Preset que corresponde à URL atual (ou "Personalizado"). */
function presetFor(url) {
  const normalized = String(url || '').replace(/\/+$/, '');
  return (config.presets.find(p => p.baseUrl && p.baseUrl === normalized) || config.presets.find(p => p.id === 'custom')).id;
}

function renderConfig() {
  if (!config) return;

  const preset = $('aiPreset');
  preset.innerHTML = '';
  config.presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    preset.appendChild(opt);
  });
  preset.value = presetFor(config.baseUrl);

  $('aiBaseUrl').value = config.baseUrl || '';
  $('aiModel').value = config.model || '';
  $('aiMaxTokens').value = config.maxTokens;
  $('aiInstructions').value = config.customInstructions || '';
  $('aiApiKey').value = '';

  updateUrlHint();
  updateKeyHint();
  $('aiBtnClearKey').classList.toggle('hidden', !config.hasKey);

  renderTasks();
  updateActiveBadge();
  updateReadiness();
}

function updateUrlHint() {
  const url = $('aiBaseUrl').value.trim();
  const hint = $('aiUrlHint');
  if (isOfficial(url)) hint.textContent = 'API oficial da OpenAI.';
  else if (isLocalUrl(url)) hint.textContent = 'Servidor na sua máquina: nada sai do computador.';
  else hint.textContent = 'Servidor externo: suas conversas e a chave serão enviadas para ele. Use https://.';
}

function updateKeyHint() {
  const url = $('aiBaseUrl').value.trim();
  const hint = $('aiKeyHint');
  if (!config.encryptionAvailable) {
    hint.textContent = 'A criptografia do sistema não está disponível: não é possível guardar a chave com segurança.';
    return;
  }
  const need = isOfficial(url) ? 'Obrigatória para a OpenAI. ' : (isLocalUrl(url) ? 'Opcional em servidores locais. ' : '');
  hint.textContent = need + (config.hasKey
    ? 'Há uma chave guardada (criptografada). Digite outra para substituí-la.'
    : 'É guardada criptografada neste computador e nunca é exibida de novo.');
}

function updateActiveBadge() {
  const badge = $('aiActiveBadge');
  if (!badge || !config) return;
  let host = '';
  try { host = new URL(config.baseUrl).host; } catch (_) { host = config.baseUrl; }
  badge.textContent = `${host} · ${config.model || 'sem modelo'}`;
}

function isReady() {
  if (!config || !config.model) return false;
  return config.isOfficialOpenAI ? config.hasKey : true;
}

function updateReadiness() {
  if (!config) return;
  if (isReady()) { showNotice(''); return; }
  showNotice(!config.model
    ? 'Informe um modelo e salve para começar a conversar.'
    : 'Informe sua chave de API da OpenAI e salve para começar a conversar.');
}

function renderTasks() {
  const list = $('aiTasks');
  if (!list) return;
  list.innerHTML = '';
  (config.tasks || []).forEach(t => {
    const li = document.createElement('li');
    li.className = 'ai-task';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = t.label;
    const desc = document.createElement('span');
    desc.textContent = t.description;
    info.append(name, desc);
    const tag = document.createElement('span');
    tag.className = `ai-task-tag${t.implemented ? ' on' : ''}`;
    tag.textContent = t.implemented ? 'Ativo' : 'Em breve';
    li.append(info, tag);
    list.appendChild(li);
  });
}

function collectPatch() {
  const patch = {
    baseUrl: $('aiBaseUrl').value,
    model: $('aiModel').value,
    maxTokens: Number($('aiMaxTokens').value),
    customInstructions: $('aiInstructions').value
  };
  const key = $('aiApiKey').value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

async function saveConfig() {
  try {
    setStatus('Salvando…');
    config = await call(window.bds?.aiSaveConfig, collectPatch());
    renderConfig();
    setStatus('Configuração salva.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function testConnection() {
  try {
    setStatus('Testando conexão…');
    // Salva antes para testar exatamente o que está na tela
    config = await call(window.bds?.aiSaveConfig, collectPatch());
    renderConfig();
    const res = await call(window.bds?.aiTestConnection);
    setStatus(res.message, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function refreshModels() {
  try {
    setStatus('Buscando modelos…');
    config = await call(window.bds?.aiSaveConfig, collectPatch());
    renderConfig();
    const models = await call(window.bds?.aiListModels);
    const list = $('aiModelList');
    list.innerHTML = '';
    models.forEach(m => { const opt = document.createElement('option'); opt.value = m.id; list.appendChild(opt); });
    setStatus(models.length
      ? `${models.length} modelo(s) disponível(is): clique no campo Modelo para escolher.`
      : 'O servidor não listou nenhum modelo.', models.length ? 'ok' : 'error');
    if (models.length) $('aiModel').focus();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function clearKey() {
  try {
    config = await call(window.bds?.aiSaveConfig, { clearApiKey: true });
    renderConfig();
    setStatus('Chave removida.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/** Escolher um atalho de servidor preenche a URL (continua editável). */
function onPresetChange() {
  const preset = config?.presets.find(p => p.id === $('aiPreset').value);
  if (preset && preset.baseUrl) $('aiBaseUrl').value = preset.baseUrl;
  if (preset?.id === 'custom') $('aiBaseUrl').focus();
  updateUrlHint();
  updateKeyHint();
}

function onUrlInput() {
  if (config) $('aiPreset').value = presetFor($('aiBaseUrl').value);
  updateUrlHint();
  updateKeyHint();
}

// ------------------------------------------------------------------------ chat

function addBubble(role, text, extraClass = '') {
  const box = $('aiMessages');
  box.querySelector('.ai-empty')?.remove();
  const row = document.createElement('div');
  row.className = `ai-msg ai-msg-${role} ${extraClass}`.trim();
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  bubble.textContent = text;           // textContent: nunca interpreta HTML vindo da IA
  row.appendChild(bubble);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  return row;
}

function renderHistory() {
  const box = $('aiMessages');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = `<div class="ai-empty"><span class="material-symbols-rounded" aria-hidden="true">forum</span>
      <strong>Como posso ajudar?</strong>
      <span>Pergunte sobre o BDS, peça ideias de organização da biblioteca ou ajuda com conversões e metadados.</span></div>`;
    return;
  }
  history.forEach(m => addBubble(m.role, m.content));
}

function setSending(value) {
  sending = value;
  $('aiBtnSend').disabled = value;
  $('aiInput').disabled = value;
}

async function sendMessage() {
  if (sending) return;
  const input = $('aiInput');
  const text = input.value.trim();
  if (!text) return;
  if (!isReady()) { updateReadiness(); return; }

  history.push({ role: 'user', content: text });
  const userRow = addBubble('user', text);
  input.value = '';
  setSending(true);
  const pending = addBubble('assistant', 'Pensando…', 'ai-msg-pending');

  try {
    const res = await call(window.bds?.aiChat, history);
    const answer = (res.text || '').trim() || '(resposta vazia)';
    history.push({ role: 'assistant', content: answer });
    pending.remove();
    addBubble('assistant', answer);
  } catch (err) {
    // Mantém o histórico consistente: remove a pergunta que não obteve resposta
    history.pop();
    userRow.remove();
    pending.remove();
    addBubble('assistant', `Não foi possível responder: ${err.message}`, 'ai-msg-error');
    input.value = text;
  } finally {
    setSending(false);
    input.focus();
  }
}

function newChat() {
  if (sending) return;
  history = [];
  renderHistory();
  $('aiInput').focus();
}

// ------------------------------------------------------------------- ciclo de vida

export async function initScreen() {
  $('aiForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  $('aiInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  $('aiBtnNewChat')?.addEventListener('click', newChat);
  $('aiBtnSave')?.addEventListener('click', saveConfig);
  $('aiBtnTest')?.addEventListener('click', testConnection);
  $('aiBtnRefreshModels')?.addEventListener('click', refreshModels);
  $('aiBtnClearKey')?.addEventListener('click', clearKey);
  $('aiPreset')?.addEventListener('change', onPresetChange);
  $('aiBaseUrl')?.addEventListener('input', onUrlInput);

  renderHistory();
  try {
    config = await call(window.bds?.aiGetConfig);
    renderConfig();
  } catch (err) {
    showNotice(`Não foi possível carregar a configuração da IA: ${err.message}`, 'error');
  }
}

export function onLeave() { /* sem listeners globais para remover */ }
