/**
 * Assistente de IA flutuante: botão no canto da janela (arrastável, em todas as telas) que abre um painel só com o
 * chat. A configuração (servidor, modelo, chave, interruptor) fica em Configurações → Inteligência Artificial.
 *
 * - Só existe com o módulo "Assistente de IA" ligado (vem ligado por padrão) E o interruptor "Ativar assistente" ligado.
 *   A trava de verdade está no processo principal (ai:* devolve AI_DISABLED); aqui só se esconde o que não funciona.
 * - Cada mensagem leva o contexto da tela (utils/assistantContext.js). Ctrl + J abre/fecha o painel. O evento ai:navigate
 *   abre telas da lista fixa. Única exceção ao "só chat": a mensagem do primeiro uso (sem servidor, servidor fora do ar)
 *   com UM botão "Abrir configurações da IA", e o aviso de privacidade de servidor remoto com "Entendi, continuar".
 * - A conversa mora no processo principal (histórico local): o renderer manda só o texto novo e recebe a resposta
 *   em pedaços (ai:chatDelta / ai:chatDone / ai:chatError).
 * - Quando o assistente consulta ou age no app, o main manda linhas de status (ai:chatStatus): "Consultando a
 *   Biblioteca…", "Aguardando sua confirmação…", "Transcrevendo… 40%". A linha some quando a resposta chega; avisos
 *   (kind 'notice') ficam na conversa. As confirmações NÃO acontecem aqui: são diálogos nativos do app.
 * - Vários provedores de IA com fallback: o nome do provedor em uso aparece em texto pequeno no cabeçalho (kind
 *   'provider'), a troca vira uma linha discreta na conversa ("Usando Qwen (Groq indisponível)", kind 'fallback') e,
 *   se o provedor que falhou já tinha mostrado texto parcial, o texto é substituído (kind 'reset').
 * - SEGURANÇA: texto do usuário e do modelo entra SEMPRE por textContent / nós de texto. Nunca innerHTML.
 *   Formatação mínima (parágrafos, listas, `código`, **negrito**, blocos de código) montada com createElement.
 */
import { friendlyError } from '../utils/friendlyError.js';
import { currentContext, AI_SCREENS } from '../utils/assistantContext.js';

const STORE_KEY = 'bds.aiFab.pos';
const FAB_SIZE = 52;
const EDGE = 8;               // folga mínima até a borda da janela
const DRAG_THRESHOLD = 5;     // px: abaixo disso é clique, não arrasto
const DEFAULT_POS = { right: 24, bottom: 84 };
const PANEL_W = 380;
const PANEL_H = 520;
const PANEL_MIN_H = 240;
const KEY_STEP = 16;

let root = null;
let fab = null;
let panel = null;
let list = null;
let input = null;
let sendBtn = null;
let clearBtn = null;
let closeBtn = null;
let providerEl = null;          // texto pequeno do cabeçalho: qual provedor de IA está em uso
let live = null;
let pos = { ...DEFAULT_POS };   // posição DESEJADA (canto inferior direito); a exibida é ajustada à janela
let isOpen = false;
let busy = false;
let activeId = null;
let pending = null;             // { userRow, bubble, text, rendered, userText }
let suppressClick = false;
let refreshSeq = 0;
let listenersBound = false;
let unsubscribers = [];
let renderTimer = null;

const bds = () => window.bds || {};

// ------------------------------------------------------------------ utilidades

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const icon = (name) => {
  const s = el('span', 'material-symbols-rounded', name);
  s.setAttribute('aria-hidden', 'true');
  return s;
};

const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

function readSavedPos() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
    if (raw && Number.isFinite(raw.right) && Number.isFinite(raw.bottom)) return { right: raw.right, bottom: raw.bottom };
  } catch (_) { /* sem armazenamento: usa o padrão */ }
  return { ...DEFAULT_POS };
}

function savePos() {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(pos)); } catch (_) { /* opcional */ }
}

/** Posição exibida: a desejada, ajustada para caber na janela atual (a desejada é preservada). */
function visiblePos() {
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  return {
    right: clamp(pos.right, EDGE, vw - FAB_SIZE - EDGE),
    bottom: clamp(pos.bottom, EDGE, vh - FAB_SIZE - EDGE)
  };
}

