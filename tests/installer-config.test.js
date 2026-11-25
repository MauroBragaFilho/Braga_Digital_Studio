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

// ─── LUTs embutidas no instalador ──────────────────────────────────────────────────────────────

const lutsDir = path.join(ROOT, 'resources', 'luts-embutidas');
const provenance = JSON.parse(fs.readFileSync(path.join(lutsDir, 'PROCEDENCIA.json'), 'utf8'));
const cubes = fs.readdirSync(lutsDir).filter((n) => n.toLowerCase().endsWith('.cube')).sort();
const EXCLUDED_ADOBE = ['8Bits Parcial para Completo.cube', 'SMPTEToFull8.cube', 'SMPTEToFull10.cube', 'SMPTEToFull12.cube'];

test('instalador: as LUTs embutidas vão como recurso fora do asar e a pasta data/ continua fora do pacote', () => {
  const entry = pkg.build.extraResources.find((r) => r.from === 'resources/luts-embutidas');
  assert.ok(entry, 'extraResources precisa levar resources/luts-embutidas');
  assert.equal(entry.to, 'luts-embutidas');
  assert.deepEqual(entry.filter, ['*.cube'], 'só as .cube (nada de PROCEDENCIA.json/README no instalador)');
  assert.ok(pkg.build.files.includes('!data/**'));
  assert.ok(!pkg.build.files.some((p) => typeof p === 'string' && !p.startsWith('!') && /^resources/.test(p)), 'resources/ não entra no asar');
});

test('instalador: os scripts de build rodam a conferência em modo release; verify:package sozinho só avisa', () => {
  for (const name of ['build', 'build:win', 'build:win:portable', 'build:linux', 'build:linux:appimage', 'build:linux:deb']) {
    assert.match(pkg.scripts[name], /^npm run verify:package -- --release && electron-builder /, name);
  }
  assert.equal(pkg.scripts['verify:package'], 'node scripts/verify-package-contents.js');
});

test('LUTs embutidas: .gitignore segura as .cube enquanto a procedência não é confirmada e .gitattributes protege os bytes', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split(/\r?\n/);
  const pending = provenance.arquivos.some((a) => a.status !== 'confirmada');
  assert.equal(gitignore.includes('resources/luts-embutidas/*.cube'), pending, 'a linha só sai do .gitignore depois de confirmada');
  assert.ok(attributes.includes('resources/luts-embutidas/*.cube -text'));
});

test('LUTs embutidas: PROCEDENCIA.json deixa de fora as 4 da Adobe e é coerente com o status', () => {
  assert.deepEqual(provenance.excluidas.map((e) => e.nome).sort(), [...EXCLUDED_ADOBE].sort());
  assert.equal(provenance.arquivos.length, 40);
  const names = provenance.arquivos.map((a) => a.nome);
  assert.equal(new Set(names).size, 40, 'sem nomes repetidos');
  for (const n of EXCLUDED_ADOBE) assert.ok(!names.includes(n), `${n} não pode constar como embutida`);
  for (const a of provenance.arquivos) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, a.nome);
    assert.ok(['a-confirmar', 'confirmada'].includes(a.status), a.nome);
    assert.ok(a.origem && a.licenca, `${a.nome}: origem e licença precisam estar preenchidas (mesmo que "não declarada")`);
  }
  const pending = provenance.arquivos.some((a) => a.status !== 'confirmada');
  assert.equal(provenance.release, !pending, '"release" só é true com tudo confirmado');
});

test('LUTs embutidas: se as .cube estão na pasta, são exatamente as 40 listadas, sem aviso de copyright e com o SHA-256 registrado', (t) => {
  if (cubes.length === 0) { t.skip('clone limpo: as .cube ainda não são versionadas'); return; }
  const crypto = require('node:crypto');
  assert.deepEqual(cubes, provenance.arquivos.map((a) => a.nome).sort());
  for (const n of EXCLUDED_ADOBE) assert.ok(!cubes.includes(n), `${n} (Adobe) não pode estar na pasta`);
  const byName = new Map(provenance.arquivos.map((a) => [a.nome, a]));
  for (const n of cubes) {
    const data = fs.readFileSync(path.join(lutsDir, n));
    assert.doesNotMatch(data.subarray(0, 2048).toString('latin1'), /adobe|copyright/i, `${n}: cabeçalho com aviso de copyright`);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), byName.get(n).sha256, `${n}: SHA-256 diferente do registrado`);
    assert.equal(data.length, byName.get(n).bytes, `${n}: tamanho diferente do registrado`);
    assert.ok(!data.includes(0x0d), `${n}: precisa ser LF puro (sem conversão de fim de linha)`);
  }
});
