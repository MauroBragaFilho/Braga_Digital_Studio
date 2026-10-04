// Lógica PURA da janela virtual da Biblioteca (sem DOM): agrupamento, linhas de altura previsível,
// intervalo visível, mapeamento índice -> posição e diff incremental de listas por id.
// Testada em tests/library-virtual.test.js.

/**
 * Quantas colunas cabem na grade (equivale a repeat(auto-fill, minmax(minCol, 1fr)) com `gap`).
 * @param {number} width largura útil da área (sem o padding)
 */
export function computeColumns(width, minCol = 220, gap = 16) {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return Math.max(1, Math.floor((w + gap) / (minCol + gap)));
}

/**
 * Agrupa itens CONSECUTIVOS pela chave devolvida por keyFn (a ordem da lista é preservada).
 * @returns {{key: string, start: number, count: number, meta: any}[]}
 */
export function groupConsecutive(items, keyFn) {
  const groups = [];
  let cur = null;
  for (let i = 0; i < items.length; i++) {
    const g = keyFn(items[i], i);
    const key = g && typeof g === 'object' ? g.key : g;
    if (cur && cur.key === key) { cur.count++; continue; }
    cur = { key, start: i, count: 1, meta: g };
    groups.push(cur);
  }
  return groups;
}

/**
 * Monta as linhas virtuais: um cabeçalho por grupo e, abaixo dele, linhas de `cols` itens
 * (grade) ou de 1 item (lista, cols = 1).
 * @returns {{rows: ({kind:'header', key:string, group:number, start:number, count:number}|{kind:'items', group:number, start:number, count:number})[], rowOfItem: Int32Array}}
 */
export function buildRows(groups, cols, total) {
  const c = Math.max(1, Math.floor(cols) || 1);
  const rows = [];
  const n = total != null ? total : groups.reduce((s, g) => s + g.count, 0);
  const rowOfItem = new Int32Array(n);
  groups.forEach((g, gi) => {
    rows.push({ kind: 'header', key: g.key, group: gi, start: g.start, count: g.count });
    for (let off = 0; off < g.count; off += c) {
      const count = Math.min(c, g.count - off);
      const r = rows.length;
      for (let k = 0; k < count; k++) rowOfItem[g.start + off + k] = r;
      rows.push({ kind: 'items', group: gi, start: g.start + off, count });
    }
  });
  return { rows, rowOfItem };
}

/** Posições (px) do topo de cada linha: tops[i] = topo da linha i; tops[rows.length] = altura total. */
export function rowTops(rows, headerH, rowH) {
  const tops = new Float64Array(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    tops[i] = y;
    y += rows[i].kind === 'header' ? headerH : rowH;
  }
  tops[rows.length] = y;
  return tops;
}

/** Índice da linha que contém a posição y (busca binária). -1 se não houver linhas. */
export function rowAt(tops, y) {
  const n = tops.length - 1;
  if (n <= 0) return -1;
  if (y <= 0) return 0;
  if (y >= tops[n]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Intervalo de linhas a desenhar para o scroll atual, com margem (overscan, em px) acima e abaixo.
 * @returns {{first: number, last: number}} last inclusivo; first > last quando não há linhas
 */
export function visibleRange(tops, scrollTop, viewHeight, overscanPx = 0) {
  const n = tops.length - 1;
  if (n <= 0) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = Math.max(0, scrollTop + viewHeight + overscanPx);
  return { first: rowAt(tops, top), last: rowAt(tops, bottom) };
}

/** Linha (e topo em px) de um item da lista. */
export function itemPosition(index, rowOfItem, tops) {
  if (!rowOfItem || index < 0 || index >= rowOfItem.length) return null;
  const row = rowOfItem[index];
  return { row, top: tops[row], height: tops[row + 1] - tops[row] };
}

/** Novo scrollTop para deixar a faixa [top, top+height] visível com o mínimo de rolagem (null = já visível). */
export function scrollToReveal(top, height, scrollTop, viewHeight, pad = 0) {
  if (top - pad < scrollTop) return Math.max(0, top - pad);
  if (top + height + pad > scrollTop + viewHeight) return top + height + pad - viewHeight;
  return null;
}

/**
 * Item de destino da navegação por setas. Grade: linha acima/abaixo na mesma coluna (pulando cabeçalhos
 * e limitando à última coluna da linha parcial); lista: cols = 1. Retorna o índice ou -1 (sem movimento).
 */
export function navigateIndex(key, index, rows, rowOfItem, total) {
  if (total <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  if (key === 'ArrowRight') return index + 1 < total ? index + 1 : -1;
  if (key === 'ArrowLeft') return index > 0 ? index - 1 : -1;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return -1;
  const r = rowOfItem[index];
  const row = rows[r];
  if (!row) return -1;
  const col = index - row.start;
  const step = key === 'ArrowDown' ? 1 : -1;
  let k = r + step;
  while (k >= 0 && k < rows.length && rows[k].kind !== 'items') k += step;
  if (k < 0 || k >= rows.length) return -1;
  const target = rows[k];
  return target.start + Math.min(col, target.count - 1);
}

/** Intervalo [min, max] de índices entre dois ids (ordem da lista); null se algum não estiver na lista. */
export function rangeBetween(ids, aId, bId) {
  const a = ids.indexOf(aId);
  const b = ids.indexOf(bId);
  if (a < 0 || b < 0) return null;
  return a <= b ? [a, b] : [b, a];
}

/**
 * Diff incremental de duas listas por id. `reordered` = os ids em comum mudaram de ordem relativa
 * (nesse caso o chamador deve reconstruir tudo); senão, só há inserções/remoções.
 * @returns {{inserted: {index: number, id: any}[], removed: any[], reordered: boolean, unchanged: boolean}}
 */
export function diffById(oldList, newList, idOf = (x) => x.id) {
  const oldIds = oldList.map(idOf);
  const newIds = newList.map(idOf);
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const removed = oldIds.filter((id) => !newSet.has(id));
  const inserted = [];
  newIds.forEach((id, index) => { if (!oldSet.has(id)) inserted.push({ index, id }); });
  const keptOld = oldIds.filter((id) => newSet.has(id));
  const keptNew = newIds.filter((id) => oldSet.has(id));
  let reordered = false;
  for (let i = 0; i < keptOld.length; i++) { if (keptOld[i] !== keptNew[i]) { reordered = true; break; } }
  return { inserted, removed, reordered, unchanged: !inserted.length && !removed.length && !reordered };
}

/**
 * Âncora de rolagem: ao mudar o layout (itens inseridos acima), devolve o novo scrollTop que mantém na mesma
 * posição da tela o item que estava no topo da janela.
 * @param {{index:number, offset:number}} anchor item e distância do topo da linha ao topo da janela (px)
 */
export function scrollTopForAnchor(anchor, rowOfItem, tops) {
  const pos = anchor ? itemPosition(anchor.index, rowOfItem, tops) : null;
  if (!pos) return null;
  return Math.max(0, pos.top - anchor.offset);
}

/**
 * Reconcilia os itens de um conjunto de ids "em tela": quais criar e quais remover.
 * @returns {{create: number[], remove: any[]}} create = índices dos itens que faltam; remove = ids que saíram
 */
export function reconcileWindow(neededIndexes, existingIds, idAt) {
  const needed = new Set();
  const create = [];
  for (const i of neededIndexes) {
    const id = idAt(i);
    needed.add(id);
    if (!existingIds.has(id)) create.push(i);
  }
  const remove = [];
  for (const id of existingIds) if (!needed.has(id)) remove.push(id);
  return { create, remove };
}
