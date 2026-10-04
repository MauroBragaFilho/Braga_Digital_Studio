'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { handle } = require('./channelRegistry');

// Somente leitura, sem rede e sem caminho vindo do renderer: os dois arquivos são fixos (gerados por
// scripts/generate-licenses.js) e o texto é localizado pelo ID de um item da lista.
const LIST_FILE = path.join(__dirname, '..', 'config', 'third-party-licenses.json');
const TEXT_FILE = path.join(__dirname, '..', '..', 'assets', 'licenses', 'THIRD_PARTY_LICENSES.txt');
const SEPARATOR = '='.repeat(80);

function loadList() {
  const data = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  return { bundled: data.bundled || [], runtime: data.runtime || [] };
}

/** Texto de licença do componente `id` (apenas IDs presentes na lista). Lança se o ID não existir. */
function getLicenseText(id) {
  const list = loadList();
  const known = [...list.bundled, ...list.runtime].some((i) => i.id === id);
  if (!known) throw new Error('Componente não encontrado na lista de licenças.');
  const blocks = fs.readFileSync(TEXT_FILE, 'utf8').replace(/\r\n/g, '\n').split(`${SEPARATOR}\n`);
  // blocos: [cabeçalho, "<título>...ID: x\n", "\n<texto>", ...] — o ID fica na última linha do cabeçalho do bloco.
  for (let i = 1; i < blocks.length - 1; i += 2) {
    if (new RegExp(`(^|\\n)ID: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).test(blocks[i])) return blocks[i + 1].trim();
  }
  throw new Error('Texto da licença indisponível.');
}

module.exports = function registerLicensesHandlers() {
  handle('licenses:getList', () => loadList());
  handle('licenses:getText', (_, id) => getLicenseText(id));
};
module.exports.getLicenseText = getLicenseText;
module.exports.loadList = loadList;
