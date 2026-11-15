import { escapeHtml } from '../utils/escape.js';

/**
 * Diálogo "Como organizar?" da importação de dispositivos (celular, câmera, USB).
 * Mostra, ANTES de copiar, o plano de pastas (e de nomes) que o app montou; o usuário ajusta e confirma.
 * As regras (data e tipo) funcionam sempre; as sugestões de assunto e nome vêm do sistema local e são opcionais.
 *
 * askOrganize(items, opts) devolve uma promessa:
 *   null                                  → o usuário cancelou (nada é copiado)
 *   { skip: true }                        → copiar sem organizar (tudo na pasta de destino, como antes)
 *   { groups, renames, projectId }        → o plano confirmado (groups: [{ folder, keys }], renames: { chave: novoNome })
 */

const PREFS_KEY = 'bds.organize.v1';
const STRUCTURES = [
  ['data-tipo', 'Por data e tipo (2026-11-14 / Fotos)'],
  ['tipo-data', 'Por tipo e data (Fotos / 2026-11-14)'],
  ['tipo', 'Só por tipo (Fotos, Vídeos...)'],
  ['plana', 'Tudo na mesma pasta']
];

function loadPrefs() {
  const base = { structure: 'data-tipo', rename: false };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { structure: STRUCTURES.some(([id]) => id === saved.structure) ? saved.structure : base.structure, rename: saved.rename === true };
  } catch (_) { return base; }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* sem armazenamento: só não lembra */ }
}

/**
 * @param {Array<{key:string, name:string, size?:number, date?:string}>} items
 * @param {{ thumbsFor?: (items:Array)=>Promise<Record<string,string>>, projectName?: (id:number)=>string, allowProject?: boolean }} [opts]
 */
export function askOrganize(items, opts = {}) {
  const names = new Map(items.map((i) => [i.key, i.name]));
  const prefs = loadPrefs();
  let aiMode = false;     // o usuário pediu as sugestões do sistema local
  let thumbs = null;      // miniaturas (só onde o dispositivo entrega)
  let plan = null;
  let seq = 0;

  const overlay = document.createElement('div');
  overlay.className = 'devices-modal-overlay active org-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Como organizar os arquivos');
  overlay.innerHTML = `
    <div class="devices-modal org-modal">
      <div class="devices-modal-header">
        <h2 class="devices-modal-title"><span class="material-symbols-rounded" aria-hidden="true">folder_managed</span> Como organizar?</h2>
        <button class="devices-modal-close-btn" type="button" data-act="cancel" title="Cancelar" aria-label="Cancelar"><span class="material-symbols-rounded">close</span></button>
      </div>
      <div class="devices-modal-body org-body">
        <label class="org-field"><span>Pastas</span>
          <select data-el="struct">${STRUCTURES.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('')}</select>
        </label>
        <label class="org-check"><input type="checkbox" data-el="rename"> <span>Renomear arquivos genéricos (IMG_0001, VID_0002...) pela data e hora</span></label>
        <div class="org-ai" data-el="aiRow" hidden>
          <button class="devices-btn-secondary" type="button" data-act="ai">Sugerir assuntos e nomes</button>
          <span class="org-note" data-el="aiNote"></span>
        </div>
        <label class="org-check" data-el="projRow" hidden><input type="checkbox" data-el="proj" checked> <span data-el="projText"></span></label>
        <div class="org-preview" data-el="preview" aria-live="polite"></div>
      </div>
      <div class="devices-modal-footer org-footer">
        <button class="devices-btn-secondary" type="button" data-act="skip">Copiar sem organizar</button>
        <button class="devices-btn-primary-orange" type="button" data-act="go" disabled><span class="material-symbols-rounded" aria-hidden="true">download</span> Importar</button>
      </div>
    </div>`;
  const el = (name) => overlay.querySelector(`[data-el="${name}"]`);
  const act = (name) => overlay.querySelector(`[data-act="${name}"]`);
  el('struct').value = prefs.structure;
  el('rename').checked = prefs.rename;
  document.body.appendChild(overlay);

  return new Promise((resolve) => {
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', onKey, true);

    const renderPreview = () => {
      const box = el('preview');
      if (!plan || !plan.groups.length) { box.textContent = ''; return; }
      const rows = plan.groups.map((g) => {
        const sample = g.keys.slice(0, 3).map((k) => {
          const novo = plan.renames && plan.renames[k];
          return novo ? `${escapeHtml(names.get(k) || k)} → ${escapeHtml(novo)}` : escapeHtml(names.get(k) || k);
        }).join(', ');
        const more = g.keys.length > 3 ? ` e mais ${g.keys.length - 3}` : '';
        return `<li><span class="org-folder"><span class="material-symbols-rounded" aria-hidden="true">folder</span>${escapeHtml(g.folder || '(pasta de destino)')}</span> <span class="org-count">${g.keys.length}</span><div class="org-sample">${sample}${more}</div></li>`;
      }).join('');
      box.innerHTML = `<ul class="org-list">${rows}</ul>`;
    };

    const recompute = async () => {
      const mine = ++seq;
      act('go').disabled = true;
      el('preview').textContent = aiMode ? 'Carregando sistema local…' : 'Montando o plano…';
      try {
        if (aiMode && thumbs === null) {
          thumbs = {};
          if (typeof opts.thumbsFor === 'function') { try { thumbs = (await opts.thumbsFor(items)) || {}; } catch (_) { thumbs = {}; } }
        }
        const result = await window.bds.organizerPlan({
          items, thumbs: aiMode ? thumbs : undefined,
          structure: el('struct').value,
          rename: aiMode ? 'ia' : (el('rename').checked ? 'data' : 'nenhum'),
          useAi: aiMode
        });
        if (mine !== seq) return;
        plan = result;
        el('aiNote').textContent = result.aiNote || (result.usedAi ? (result.vision ? 'Sugestões a partir das imagens e dos nomes.' : 'Sugestões a partir dos nomes.') : '');
        const pid = opts.allowProject && result.projectId && typeof opts.projectName === 'function' ? result.projectId : null;
        el('projRow').hidden = !pid;
        if (pid) el('projText').textContent = `Ligar ao projeto "${opts.projectName(pid) || pid}" (sugerido)`;
        renderPreview();
        act('go').disabled = false;
      } catch (err) {
        if (mine !== seq) return;
        el('preview').textContent = 'Não foi possível montar o plano agora. Você pode copiar sem organizar.';
        console.error('[DEVICES] organizerPlan:', err);
      }
    };

    el('struct').addEventListener('change', () => { savePrefs({ structure: el('struct').value, rename: el('rename').checked }); recompute(); });
    el('rename').addEventListener('change', () => { savePrefs({ structure: el('struct').value, rename: el('rename').checked }); if (!aiMode) recompute(); });
    act('ai').addEventListener('click', () => { aiMode = true; act('ai').disabled = true; recompute().finally(() => { act('ai').disabled = false; }); });
    act('cancel').addEventListener('click', () => finish(null));
    act('skip').addEventListener('click', () => finish({ skip: true }));
    act('go').addEventListener('click', () => {
      if (!plan) return;
      const link = !el('projRow').hidden && el('proj').checked;
      finish({ groups: plan.groups, renames: plan.renames || {}, projectId: link ? plan.projectId : null });
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });

    // Só oferece as sugestões se o sistema local estiver instalado
    Promise.resolve(window.bds.organizerStatus?.()).then((st) => { if (st && st.aiAvailable) el('aiRow').hidden = false; }).catch(() => {});
    recompute();
    const first = el('struct'); if (first) first.focus();
  });
}
