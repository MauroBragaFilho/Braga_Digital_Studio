/**
 * Seções "Imagem" e "Vídeo" do card Provedores (Configurações → Inteligência Artificial → Provedores).
 *   Imagem: hoje só existe o modelo local do app que entende imagens (usado para organizar fotos ao copiar de
 *           dispositivos). A linha é só de leitura: mostra o que está disponível agora, ou como conseguir um.
 *           Abaixo, por provedor, quantos modelos do catálogo também entendem imagens (ainda sem uso).
 *   Vídeo:  o app ainda não usa vídeo; a seção só existe se algum catálogo de provedor tiver modelos de vídeo.
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

/** Catálogo de modelos por provedor, vindo de aiGetConfig: [{ label, count }] dos que têm o tipo pedido (cap 'image' | 'video'). */
async function catalogWith(cap) {
  try {
    const res = await window.bds?.aiGetConfig?.();
    const list = res && res.ok && res.data && Array.isArray(res.data.providers) ? res.data.providers : [];
    return list
      .map((p) => ({ label: String(p.label || ''), count: p.modelCounts ? Number(p.modelCounts[cap]) || 0 : 0 }))
      .filter((p) => p.count > 0);
  } catch (_) { return []; }
}

const models = (n) => `${n} ${n === 1 ? 'modelo' : 'modelos'}`;

/**
 * Imagem: a linha do modelo local e, por provedor, quantos modelos do catálogo também entendem imagens (só informação).
 * Vídeo: a seção INTEIRA (o contêiner .ana-sec) só aparece se algum catálogo tiver vídeo; é uma lista só de leitura.
 * @param {{ image: HTMLElement|null, video: HTMLElement|null }} hosts
 */
export async function renderMediaSections({ image = null, video = null } = {}) {
  if (image) clear(image).append(row('image', 'Verificando…', ''));
  const [withVideo, withImage, state] = await Promise.all([
    video ? catalogWith('video') : [],
    image ? catalogWith('image') : [],
    image ? localState() : null
  ]);
  if (video) {
    const wrapper = video.closest ? video.closest('.ana-sec') : null;
    if (wrapper) wrapper.hidden = withVideo.length === 0;
    clear(video);
    if (withVideo.length) {
      video.append(row('movie', 'O app ainda não usa vídeo.', 'Modelos de vídeo encontrados nos seus provedores (só informação).'));
      video.append(...withVideo.map((p) => h('p', { class: 'mod-hint med-catalog', text: `${p.label}: ${models(p.count)} de vídeo.` })));
      video.classList.add('med-off');
    }
  }
  if (!image) return;
  const d = describeImage(state);
  clear(image).append(row(
    d.ok ? 'image' : 'hide_image', d.title, d.hint,
    d.action ? h('button', { class: 'mod-btn mod-btn-secondary mod-btn-sm', type: 'button', onclick: openLocal }, [icon('tune'), 'Abrir']) : null
  ));
  image.append(...withImage.map((p) => h('p', { class: 'mod-hint med-catalog', text: `Também entendem imagens: ${models(p.count)} em ${p.label} (uso em breve).` })));
}

/** Esquece o estado guardado (use depois de instalar ou trocar o modelo local). */
export function resetMediaSections() { cache = null; }

// Instalar, remover ou trocar o modelo local avisa por este evento: a próxima leitura é nova
try { window.addEventListener('bds:ai-assistant-changed', resetMediaSections); } catch (_) { /* sem janela (testes de módulo) */ }