function applyPos() {
  if (!root) return;
  const p = visiblePos();
  root.style.setProperty('--aia-right', `${Math.round(p.right)}px`);
  root.style.setProperty('--aia-bottom', `${Math.round(p.bottom)}px`);
  if (isOpen) layoutPanel();
}

/** Painel ancorado ao botão: acima dele se couber, senão abaixo; alinhado à borda direita do botão. */
function layoutPanel() {
  if (!panel) return;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const p = visiblePos();
  const w = Math.min(PANEL_W, vw - EDGE * 2);
  const fabLeft = vw - p.right - FAB_SIZE;
  const fabTop = vh - p.bottom - FAB_SIZE;
  const above = fabTop - 12 - EDGE;
  const below = vh - (fabTop + FAB_SIZE) - 12 - EDGE;
  let h; let top;
  if (above >= PANEL_MIN_H || above >= below) {
    h = Math.min(PANEL_H, Math.max(above, PANEL_MIN_H));
    top = fabTop - 12 - h;
  } else {
    h = Math.min(PANEL_H, Math.max(below, PANEL_MIN_H));
    top = fabTop + FAB_SIZE + 12;
  }
  h = Math.min(h, vh - EDGE * 2);
  top = clamp(top, EDGE, vh - EDGE - h);
  const left = clamp(fabLeft + FAB_SIZE - w, EDGE, vw - EDGE - w);
  panel.style.width = `${Math.round(w)}px`;
  panel.style.height = `${Math.round(h)}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function announce(text) {
  if (live) live.textContent = text || '';
}

// --------------------------------------------------- formatação mínima e segura

function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok[0] === '`') frag.append(el('code', '', tok.slice(1, -1)));
    else frag.append(el('strong', '', tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/**
 * Texto de uma resposta que ainda está CHEGANDO (streaming): marcas de formatação ainda não fechadas (**, `, ```)
 * não podem aparecer cruas. Só a última linha pode ter marca aberta (as marcas inline não atravessam linhas): tira
 * o marcador solto e deixa o texto; quando a marca fecha, o próximo quadro já a desenha formatada.
 */
export function partialSafe(text) {
  let t = String(text ?? '');
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 === 1) return t.replace(/(?<!`)`{1,2}$/, ''); // dentro de um bloco de código: só o início de um ``` de fechamento
  t = t.replace(/(?<!`)`{1,2}$/, (m) => (m.length === 2 ? '' : m)); // "``" no fim: início de um bloco de código
  const cut = t.lastIndexOf('\n') + 1;
  let head = t.slice(0, cut);
  let line = t.slice(cut);
  if (/(?<!\*)\*$/.test(line) && !/^\s*\*$/.test(line)) line = line.slice(0, -1);              // "*" solto no fim (início de "**")
  if (((line.replace(/```/g, '').match(/`/g)) || []).length % 2 === 1) {                       // `código` aberto
    const i = line.lastIndexOf('`');
    line = line.slice(0, i) + line.slice(i + 1);
  }
  if (((line.match(/\*\*/g)) || []).length % 2 === 1) {                                       // **negrito** aberto
    const i = line.lastIndexOf('**');
    line = line.slice(0, i) + line.slice(i + 2);
  }
  return head + line;
}

/** Desenha `text` em `target` com markdown mínimo, sem HTML cru (só nós de texto e elementos criados aqui). */
export function renderRichText(target, text) {
  target.textContent = '';
  String(text ?? '').split('```').forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = el('pre', 'aia-code');
      const body = part.includes('\n') ? part.replace(/^[^\n]*\n/, '') : part;
      pre.append(el('code', '', body.replace(/\n$/, '')));
      target.append(pre);
      return;
    }
    part.split(/\n{2,}/).forEach((block) => {
      if (!block.trim()) return;
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        const ul = el('ul', 'aia-list');
        lines.forEach((l) => { const li = el('li'); li.append(inlineNodes(l.replace(/^\s*[-*•]\s+/, ''))); ul.append(li); });
        target.append(ul);
      } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const ol = el('ol', 'aia-list');
        lines.forEach((l) => { const li = el('li'); li.append(inlineNodes(l.replace(/^\s*\d+[.)]\s+/, ''))); ol.append(li); });
        target.append(ol);
      } else {
        const p = el('p', 'aia-p');
        lines.forEach((l, n) => {
          if (n > 0) p.append(el('br'));
          const heading = /^#{1,6}\s+(.*)$/.exec(l);
          if (heading) p.append(el('strong', '', heading[1]));
          else p.append(inlineNodes(l));
        });
        target.append(p);
      }
    });
  });
}

