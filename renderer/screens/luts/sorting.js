// Busca e ordem da lista de LUTs: funções puras (sem DOM), para a tela e os testes usarem as mesmas regras.
//   - busca sem acento nem diferença de maiúsculas, no nome do arquivo e no nome da pasta;
//   - ordem natural ("Look 2" antes de "Look 10"), em pt-BR;
//   - seis ordens: mais recentes, mais antigas, nome (A a Z), nome (Z a A), maior e menor tamanho.

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Texto para comparar na busca: sem acentos (NFD), sem diferença de caixa e sem espaços nas pontas. */
export function foldText(text) {
    return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** A LUT casa com a busca? Procura o texto (já sem acento) no nome do arquivo (com a extensão, como a pessoa o vê) e no caminho da pasta. Busca vazia casa tudo. */
export function matchesQuery(lut, foldedQuery) {
    if (!foldedQuery) return true;
    return foldText(lut.name).includes(foldedQuery) || foldText(lut.folder).includes(foldedQuery);
}

/** Ordem natural pelo nome (sem a extensão); o caminho desempata. */
export function compareNames(a, b) {
    return collator.compare(a.displayName || a.name || '', b.displayName || b.name || '') || collator.compare(a.relPath || a.name || '', b.relPath || b.name || '');
}

const COMPARATORS = {
    recent: (a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0),
    oldest: (a, b) => (a.modifiedAt || 0) - (b.modifiedAt || 0),
    name: (a, b) => compareNames(a, b),
    'name-desc': (a, b) => compareNames(b, a),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    'size-asc': (a, b) => (a.size || 0) - (b.size || 0)
};

/** Valores aceitos de ordenação (os mesmos do seletor da tela). */
export const SORT_KEYS = Object.keys(COMPARATORS);

/** Ordena a lista (no lugar) e a devolve. Ordem desconhecida vale "mais recentes". Empate: nome em ordem natural. */
export function sortLuts(list, sort) {
    const primary = COMPARATORS[sort] || COMPARATORS.recent;
    return list.sort((a, b) => primary(a, b) || compareNames(a, b));
}
