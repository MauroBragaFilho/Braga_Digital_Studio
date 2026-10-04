'use strict';

/**
 * installer-license.js — prepara a licença que o instalador mostra (página "Acordo de Licença").
 *
 * O instalador lê o arquivo LICENSE da raiz do projeto (o responsável o reescreve quando quiser; nada é copiado
 * para o código). A cada build o texto vira installer/license-nsis.txt em UTF-16 LE com BOM e quebras CRLF, o formato
 * que o instalador (Unicode) lê sem trocar os acentos. O controle de licença nativo do instalador não aceita cor de
 * letra, então a página é própria (caixa de texto somente leitura, na paleta preta) e lê esse arquivo.
 * O LICENSE nunca é alterado.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Texto simples -> Buffer UTF-16 LE com BOM e CRLF. */
function toUtf16leBom(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM do próprio LICENSE
  const normalized = s.replace(/\r?\n/g, '\r\n');
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(normalized, 'utf16le')]);
}

/** Lê <projeto>/LICENSE e grava <recursos do instalador>/license-nsis.txt. */
function writeInstallerLicense({ projectDir, buildResourcesDir }) {
  let text;
  try { text = fs.readFileSync(path.join(projectDir, 'LICENSE'), 'utf8'); } catch (_) { text = 'Braga Digital Studio. Todos os direitos reservados.'; }
  const dest = path.join(buildResourcesDir, 'license-nsis.txt');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, toUtf16leBom(text));
  return dest;
}

module.exports = { toUtf16leBom, writeInstallerLicense };
