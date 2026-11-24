/**
 * Seções "Imagem" e "Vídeo" do card Provedores (Configurações → Inteligência Artificial → Provedores).
 *   Imagem: hoje só existe o modelo local do app que entende imagens (usado para organizar fotos ao copiar de
 *           dispositivos). A linha é só de leitura: mostra o que está disponível agora, ou como conseguir um.
 *   Vídeo:  ainda não há nada no app; a linha diz isso.
 * Quando houver mais de uma opção, elas entram aqui como as linhas ordenáveis de Chat e Áudio.
 * Textos entram sempre por textContent.
 */

const TTL_MS = 15000;
let cache = null; // { at, promise }

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
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

/** Estado do modelo local do app (a leitura da placa de vídeo custa: guarda o resultado por alguns segundos). */
function localState() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = (async () => {
    try {
      const res = await window.bds?.aiLocalLlmStatus?.();
      return res && res.ok ? res.data : null;
    } catch (_) { return null; }
  })();
  cache = { at: Date.now(), promise };
  return promise;
}

const openLocal = () => window.dispatchEvent(new CustomEvent('bds:ai-open-sub', { detail: 'local' }));

const row = (iconName, title, hint, action) => h('div', { class: 'med-row' }, [
  h('span', { class: 'med-icon' }, [icon(iconName)]),
  h('div', { class: 'med-text' }, [h('strong', { text: title }), h('span', { class: 'mod-hint', text: hint })]),
  action || null
]);

/** O que mostrar na linha de Imagem, a partir do estado do modelo local. */
export function describeImage(st) {
  if (!st || st.supported === false) {
    return { ok: false, title: 'Nenhum disponível', hint: 'O modelo local que entende imagens ainda não está disponível neste sistema.', action: false };
  }
  if (st.installed && st.vision) {
    return { ok: true, title: `Modelo local do app · ${st.modelLabel}`, hint: 'Entende fotos. Usado para sugerir a organização das fotos ao copiar de dispositivos.', action: false };
  }
  const other = Array.isArray(st.models) ? st.models.find((m) => m.vision && m.installed) : null;
  if (other) {
    return { ok: false, title: 'Instalado, mas não é o modelo em uso', hint: `O modelo em uso não entende imagens. Escolha ${other.label} em "Neste computador".`, action: true };
  }
  return { ok: false, title: 'Nenhum disponível', hint: 'Instale em "Neste computador" um modelo local que entende imagens.', action: true };
}

/**
 * @param {{ image: HTMLElement|null, video: HTMLElement|null }} hosts
 */
export async function renderMediaSections({ image = null, video = null } = {}) {
  if (video) {
    clear(video).append(row('movie', 'Ainda não disponível', 'Nada no app entende vídeo por enquanto. Quando houver, aparece aqui.'));
    video.classList.add('med-off');
  }
  if (!image) return;
  clear(image).append(row('image', 'Verificando…', ''));
  const d = describeImage(await localState());
  clear(image).append(row(
    d.ok ? 'image' : 'hide_image', d.title, d.hint,
    d.action ? h('button', { class: 'mod-btn mod-btn-secondary mod-btn-sm', type: 'button', onclick: openLocal }, [icon('tune'), 'Abrir']) : null
  ));
}

/** Esquece o estado guardado (use depois de instalar ou trocar o modelo local). */
export function resetMediaSections() { cache = null; }

// Instalar, remover ou trocar o modelo local avisa por este evento: a próxima leitura é nova
try { window.addEventListener('bds:ai-assistant-changed', resetMediaSections); } catch (_) { /* sem janela (testes de módulo) */ }
