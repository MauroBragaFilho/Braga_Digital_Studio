/**
 * Avisos sobre as LUTs de um projeto depois de exportar (pacote .bdspro ou XML) e de importar um pacote.
 * Só montam texto puro: quem mostra usa o diálogo do app (nunca HTML).
 */

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Quantas linhas de aviso entram no diálogo (o resto vira "e mais N avisos"). */
const MAX_WARNING_LINES = 6;

function limitedLines(lines) {
  if (lines.length <= MAX_WARNING_LINES) return lines;
  const rest = lines.length - MAX_WARNING_LINES;
  return [...lines.slice(0, MAX_WARNING_LINES), `E mais ${count(rest, 'aviso', 'avisos')}.`];
}

/**
 * Complemento do aviso de "Pacote .bdspro exportado": quantas LUTs foram levadas e o que ficou de fora.
 * @param {{ included?: number, warnings?: string[] } | null | undefined} luts - resultado da exportação (ausente = projeto sem LUTs)
 * @returns {string} '' se o projeto não tem LUTs; senão começa com uma linha em branco
 */
export function bdsproLutsNote(luts) {
  if (!luts) return '';
  const included = Number(luts.included) || 0;
  const lines = [included > 0 ? `${count(included, 'LUT foi levada', 'LUTs foram levadas')} dentro do pacote.` : 'Nenhuma LUT foi levada dentro do pacote.'];
  for (const warning of Array.isArray(luts.warnings) ? luts.warnings : []) lines.push(String(warning));
  return `\n\n${limitedLines(lines).join('\n')}`;
}

/**
 * Complemento do aviso de "XML exportado": onde as LUTs do projeto foram copiadas e o que o XML não faz.
 * @param {{ folder?: string|null, copied?: number, existing?: number, missing?: number, changed?: number, failed?: number } | null | undefined} luts
 * @returns {string} '' se o projeto não tem LUTs; senão começa com uma linha em branco
 */
export function xmlLutsNote(luts) {
  if (!luts) return '';
  const placed = (Number(luts.copied) || 0) + (Number(luts.existing) || 0);
  const lines = [];
  if (luts.folder && placed > 0) lines.push(`LUTs do projeto copiadas para: ${luts.folder}`);
  else lines.push('As LUTs do projeto não foram copiadas.');
  const missing = Number(luts.missing) || 0;
  const changed = Number(luts.changed) || 0;
  const failed = Number(luts.failed) || 0;
  if (missing > 0) lines.push(`${count(missing, 'LUT não está mais na coleção', 'LUTs não estão mais na coleção')} e não foi copiada.`);
  if (changed > 0) lines.push(`${count(changed, 'LUT foi alterada', 'LUTs foram alteradas')} depois de adicionada ao projeto e não foi copiada.`);
  if (failed > 0) lines.push(`${count(failed, 'LUT não pôde', 'LUTs não puderam')} ser copiada.`);
  lines.push('No Premiere ou no DaVinci a LUT é aplicada por você; o XML não aplica LUT.');
  return `\n\n${lines.join('\n')}`;
}

/**
 * Aviso depois de importar um pacote: o que da lista de LUTs não pôde ser restaurado.
 * @param {{ lutsWarnings?: string[] } | null | undefined} result - resultado da importação
 * @returns {string} '' se não há avisos
 */
export function importLutsWarning(result) {
  const warnings = result && Array.isArray(result.lutsWarnings) ? result.lutsWarnings.map(String) : [];
  if (!warnings.length) return '';
  return `Projeto importado. Algumas LUTs do pacote não foram restauradas:\n\n${limitedLines(warnings).join('\n')}\n\nNo projeto elas aparecem como LUT ausente.`;
}