// --------------------------------------------------------------------- mensagens

/** Exemplos de pedidos do estado vazio: texto simples (não são botões). */
export const EMPTY_EXAMPLES = Object.freeze([
  'Quais vídeos de aula eu tenho?',
  'Converta o que está selecionado para MP3.',
  'O que tem neste projeto?'
]);

function showEmpty() {
  if (!list || list.children.length) return;
  const empty = el('div', 'aia-empty');
  const examples = el('ul', 'aia-examples');
  examples.setAttribute('aria-label', 'Exemplos de pedidos');
  EMPTY_EXAMPLES.forEach((text) => examples.append(el('li', '', `“${text}”`)));
  empty.append(icon('forum'), el('strong', '', 'Como posso ajudar?'),
    el('span', '', 'Pergunte sobre suas mídias e projetos ou peça uma tarefa. Antes de mudar algo, o app sempre pede a sua confirmação. Por exemplo:'),
    examples);
  list.append(empty);
}

function addMessage(role, text, extraClass = '') {
  list.querySelector('.aia-empty')?.remove();
  const row = el('div', `aia-msg aia-msg-${role}${extraClass ? ` ${extraClass}` : ''}`);
  const bubble = el('div', 'aia-bubble');
  if (role === 'assistant' && !extraClass.includes('aia-msg-error')) renderRichText(bubble, text);
  else bubble.textContent = text; // usuário e erros: texto puro
  row.append(bubble);
  list.append(row);
  list.scrollTop = list.scrollHeight;
  return { row, bubble };
}

function renderHistory(messages) {
  list.textContent = '';
  (messages || []).forEach((m) => addMessage(m.role === 'user' ? 'user' : 'assistant', m.content));
  showEmpty();
}

function setBusy(value) {
  busy = value;
  list.setAttribute('aria-busy', String(value));
  input.disabled = false; // continua dando para digitar a próxima mensagem
  sendBtn.setAttribute('aria-label', value ? 'Parar resposta' : 'Enviar');
  sendBtn.title = value ? 'Parar resposta' : 'Enviar (Enter)';
  sendBtn.classList.toggle('aia-stop', value);
  sendBtn.textContent = '';
  sendBtn.append(icon(value ? 'stop' : 'send'));
  if (!value) {
    activeId = null;
    pending = null;
  }
}

/** Atualiza a bolha da resposta em andamento (no máximo uma vez por quadro enquanto os pedaços chegam). */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = window.requestAnimationFrame(() => {
    renderTimer = null;
    paintPending();
  });
}

function paintPending() {
  if (!pending) return;
  if (pending.text) {
    pending.bubble.parentElement.classList.remove('aia-msg-pending');
    clearStatus(); // chegou texto: a linha de status já cumpriu o papel
    renderRichText(pending.bubble, partialSafe(pending.text));
    list.scrollTop = list.scrollHeight;
  }
}

/** Remove a linha de status da resposta em andamento e volta a mostrar a bolha. */
function clearStatus() {
  if (!pending) return;
  if (pending.statusRow) { pending.statusRow.remove(); pending.statusRow = null; }
  if (pending.bubble && pending.bubble.parentElement) pending.bubble.parentElement.hidden = false;
}

