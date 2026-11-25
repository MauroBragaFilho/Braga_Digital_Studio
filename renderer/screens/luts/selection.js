// Seleção múltipla da tela de LUTs: o conjunto marcado, a âncora do Shift e as regras de intervalo e de resumo.
// Sem DOM, para a tela e os testes usarem as mesmas regras. A chave de cada LUT é o caminho (path) que a lista traz.

/**
 * Os caminhos entre `from` e `to` (inclusive, em qualquer sentido) na ordem `ordered` (a ordem que a pessoa vê).
 * Devolve null se um dos dois não está na lista (por exemplo, escondido pelo filtro ou num grupo recolhido).
 * @param {string[]} ordered
 * @param {string} from
 * @param {string} to
 * @returns {string[] | null}
 */
export function rangePaths(ordered, from, to) {
    const a = ordered.indexOf(from);
    const b = ordered.indexOf(to);
    if (a < 0 || b < 0) return null;
    return ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * Resumo de várias LUTs para o inspetor: quantas, tamanho total e os primeiros nomes.
 * @param {Array<{ name: string, size?: number }>} luts
 * @param {number} [maxNames]
 * @returns {{ count: number, totalBytes: number, names: string[], more: number }}
 */
export function summarize(luts, maxNames = 5) {
    const names = luts.slice(0, maxNames).map((lut) => lut.name);
    const totalBytes = luts.reduce((sum, lut) => sum + (Number(lut.size) > 0 ? Number(lut.size) : 0), 0);
    return { count: luts.length, totalBytes, names, more: Math.max(0, luts.length - names.length) };
}

/**
 * O conjunto de LUTs marcadas. `anchor` é o ponto de partida do Shift+clique (a última LUT marcada ou desmarcada
 * "à mão"); a ordem de inserção do conjunto é a ordem em que a pessoa marcou.
 */
export function createSelection() {
    const set = new Set();
    let anchor = null;

    return {
        get size() { return set.size; },
        get anchor() { return anchor; },
        has: (path) => set.has(path),
        paths: () => [...set],
        /** O único caminho marcado, ou null se não há exatamente um. */
        only: () => (set.size === 1 ? set.values().next().value : null),
        setAnchor(path) { anchor = path; },
        /** Marca só estes (e a âncora passa a ser `nextAnchor`). */
        replace(paths, nextAnchor = null) {
            set.clear();
            for (const path of paths) set.add(path);
            anchor = nextAnchor;
        },
        /** Alterna uma LUT (Ctrl+clique, círculo do cartão). A âncora vai para ela. Devolve true se ficou marcada. */
        toggle(path) {
            anchor = path;
            if (set.delete(path)) return false;
            set.add(path);
            return true;
        },
        /**
         * Shift+clique: o intervalo entre a âncora e `to`, na ordem recebida. Sem `additive` ele substitui a seleção;
         * com `additive` (Ctrl+Shift) soma à que já existe. A âncora não muda. Devolve false se não há âncora válida
         * (aí a tela trata como um clique comum).
         */
        selectRange(ordered, to, { additive = false } = {}) {
            const range = anchor === null ? null : rangePaths(ordered, anchor, to);
            if (!range) return false;
            if (!additive) set.clear();
            for (const path of range) set.add(path);
            return true;
        },
        clear() {
            const had = set.size > 0;
            set.clear();
            anchor = null;
            return had;
        },
        /** Tira o que `keep(path)` recusa (LUT que sumiu ou saiu do filtro). Devolve true se algo saiu. */
        prune(keep) {
            let changed = false;
            for (const path of [...set]) {
                if (!keep(path)) { set.delete(path); changed = true; }
            }
            if (anchor !== null && !keep(anchor)) anchor = null;
            return changed;
        }
    };
}
