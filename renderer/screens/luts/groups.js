// Grupos (pastas) da tela de LUTs: ordem natural, agrupamento e o estado "recolhido", que fica no navegador.
// Funções puras (sem DOM), para a tela e os testes usarem as mesmas regras.

export const NO_FOLDER_LABEL = 'Sem pasta';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const COLLAPSED_KEY = 'bds.luts.collapsedFolders';

/** "A/B" vira "A / B"; a raiz da coleção (vazio) vira "Sem pasta". */
export function folderLabel(folder) {
    return folder ? folder.split('/').join(' / ') : NO_FOLDER_LABEL;
}

/** Ordem natural por nível ("Look 2" antes de "Look 10"); a raiz vem primeiro e uma pasta antes das suas subpastas. */
export function compareFolders(a, b) {
    const sa = a ? a.split('/') : [];
    const sb = b ? b.split('/') : [];
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
        const c = collator.compare(sa[i], sb[i]);
        if (c !== 0) return c;
    }
    return sa.length - sb.length;
}

/** Existe alguma LUT fora da raiz da coleção? (só então a grade mostra grupos) */
export function hasSubfolders(luts) {
    return luts.some((lut) => !!lut.folder);
}

/**
 * Agrupa as LUTs pela pasta, na ordem natural das pastas. Dentro de cada grupo a ordem recebida é mantida (é a ordem
 * escolhida no seletor).
 * @param {Array<{ folder?: string }>} luts
 * @returns {Array<{ folder: string, label: string, luts: Array<object> }>}
 */
export function groupLuts(luts) {
    const byFolder = new Map();
    for (const lut of luts) {
        const folder = lut.folder || '';
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(lut);
    }
    return [...byFolder.keys()].sort(compareFolders).map((folder) => ({ folder, label: folderLabel(folder), luts: byFolder.get(folder) }));
}

/** Pastas que a pessoa recolheu (lembradas entre aberturas; sem armazenamento, nada é lembrado). */
export function loadCollapsed() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) || '[]');
        return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string' && v.length < 1024).slice(0, 2000) : []);
    } catch (_) {
        return new Set();
    }
}

export function saveCollapsed(set) {
    try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set].slice(0, 2000)));
    } catch (_) { /* sem armazenamento: o estado só vale nesta abertura */ }
}

/** Depois de renomear uma pasta: o estado "recolhida" dela (e das subpastas) acompanha o novo caminho. */
export function remapCollapsed(set, oldFolder, newFolder) {
    for (const folder of [...set]) {
        if (folder === oldFolder) { set.delete(folder); set.add(newFolder); }
        else if (folder.startsWith(`${oldFolder}/`)) { set.delete(folder); set.add(`${newFolder}${folder.slice(oldFolder.length)}`); }
    }
}

/** "1 LUT" / "5 LUTs". */
export function countLuts(n) {
    return `${n} LUT${n === 1 ? '' : 's'}`;
}