/** Linha de status discreta (textContent) logo abaixo da resposta; sem texto ainda, ela substitui o "Pensando…". */
function onStatus(payload) {
  if (!busy || !pending || !payload) return;
  if (activeId && payload.id !== activeId) return;
  activeId = activeId || payload.id;
  const text = String(payload.text || '').trim();
  if (payload.kind === 'provider') { setProviderName(text); return; }
  if (payload.kind === 'reset') {
    // O provedor que falhou no meio da resposta tinha entregue texto parcial: o que fica na tela é só `payload.text`
    if (renderTimer) { window.cancelAnimationFrame(renderTimer); renderTimer = null; }
    pending.text = String(payload.text || '');
    const row = pending.bubble.parentElement;
    if (pending.text.trim()) {
      renderRichText(pending.bubble, partialSafe(pending.text));
    } else {
      pending.bubble.textContent = 'Pensando…';
      row.classList.add('aia-msg-pending');
      row.hidden = false;
    }
    list.scrollTop = list.scrollHeight;
    return;
  }
  if (payload.kind === 'fallback') {
    if (!text) return;
    announce(text);
    // UMA linha por resposta: se o fallback trocar de novo (A falhou, B também, vai para C), a linha é atualizada
    const existing = pending.fallbackRows && pending.fallbackRows[0];
    if (existing) { existing.querySelector('.aia-bubble').textContent = text; return; }
    const note = addMessage('assistant', text, 'aia-msg-note aia-msg-fallback');
    pending.bubble.parentElement.before(note.row); // a troca fica registrada na conversa, antes da resposta
    pending.fallbackRows = [note.row]; // some junto se a resposta falhar de vez
    return;
  }
  if (payload.kind === 'notice') {
    if (!text) return;
    const note = addMessage('assistant', text, 'aia-msg-note');
    pending.bubble.parentElement.before(note.row); // o aviso fica na conversa, antes da resposta
    announce(text);
    return;
  }
  if (!text || payload.kind === 'clear') { clearStatus(); return; }
  if (!pending.statusRow) {
    const row = el('div', 'aia-msg aia-msg-status');
    row.append(el('div', 'aia-status'));
    pending.bubble.parentElement.after(row);
    pending.statusRow = row;
  }
  pending.statusRow.firstChild.textContent = text;
  if (!pending.text) pending.bubble.parentElement.hidden = true; // sem texto ainda: só a linha de status
  list.scrollTop = list.scrollHeight;
  announce(text);
}

function notifyFinished(message, type = 'info') {
  // Painel fechado: o usuário não vê a resposta chegar, então avisa
  if (!isOpen) {
    fab?.classList.add('aia-has-news');
    try { window.bdsToast?.(message, { type }); } catch (_) { /* aviso opcional */ }
  }
}

// ------------------------------------------- primeiro uso e aviso de privacidade (mensagens com botão)

/** Abre Configurações → Inteligência Artificial (a única navegação que o próprio painel faz). */
export function openAiSettings() {
  closePanel({ restoreFocus: false });
  document.querySelector('.sidebar .tab-button[data-view="settings"]')?.click();
  let tries = 0;
  const timer = window.setInterval(() => {
    const tab = document.querySelector('.settings-tab[data-tab="settingsAiView"]');
    if (tab && !tab.classList.contains('st-devhidden')) { window.clearInterval(timer); tab.click(); return; }
    if (++tries > 30) window.clearInterval(timer); // a tela de Configurações não abriu: desiste sem barulho
  }, 100);
}

const GUIDES = {
  AI_NOT_CONFIGURED: {
    text: 'Ainda não há um servidor de IA configurado. Escolha um nas configurações da IA (pode ser um servidor no seu computador, como o LM Studio, ou a OpenAI) e volte aqui.',
    button: 'Abrir configurações da IA'
  },
  AI_UNREACHABLE: {
    text: 'Não consegui falar com o servidor de IA. Confira nas configurações se ele está ligado e se o endereço está certo.',
    button: 'Abrir configurações da IA'
  },
  TIMEOUT: {
    text: 'O servidor de IA demorou demais para responder. Confira nas configurações se ele está ligado e se o modelo escolhido está carregado.',
    button: 'Abrir configurações da IA'
  },
  // Todos os provedores falharam (ou os que sobraram não têm chave/aviso aceito): o main manda a mensagem pronta
  AI_ALL_FAILED: {
    text: 'Não consegui falar com nenhum servidor de IA agora. Confira as configurações da IA.',
    button: 'Abrir configurações da IA'
  },
  AI_REMOTE_CONSENT: { text: '', button: 'Entendi, continuar' }
};

