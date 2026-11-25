'use strict';

/**
 * Constantes comuns da coleção de LUTs. Os limites seguem os da sincronização com o celular
 * (LutSyncService) para que o que a tela mostra e o que o celular recebe obedeçam à mesma regra.
 */

/** Extensão (minúscula) dos arquivos de LUT tratados pela coleção. */
const LUT_EXT = '.cube';

/** Tamanho máximo de um arquivo de LUT aceito pela coleção (64 MiB). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Profundidade máxima da coleção, contando o nome do arquivo: "Grupo/Sub/Sub2/LUT.cube" tem 4 segmentos. */
const MAX_SEGMENTS = 4;

/** Limite de caminho do Windows (MAX_PATH menos o terminador): o caminho completo de um arquivo não passa disto. */
const MAX_PATH_BUDGET = 259;

/** Folga reservada no caminho para o arquivo temporário (".part") e o sufixo " (2)" de nome repetido. */
const PATH_RESERVE = 24;

/** Tamanho máximo do caminho relativo de uma LUT aceito pelo celular (a sincronização usa o mesmo teto). */
const PHONE_MAX_PATH = 255;

/** Tamanho máximo de uma LUT que o celular recebe (32 MiB); acima disso a LUT fica só no computador. */
const PHONE_MAX_BYTES = 32 * 1024 * 1024;

/** Teto de entradas (arquivos e pastas) lidas na coleção do usuário; acima disso a lista avisa em vez de omitir em silêncio. */
const COLLECTION_MAX_ENTRIES = 50000;

/** Varredura de uma pasta de origem (importar): pastas mais fundas que isto não são lidas; o excedente da árvore aceita é dobrado. */
const SCAN_MAX_SEGMENTS = 16;
const SCAN_MAX_ENTRIES = 100000;
const SCAN_DEADLINE_MS = 60000;

/** Itens que um resumo de importação devolve à tela e itens que a tela pode importar de uma vez. */
const MAX_SCAN_ITEMS = 5000;

/** Caminhos de origem aceitos de uma vez ao arrastar e soltar. */
const MAX_DROPPED_PATHS = 200;

/** Quantas LUTs um projeto aceita (e quantas um pacote .bdspro pode declarar). */
const MAX_PROJECT_LUTS = 100;

/** Pacote .bdspro: o maior arquivo de LUT que ele leva (o mesmo teto do celular) e o total de LUTs sem compressão. */
const MAX_PACKAGE_LUT_FILE = PHONE_MAX_BYTES;
const MAX_PACKAGE_LUT_BYTES = 128 * 1024 * 1024;

module.exports = {
  LUT_EXT, MAX_FILE_BYTES, MAX_SEGMENTS, MAX_PATH_BUDGET, PATH_RESERVE, PHONE_MAX_PATH, PHONE_MAX_BYTES,
  COLLECTION_MAX_ENTRIES, SCAN_MAX_SEGMENTS, SCAN_MAX_ENTRIES, SCAN_DEADLINE_MS, MAX_SCAN_ITEMS, MAX_DROPPED_PATHS,
  MAX_PROJECT_LUTS, MAX_PACKAGE_LUT_FILE, MAX_PACKAGE_LUT_BYTES
};
