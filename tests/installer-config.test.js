'use strict';

// Configuração e textos do instalador (NSIS): sem rodar o instalador, confere o que dá para conferir no código.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nsh = fs.readFileSync(path.join(ROOT, 'installer', 'installer.nsh'), 'utf8');
const { SETUP_FLAG } = require('../src/setup/setupArgs');
const { toUtf16leBom } = require('../scripts/installer-license');

const codeLines = () => nsh.split(/\r?\n/).filter((l) => !/^\s*;/.test(l));

test('instalador: assistido (não "um clique"), por usuário, em português e com as imagens da marca', () => {
  const n = pkg.build.nsis;
  assert.equal(n.oneClick, false);
  assert.equal(n.perMachine, false);
  assert.deepEqual(n.installerLanguages, ['pt_BR']);
  assert.equal(n.runAfterFinish, true);
  assert.equal(n.deleteAppDataOnUninstall, false, 'o desinstalador mantém os dados por padrão');
  assert.equal(pkg.build.directories.buildResources, 'installer');
  for (const f of [n.include, n.installerHeader, n.installerSidebar, n.uninstallerSidebar]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `arquivo do instalador ausente: ${f}`);
  }
  for (const f of ['installerHeader.bmp', 'installerSidebar.bmp', 'uninstallerSidebar.bmp']) {
    const b = fs.readFileSync(path.join(ROOT, 'installer', f));
    assert.equal(b.toString('ascii', 0, 2), 'BM');
    assert.equal(b.readUInt16LE(28), 24, `${f}: BMP precisa ter 24 bits`);
  }
});

test('instalador: nenhum nome de programa interno nos textos (só "ferramentas" e "transcrição")', () => {
  // (a detecção de componentes já instalados confere nomes de arquivos no disco: não é texto da tela)
  const visible = codeLines().filter((l) => !/FileExists/.test(l)).join('\n');
  assert.doesNotMatch(visible, /yt-?dlp|ffmpeg|ffprobe|whisper|deno\b|spotify|spotdl|untrunc|exiftool/i);
});

test('instalador: chama o modo de componentes com a opção que o app reconhece e tem os parâmetros documentados', () => {
  assert.ok(nsh.includes(`${SETUP_FLAG}=`), 'o instalador precisa usar a mesma opção que setupArgs.js');
  assert.match(nsh, /--progress-file=/);
  assert.match(nsh, /--cancel-file=/);
  for (const p of ['/COMPONENTES=', '/ATALHO=', '/MODELO=', '/DADOS=']) assert.ok(nsh.includes(p), `parâmetro ausente: ${p}`);
  // em silêncio (/S) sem /COMPONENTES nada é baixado
  assert.match(nsh, /\$CompMode == ""\s*\n\s*StrCpy \$CompMode "none"/);
});

test('instalador: tema preto com a paleta do app (fundo, superfície, texto, secundário e acento)', () => {
  for (const hex of ['000000', '1C1C1C', 'FFFFFF', 'A1A1A1', '0x0000FF']) assert.ok(nsh.toUpperCase().includes(hex.toUpperCase()), `cor ausente: ${hex}`);
  assert.match(nsh, /MUI_BGCOLOR 000000/);
});

test('licença do instalador: texto do LICENSE em UTF-16 LE com BOM e CRLF (acentos intactos)', () => {
  const b = toUtf16leBom('Licença\nSegunda linha');
  assert.deepEqual([...b.slice(0, 2)], [0xFF, 0xFE]);
  const text = b.slice(2).toString('utf16le');
  assert.equal(text, 'Licença\r\nSegunda linha');
});