/** Mensagem do assistente com UM botão dentro dela (única exceção à regra "o painel mostra só o chat"). */
function showGuide(code, serverText, userText) {
  const guide = GUIDES[code];
  const body = code === 'AI_REMOTE_CONSENT'
    ? (serverText || 'Antes de começar: o que você escrever aqui e o que eu consultar na sua biblioteca será enviado ao servidor de IA escolhido.')
    : (code === 'AI_ALL_FAILED' && serverText ? serverText : guide.text);
  const { row, bubble } = addMessage('assistant', body, 'aia-msg-note aia-msg-guide');
  const btn = el('button', 'aia-action-btn', guide.button);
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    if (code === 'AI_REMOTE_CONSENT') {
      btn.disabled = true;
      try {
        const r = await bds().aiSaveConfig?.({ acceptRemoteServer: true });
        if (r && r.ok === false) throw new Error(r.error || 'Não foi possível guardar a escolha.');
      } catch (err) {
        btn.disabled = false;
        addMessage('assistant', `Não foi possível guardar a sua escolha. ${friendlyError(err, 'Tente novamente.')}`, 'aia-msg-error');
        return;
      }
      btn.remove();
      if (userText && !busy) { input.value = userText; send(); }
      return;
    }
    openAiSettings();
  });
  bubble.append(btn);
  list.scrollTop = list.scrollHeight;
  announce(bubble.textContent);
  return row;
}

/** Falha da resposta: tira a pergunta sem resposta da tela (o texto volta ao campo) e mostra um erro amigável. */
function failPending(err, code) {
  const info = pending;
  pending = null;
  if (renderTimer) { window.cancelAnimationFrame(renderTimer); renderTimer = null; }
  if (info) {
    info.userRow.remove();
    info.bubble.parentElement.remove();
    if (info.statusRow) info.statusRow.remove();
    (info.fallbackRows || []).forEach((row) => row.remove());
    if (!input.value && code !== 'AI_REMOTE_CONSENT') input.value = info.userText;
  }
  if (GUIDES[code]) {
    // Primeiro uso sem servidor, servidor que não responde ou aviso de privacidade: mensagem curta + um botão
    showGuide(code, typeof err === 'string' ? err : (err && err.message) || '', info ? info.userText : '');
    notifyFinished(GUIDES[code].text || 'O assistente precisa da sua escolha.', 'error');
    setBusy(false);
    refreshProvider(); // o cabeçalho volta a mostrar quem responderia agora (ou some, se nenhum)
    return;
  }
  const friendly = friendlyError(err, code === 'AI_DISABLED' ? 'O assistente está desligado.' : 'Tente novamente.');
  const message = code === 'AI_DISABLED' || /^Não foi possível/i.test(friendly) ? friendly : `Não foi possível responder. ${friendly}`;
  addMessage('assistant', message, 'aia-msg-error');
  announce(message);
  notifyFinished(message, 'error');
  setBusy(false);
  if (code === 'AI_DISABLED') refresh();
  else refreshProvider();
}

function onDelta(payload) {
  if (!busy || !pending || !payload) return;
  if (activeId && payload.id !== activeId) return;
  activeId = activeId || payload.id;
  pending.text += String(payload.text || '');
  scheduleRender();
}

function onDone(payload) {
  if (!busy || !pending || !payload) return;
  if (activeId && payload.id !== activeId) return;
  if (renderTimer) { window.cancelAnimationFrame(renderTimer); renderTimer = null; }
  const text = String(payload.text || '');
  if (payload.cancelled && !text.trim()) {
    // Parou antes de chegar qualquer texto: nada foi guardado, a pergunta volta ao campo
    const info = pending;
    info.userRow.remove();
    info.bubble.parentElement.remove();
    if (info.statusRow) info.statusRow.remove();
    (info.fallbackRows || []).forEach((row) => row.remove());
    if (!input.value) input.value = info.userText;
    setBusy(false);
    showEmpty();
    announce('Resposta interrompida.');
    return;
  }
  pending.bubble.parentElement.classList.remove('aia-msg-pending');
  clearStatus();
  let finalText = text;
  if (payload.cancelled) finalText = `${text}\n\n(resposta interrompida)`;
  else if (payload.finishReason === 'length') finalText = `${text}\n\n(resposta cortada pelo limite de tamanho; aumente-o nas configurações da IA)`;
  renderRichText(pending.bubble, finalText);
  list.scrollTop = list.scrollHeight;
  announce('O assistente respondeu.');
  notifyFinished('O assistente terminou de responder.');
  setBusy(false);
  if (isOpen) input.focus();
}

function onError(payload) {
  if (!busy || !payload) return;
  if (activeId && payload.id !== activeId) return;
  failPending(payload.error || 'Falha desconhecida.', payload.code);
}

async function send() {
  if (busy) { stop(); return; }
  const text = input.value.trim();
  if (!text) return;
  if (typeof bds().aiChatStart !== 'function') {
    addMessage('assistant', 'O assistente não está disponível nesta versão do app.', 'aia-msg-error');
    return;
  }
  input.value = '';
  const user = addMessage('user', text);
  const answer = addMessage('assistant', 'Pensando…', 'aia-msg-pending');
  pending = { userRow: user.row, bubble: answer.bubble, text: '', userText: text };
  setBusy(true);
  announce('O assistente está respondendo.');
  try {
    // A cada mensagem vai o contexto da tela (tela, ids selecionados, projeto): o main revalida e trata como dado
    const r = await bds().aiChatStart(text, currentContext());
    if (!r || !r.ok) throw Object.assign(new Error(r?.error || 'O assistente não respondeu.'), { code: r?.code });
    if (busy && pending) activeId = activeId || r.data.id;
  } catch (err) {
    if (busy && pending) failPending(err, err && err.code);
  }
}

function stop() {
  if (!busy) return;
  try { Promise.resolve(bds().aiChatCancel?.(activeId || undefined)).catch(() => {}); } catch (_) { /* o fim chega pelo evento */ }
}

async function clearChat() {
  const hasMessages = list.querySelector('.aia-msg');
  if (hasMessages && window.bdsModal && typeof window.bdsModal.confirm === 'function') {
    const ok = await window.bdsModal.confirm('Apagar toda a conversa com o assistente? Isso também apaga o histórico guardado neste computador.');
    if (!ok) return;
  }
  try {
    const r = await bds().aiHistoryClear?.();
    if (r && r.ok === false) throw new Error(r.error || 'Não foi possível apagar.');
  } catch (err) {
    addMessage('assistant', `Não foi possível limpar a conversa. ${friendlyError(err, 'Tente novamente.')}`, 'aia-msg-error');
    return;
  }
  pending = null;
  activeId = null;
  if (renderTimer) { window.cancelAnimationFrame(renderTimer); renderTimer = null; }
  setBusy(false);
  list.textContent = '';
  showEmpty();
  announce('Conversa apagada.');
  input.focus();
}

/** Nome do provedor em uso, em texto pequeno no cabeçalho (vazio: esconde). */
function setProviderName(name) {
  if (!providerEl) return;
  const text = String(name || '').trim();
  providerEl.textContent = text;
  providerEl.title = text ? `Provedor de IA em uso: ${text}` : '';
  providerEl.hidden = !text;
}

/** Pergunta ao main qual provedor responderia agora (o primeiro disponível da ordem) e mostra no cabeçalho. */
async function refreshProvider() {
  try {
    const r = await bds().aiGetConfig?.();
    const active = r && r.ok && r.data ? r.data.activeProvider : null;
    setProviderName(active && active.label ? active.label : '');
  } catch (_) { /* o nome é só um detalhe */ }
}

async function loadHistory() {
  try {
    const r = await bds().aiHistoryGet?.();
    if (r && r.ok && r.data) renderHistory(r.data.messages);
    else showEmpty();
  } catch (_) { showEmpty(); }
}

// ----------------------------------------------------------------------- painel

function openPanel() {
  if (!panel || isOpen) return;
  isOpen = true;
  panel.removeAttribute('hidden');
  fab.setAttribute('aria-expanded', 'true');
  fab.classList.remove('aia-has-news');
  layoutPanel();
  list.scrollTop = list.scrollHeight;
  input.focus();
  refreshProvider();
}

function closePanel({ restoreFocus = true } = {}) {
  if (!panel || !isOpen) return;
  isOpen = false;
  panel.setAttribute('hidden', '');
  fab.setAttribute('aria-expanded', 'false');
  if (restoreFocus) fab.focus();
}

function togglePanel() {
  if (isOpen) closePanel(); else openPanel();
}

// ------------------------------------------------------------------ arrastar o botão

function bindDrag() {
  let drag = null;
  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const p = visiblePos();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, right: p.right, bottom: p.bottom, moved: false };
    try { fab.setPointerCapture?.(e.pointerId); } catch (_) { /* sem captura: continua pelo documento */ }
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag || (drag.id !== undefined && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    root.classList.add('aia-dragging');
    pos = { right: drag.right - dx, bottom: drag.bottom - dy };
    pos = visiblePosOf(pos);
    applyPos();
  });
  const end = (e) => {
    if (!drag) return;
    const moved = drag.moved;
    try { fab.releasePointerCapture?.(drag.id); } catch (_) { /* já solto */ }
    drag = null;
    root.classList.remove('aia-dragging');
    if (moved) {
      savePos();
      // o "click" que o navegador dispara após um arrasto não deve abrir/fechar o painel
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    }
    if (e && e.type === 'pointercancel') suppressClick = false;
  };
  fab.addEventListener('pointerup', end);
  fab.addEventListener('pointercancel', end);
  fab.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    togglePanel();
  });
  // Teclado: Enter/Espaço abrem (botão nativo); Alt + setas movem o botão (Shift = passo maior)
  fab.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const mv = moves[e.key];
    if (!mv) return;
    e.preventDefault();
    const p = visiblePos();
    pos = visiblePosOf({ right: p.right + mv[0], bottom: p.bottom + mv[1] });
    applyPos();
    savePos();
  });
}

function visiblePosOf(p) {
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  return { right: clamp(p.right, EDGE, vw - FAB_SIZE - EDGE), bottom: clamp(p.bottom, EDGE, vh - FAB_SIZE - EDGE) };
}

// ------------------------------------------------------------------ montagem do DOM

function build() {
  root = el('div', 'aia-root');
  root.id = 'aiAssistantRoot';

  fab = el('button', 'aia-fab');
  fab.id = 'aiAssistantFab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Assistente de IA');
  fab.setAttribute('aria-haspopup', 'dialog');
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', 'aiAssistantPanel');
  fab.title = 'Assistente de IA (Ctrl + J; arraste para mover; Alt + setas também move)';
  fab.append(icon('smart_toy'));

  panel = el('section', 'aia-panel');
  panel.id = 'aiAssistantPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Assistente');
  panel.setAttribute('hidden', '');

  const head = el('header', 'aia-head');
  head.append(el('h2', 'aia-title', 'Assistente'));
  providerEl = el('span', 'aia-provider');
  providerEl.hidden = true;
  clearBtn = el('button', 'aia-icon-btn');
  clearBtn.type = 'button';
  clearBtn.setAttribute('aria-label', 'Limpar conversa');
  clearBtn.title = 'Limpar conversa';
  clearBtn.append(icon('delete_sweep'));
  closeBtn = el('button', 'aia-icon-btn');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Fechar assistente');
  closeBtn.title = 'Fechar (Esc)';
  closeBtn.append(icon('close'));
  head.append(providerEl, clearBtn, closeBtn);

  list = el('div', 'aia-messages');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  list.setAttribute('aria-relevant', 'additions');
  list.setAttribute('aria-busy', 'false');

  live = el('div', 'aia-sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  const form = el('form', 'aia-composer');
  form.autocomplete = 'off';
  input = el('textarea', 'aia-input');
  input.rows = 2;
  input.maxLength = 20000;
  input.placeholder = 'Escreva sua mensagem…';
  input.setAttribute('aria-label', 'Mensagem para o assistente');
  sendBtn = el('button', 'aia-send');
  sendBtn.type = 'submit';
  sendBtn.setAttribute('aria-label', 'Enviar');
  sendBtn.title = 'Enviar (Enter)';
  sendBtn.append(icon('send'));
  form.append(input, sendBtn);

  panel.append(head, list, live, form);
  root.append(fab, panel);

  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  clearBtn.addEventListener('click', clearChat);
  closeBtn.addEventListener('click', () => closePanel());
  // Esc fecha quando o foco está no assistente (o painel não é modal: Esc em outro lugar não é com ele)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); closePanel(); }
  });
  bindDrag();

  pos = readSavedPos();
  applyPos();
  document.body.appendChild(root);
  loadHistory();
  refreshProvider();
}

function teardown() {
  if (renderTimer) { window.cancelAnimationFrame(renderTimer); renderTimer = null; }
  if (root) root.remove();
  root = fab = panel = list = input = sendBtn = clearBtn = closeBtn = live = providerEl = null;
  isOpen = false;
  busy = false;
  activeId = null;
  pending = null;
}

// ------------------------------------------------ liberado? (módulo + interruptor)

async function isAllowed() {
  try {
    if (typeof bds().modulesList !== 'function' || typeof bds().aiGetConfig !== 'function') return false;
    // O módulo vem ligado por padrão e está liberado no app final (src/services/ai/releaseGate.js, uma decisão só, no main):
    // se o main não o listar, o assistente não existe nesta versão. Por isso não há checagem de build aqui.
    const mods = await bds().modulesList();
    const list = mods && mods.ok && Array.isArray(mods.data) ? mods.data : [];
    const mod = list.find((m) => m.id === 'ai');
    if (!mod || mod.enabled !== true) return false;
    const cfg = await bds().aiGetConfig();
    return Boolean(cfg && cfg.ok && cfg.data && cfg.data.assistantEnabled !== false);
  } catch (_) { return false; }
}

/** Cria ou remove o botão conforme o módulo e o interruptor. */
export async function refresh() {
  const seq = ++refreshSeq;
  const allowed = await isAllowed();
  if (seq !== refreshSeq) return; // uma checagem mais nova já está em andamento
  if (allowed && !root) build();
  else if (allowed && root) refreshProvider(); // provedores mudaram nas Configurações
  else if (!allowed && root) {
    if (busy) { try { Promise.resolve(bds().aiChatCancel?.()).catch(() => {}); } catch (_) { /* parou de qualquer forma */ } }
    teardown();
  }
}

// ------------------------------------------------------- navegação pedida pelo assistente

/**
 * Evento ai:navigate (main → renderer): abre uma tela. O renderer NÃO confia no evento: confere a tela contra a lista
 * fixa (a mesma do main) e se a aba existe e está visível (módulo ligado) antes de navegar.
 */
export function onNavigate(payload) {
  const id = payload && typeof payload.screen === 'string' ? payload.screen : '';
  if (!AI_SCREENS.some((s) => s.id === id)) return false;
  const btn = document.querySelector(`.sidebar .tab-button[data-view="${id}"]`);
  if (!btn || btn.classList.contains('hidden') || btn.style.display === 'none') return false;
  btn.click();
  announce(`Abrindo ${AI_SCREENS.find((s) => s.id === id).label}.`);
  return true;
}

/** Atalho global Ctrl + J: abre ou fecha o assistente (só existe com o assistente ligado). */
function onShortcut(e) {
  if (!root || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'j') return;
  e.preventDefault();
  e.stopPropagation();
  togglePanel();
}

function bindGlobal() {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener('keydown', onShortcut, true);
  window.addEventListener('bds:modules-changed', () => { refresh(); });
  window.addEventListener('bds:ai-assistant-changed', () => { refresh(); });
  window.addEventListener('resize', () => { if (root) applyPos(); });
  const on = (name, fn) => { if (typeof bds()[name] === 'function') unsubscribers.push(bds()[name](fn)); };
  on('onAiChatDelta', onDelta);
  on('onAiChatDone', onDone);
  on('onAiChatError', onError);
  on('onAiChatStatus', onStatus);
  on('onAiNavigate', onNavigate);
}

/** Liga o assistente ao app (idempotente). Chamado por app.js na inicialização. */
export async function mountAssistant() {
  bindGlobal();
  await refresh();
}

/** Remove o botão e os ouvintes de eventos do main (usado em testes). */
export function unmountAssistant() {
  refreshSeq++;
  teardown();
  unsubscribers.forEach((off) => { try { if (typeof off === 'function') off(); } catch (_) { /* já solto */ } });
  unsubscribers = [];
  window.removeEventListener('keydown', onShortcut, true);
  listenersBound = false;
}
