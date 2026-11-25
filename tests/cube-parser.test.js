'use strict';

// CubeParser: UMA regra de validação para a importação e para a leitura (sintéticos em os.tmpdir()).

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CubeParser = require('../src/core/luts/CubeParser');
const { rows3d, cube3d, cube1d, badCubes } = require('./helpers/cube-fixtures');

const { CubeError } = CubeParser;
const validate = (text) => CubeParser.validate(Buffer.from(text));

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cube-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── LUTs boas ───────────────────────────────────────────────────────────────────────────────────

test('válidas: LF, CRLF, BOM, tabs, notação científica, comentários e linhas em branco', () => {
  const lf = cube3d(2);
  const cases = {
    lf,
    crlf: cube3d(2, { eol: '\r\n' }),
    bom: cube3d(2, { bom: true }),
    'sem título': cube3d(2, { title: null }),
    tabs: lf.replace(/ /g, '\t'),
    'espaços extras': lf.replace(/ /g, '   '),
    'notação científica': `LUT_3D_SIZE 2\n${rows3d(2, () => '1e-1 2.5E0 .5').join('\n')}\n`,
    'sinais e ponto no fim': `LUT_3D_SIZE 2\n${rows3d(2, () => '+0.5 -0.25 1.').join('\n')}\n`,
    'comentários e linhas em branco': `# criada em teste\n\n${lf.replace('LUT_3D_SIZE 2\n', 'LUT_3D_SIZE 2 # tamanho\n\n# tabela\n')}\n\n`,
    'comentário no fim da linha de dados': `LUT_3D_SIZE 2\n${rows3d(2).map((r) => `${r} # ok`).join('\n')}\n`,
    'sem quebra de linha no fim': lf.trimEnd(),
    'tabela 1D': cube1d(4),
    'tabela 1D grande': cube1d(1024)
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = validate(text);
    assert.equal(r.ok, true, `${name}: ${r.reason}`);
    assert.equal(r.code, null);
    assert.equal(r.reason, null);
    assert.equal(r.info.entries, r.info.expected, name);
  }
});

test('válida: a extensão .CUBE em maiúsculas e arquivos reais em disco', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'A.CUBE'), cube3d(3));
  fs.writeFileSync(path.join(dir, 'com acento é ç.cube'), cube3d(2));
  assert.equal(CubeParser.validate(path.join(dir, 'A.CUBE')).ok, true);
  assert.equal(CubeParser.validate(path.join(dir, 'com acento é ç.cube')).ok, true);
});

test('info: tipo, tamanho, linhas, título, domínio e faixa de entrada', () => {
  const text = `TITLE "Filme"\nDOMAIN_MIN -0.5 -0.5 -0.5\nDOMAIN_MAX 1.5 1.5 1.5\nLUT_3D_INPUT_RANGE 0 2\nLUT_3D_SIZE 2\n${rows3d(2).join('\n')}\n`;
  const { info } = validate(text);
  assert.equal(info.kind, '3D');
  assert.equal(info.lutSize, 2);
  assert.equal(info.entries, 8);
  assert.equal(info.expected, 8);
  assert.equal(info.title, 'Filme');
  assert.deepEqual(info.domainMin, [-0.5, -0.5, -0.5]);
  assert.deepEqual(info.domainMax, [1.5, 1.5, 1.5]);
  assert.deepEqual(info.inputRange, [0, 2]);
  assert.equal(info.bytes, Buffer.byteLength(text));
  assert.equal(info.headerLines.length, 5);
  assert.deepEqual(info.ignoredKeywords, []);

  const one = validate(cube1d(5)).info;
  assert.equal(one.kind, '1D');
  assert.equal(one.expected, 5);
});

test('título: entre a primeira e a última aspa; sem aspas vale o resto da linha; marcas de direção e controles saem', () => {
  const title = (line) => validate(`${line}\nLUT_3D_SIZE 2\n${rows3d(2).join('\n')}\n`).info.title;
  assert.equal(title('TITLE "He said "hi" ok"'), 'He said "hi" ok');
  assert.equal(title('TITLE "Film #1 (Kodak)"'), 'Film #1 (Kodak)');
  assert.equal(title('TITLE Sem aspas'), 'Sem aspas');
  assert.equal(title('TITLE "a‮b‏c\u0007d"'), 'abcd');
  assert.equal(title(`TITLE "${'x'.repeat(500)}"`).length, 200);
});

test('palavra-chave desconhecida é tolerada e contada', () => {
  const r = validate(`FOO bar\nBAZ_QUX 1\nFOO again\n${cube3d(2)}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.info.ignoredKeywords, ['FOO', 'BAZ_QUX']);
});

test('o tamanho repetido com o mesmo valor é tolerado; com outro valor, recusado', () => {
  assert.equal(validate(cube3d(2).replace('LUT_3D_SIZE 2\n', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n')).ok, true);
  const r = validate(cube3d(2).replace('LUT_3D_SIZE 2\n', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 3\n'));
  assert.equal(r.code, 'BAD_SIZE');
});

// ─── LUTs ruins ──────────────────────────────────────────────────────────────────────────────────

test('toda LUT ruim é recusada com o código esperado, motivo em português e sem texto cru de exceção', () => {
  for (const bad of badCubes()) {
    const buffer = Buffer.isBuffer(bad.content) ? bad.content : Buffer.from(bad.content);
    const r = CubeParser.validate(buffer);
    assert.equal(r.ok, false, bad.name);
    assert.equal(r.code, bad.code, `${bad.name}: ${r.reason}`);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 10 && !/undefined|NaN|\[object|Error:/.test(r.reason), `${bad.name}: motivo estranho "${r.reason}"`);
    assert.equal(r.info, null);
  }
});

test('validate e parse sempre concordam (nenhuma LUT passa em uma e falha na outra)', () => {
  const good = [cube3d(2), cube3d(5, { eol: '\r\n', bom: true }), cube1d(8), cube1d(2)];
  for (const text of good) {
    assert.equal(validate(text).ok, true);
    assert.doesNotThrow(() => CubeParser.parse(Buffer.from(text)));
  }
  for (const bad of badCubes()) {
    const buffer = Buffer.isBuffer(bad.content) ? bad.content : Buffer.from(bad.content);
    const v = CubeParser.validate(buffer);
    assert.throws(() => CubeParser.parse(buffer), (err) => err instanceof CubeError && err.code === v.code && err.message === v.reason, bad.name);
  }
});

test('mensagens: texto exato das recusas mais comuns', () => {
  const find = (name) => { const bad = badCubes().find((b) => b.name === name); return CubeParser.validate(Buffer.isBuffer(bad.content) ? bad.content : Buffer.from(bad.content)).reason; };
  assert.equal(find('1d-e-3d-juntos'), 'Esta LUT traz tabelas 1D e 3D no mesmo arquivo, formato que o programa não aceita.');
  assert.equal(find('linhas-a-mais'), 'A tabela tem 9 linhas; o esperado para tamanho 2 é 8.');
  assert.equal(find('tamanho-17x'), 'Tamanho da tabela inválido (17x).');
  assert.equal(find('sem-tamanho'), 'Falta a linha de tamanho (LUT_3D_SIZE ou LUT_1D_SIZE).');
  assert.equal(find('vazio'), 'O arquivo está vazio.');
  assert.equal(find('binario'), 'O conteúdo não é texto; não parece uma LUT.');
  assert.equal(find('virgula-decimal'), 'Linha 2: valor inválido (use ponto, não vírgula, como separador decimal).');
  assert.equal(find('quatro-colunas'), 'Linha 2: são esperados 3 valores por linha.');
  assert.equal(find('dominio-invertido'), 'O domínio da LUT está inválido.');
});

test('a linha informada na recusa é a linha física do arquivo (com título, comentário e linha em branco antes)', () => {
  const text = `# a\n\nTITLE "x"\nLUT_3D_SIZE 2\n0 0 0\n0,5 0 0\n`;
  assert.equal(validate(text).reason, 'Linha 6: valor inválido (use ponto, não vírgula, como separador decimal).');
});

test('uma linha só com um valor ruim no meio de milhares: a recusa aponta a primeira', () => {
  const lines = rows3d(9);
  lines[100] = '0.1 0,2 0.3';
  lines[200] = '0.1 abc 0.3';
  const r = validate(`LUT_3D_SIZE 9\n${lines.join('\n')}\n`);
  assert.equal(r.code, 'BAD_NUMBER');
  assert.match(r.reason, /^Linha 102:/);
});

test('arquivo incompleto: não é válido, mas o cabeçalho devolve a contagem real de linhas', () => {
  const text = `TITLE "T"\nLUT_3D_SIZE 3\n${rows3d(3).slice(0, 10).join('\n')}\n`;
  assert.equal(validate(text).code, 'ROWS');
  const header = CubeParser.parseHeader(Buffer.from(text));
  assert.equal(header.size, 3);
  assert.equal(header.is1D, false);
  assert.equal(header.totalEntries, 10);
  assert.equal(header.title, 'T');
  assert.equal(header.preview.length, 10);
});

test('cabeçalho: tolera linhas ruins no meio (só conta as boas) e limita a prévia a 100 linhas', () => {
  const lines = rows3d(9);
  lines[3] = 'lixo no meio';
  const header = CubeParser.parseHeader(Buffer.from(`LUT_3D_SIZE 9\n${lines.join('\n')}\n`));
  assert.equal(header.totalEntries, 728);
  assert.equal(header.preview.length, 100);
  assert.deepEqual(header.preview[0], [0, 0, 0]);
});

test('cabeçalho: só recusa o que nem dá para ler como texto', () => {
  assert.throws(() => CubeParser.parseHeader(Buffer.from([0x00, 0x01, 0x02])), (e) => e instanceof CubeError && e.code === 'BINARY');
  assert.throws(() => CubeParser.parseHeader(Buffer.alloc(0)), (e) => e instanceof CubeError && e.code === 'EMPTY');
  const sizeless = CubeParser.parseHeader(Buffer.from('TITLE "só título"\n'));
  assert.equal(sizeless.size, null);
  assert.equal(sizeless.totalEntries, 0);
});

test('parse: devolve a tabela completa, a prévia (100 linhas), o título e os cabeçalhos', () => {
  const parsed = CubeParser.parse(Buffer.from(cube3d(5, { header: ['# criada no teste', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'] })));
  assert.equal(parsed.size, 5);
  assert.equal(parsed.is1D, false);
  assert.ok(parsed.data instanceof Float32Array, 'tabela compacta (r, g, b em sequência)');
  assert.equal(parsed.data.length, 125 * 3);
  assert.equal(parsed.totalEntries, 125);
  assert.equal(parsed.preview.length, 100);
  assert.ok(Array.isArray(parsed.preview[0]) && parsed.preview[0].length === 3, 'a prévia segue como listas [r, g, b]');
  assert.equal(parsed.title, 'Teste');
  assert.deepEqual(parsed.domainMin, [0, 0, 0]);
  assert.deepEqual(parsed.domainMax, [1, 1, 1]);
  assert.ok(parsed.headerLines.includes('# criada no teste'));
  // ordem dos eixos: o vermelho varia mais rápido (linha 1 = próximo valor de R); linha i ocupa as posições 3i..3i+2
  const at = (i, c) => parsed.data[i * 3 + c];
  assert.ok(at(1, 0) > at(0, 0));
  assert.equal(at(1, 1), at(0, 1));
  assert.ok(at(5, 1) > at(0, 1));
  assert.ok(at(25, 2) > at(0, 2));
  // os valores batem com a prévia (mesma leitura)
  for (let i = 0; i < 100; i++) for (let c = 0; c < 3; c++) assert.equal(at(i, c), Math.fround(parsed.preview[i][c]));
  const one = CubeParser.parse(Buffer.from(cube1d(4)));
  assert.equal(one.is1D, true);
  assert.equal(one.data.length, 4 * 3);
});

test('parse de LUT 65³ (274.625 linhas) abre inteira, rápido e compacta (Float32Array de 3 valores por linha)', () => {
  const text = cube3d(65);
  const started = Date.now();
  const parsed = CubeParser.parse(Buffer.from(text));
  assert.equal(parsed.data.length, 274625 * 3);
  assert.equal(parsed.data.byteLength, 274625 * 3 * 4, 'cerca de 3,3 MB, em vez de 274 mil listas');
  assert.ok(Date.now() - started < 3000, 'leitura linear, sem dividir o arquivo todo em linhas');
});

test('domínio e faixa de entrada saem na leitura completa (a prévia os aplica)', () => {
  const text = `DOMAIN_MIN -0.5 0 0\nDOMAIN_MAX 2 1 1\nLUT_3D_SIZE 2\n${rows3d(2).join('\n')}\n`;
  const parsed = CubeParser.parse(Buffer.from(text));
  assert.deepEqual(parsed.domainMin, [-0.5, 0, 0]);
  assert.deepEqual(parsed.domainMax, [2, 1, 1]);
  const ranged = CubeParser.parse(Buffer.from(`LUT_1D_INPUT_RANGE 0 4\n${cube1d(3)}`));
  assert.deepEqual(ranged.inputRange, [0, 4]);
});

test('números estritos: vírgula decimal e sufixos são recusados também na leitura completa, com a linha certa', () => {
  const comma = `LUT_3D_SIZE 2\n${rows3d(2).map((r, i) => (i === 3 ? '0,5 0 0' : r)).join('\n')}\n`;
  assert.throws(() => CubeParser.parse(Buffer.from(comma)), (e) => e.code === 'BAD_NUMBER' && /^Linha 5:.*vírgula/.test(e.message));
  for (const bad of ['0.5f 0 0', '0.5e 0 0', '1_0 0 0', '0x10 0 0', '--1 0 0', '1..2 0 0']) {
    const text = `LUT_3D_SIZE 2\n${rows3d(2).map((r, i) => (i === 0 ? bad : r)).join('\n')}\n`;
    assert.throws(() => CubeParser.parse(Buffer.from(text)), (e) => e.code === 'BAD_NUMBER', bad);
  }
  // o domínio também é estrito
  const domain = `DOMAIN_MAX 1,0 1 1\nLUT_3D_SIZE 2\n${rows3d(2).join('\n')}\n`;
  assert.equal(validate(domain).code, 'BAD_DOMAIN');
});

// ─── Arquivos em disco ───────────────────────────────────────────────────────────────────────────

test('em disco: extensão errada, pasta, arquivo inexistente e vazio', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'nota.txt'), cube3d(2));
  fs.mkdirSync(path.join(dir, 'pasta.cube'));
  fs.writeFileSync(path.join(dir, 'vazio.cube'), '');
  const code = (p) => CubeParser.validate(p).code;
  assert.equal(code(path.join(dir, 'nota.txt')), 'NOT_CUBE');
  assert.equal(code(path.join(dir, 'pasta.cube')), 'NOT_FILE');
  assert.equal(code(path.join(dir, 'nao-existe.cube')), 'NOT_FILE');
  assert.equal(code(path.join(dir, 'vazio.cube')), 'EMPTY');
  assert.equal(code(''), 'NOT_FILE');
  assert.equal(code(null), 'NOT_FILE');
  assert.equal(CubeParser.validate(path.join(dir, 'nota.txt')).reason, 'Não é um arquivo .cube.');
  assert.equal(CubeParser.validate(path.join(dir, 'pasta.cube')).reason, 'Não é um arquivo.');
});

test('arquivo gigante (esparso de 100 MB): recusado pelo tamanho SEM ler nem alocar o conteúdo', () => {
  const dir = tmpDir();
  const big = path.join(dir, 'gigante.cube');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, 100 * 1024 * 1024);
  fs.closeSync(fd);
  const read = mock.method(fs, 'readFileSync');
  try {
    const r = CubeParser.validate(big);
    assert.equal(r.code, 'TOO_BIG');
    assert.equal(r.reason, 'Arquivo grande demais (máximo 64 MB).');
    assert.throws(() => CubeParser.parse(big), (e) => e.code === 'TOO_BIG');
    assert.throws(() => CubeParser.parseHeader(big), (e) => e.code === 'TOO_BIG');
    assert.equal(read.mock.calls.filter((c) => String(c.arguments[0]) === big).length, 0, 'nem abriu o arquivo');
  } finally { read.mock.restore(); }
});

test('em disco, as mesmas recusas valem (validate, parse e parseHeader sobre arquivos reais)', () => {
  const dir = tmpDir();
  for (const bad of badCubes()) {
    const file = path.join(dir, `${bad.name}.cube`);
    fs.writeFileSync(file, bad.content);
    const v = CubeParser.validate(file);
    assert.equal(v.code, bad.code, bad.name);
    assert.throws(() => CubeParser.parse(file), (e) => e instanceof CubeError && e.code === bad.code, bad.name);
  }
});

// ─── Cabeçalho curto (lista) e cabeçalho do painel ────────────────────────────────────────────────

test('readHeaderQuick: tipo, tamanho e título de LUT 3D e 1D lendo só o começo, sem validar a tabela', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.cube'), cube3d(5, { title: 'Filme' }));
  fs.writeFileSync(path.join(dir, 'b.cube'), `# comentário\n${cube1d(16)}`);
  fs.writeFileSync(path.join(dir, 'incompleta.cube'), `TITLE "T"\nLUT_3D_SIZE 9\n0 0 0\n`); // tabela quebrada: a lista não sabe
  assert.deepEqual(CubeParser.readHeaderQuick(path.join(dir, 'a.cube')), { kind: '3D', lutSize: 5, title: 'Filme' });
  assert.deepEqual(CubeParser.readHeaderQuick(path.join(dir, 'b.cube')), { kind: '1D', lutSize: 16, title: null });
  assert.deepEqual(CubeParser.readHeaderQuick(path.join(dir, 'incompleta.cube')), { kind: '3D', lutSize: 9, title: 'T' });
});

test('readHeaderQuick: lê no máximo 8 KB (arquivo grande não é lido inteiro) e acha o tamanho dentro deles', () => {
  const dir = tmpDir();
  const big = path.join(dir, 'grande.cube');
  fs.writeFileSync(big, cube3d(33, { title: 'Grande' }));
  const spy = mock.method(fs, 'readSync');
  const whole = mock.method(fs, 'readFileSync');
  try {
    assert.deepEqual(CubeParser.readHeaderQuick(big), { kind: '3D', lutSize: 33, title: 'Grande' });
    const sizes = spy.mock.calls.map((c) => c.arguments[3]);
    assert.ok(sizes.length >= 1 && sizes.every((n) => n <= 8 * 1024), `leitura de ${sizes} bytes`);
    assert.equal(whole.mock.calls.filter((c) => String(c.arguments[0]) === big).length, 0);
  } finally { spy.mock.restore(); whole.mock.restore(); }
});

test('readHeaderQuick: não parece LUT devolve tipo nulo; o que nem é arquivo .cube legível devolve null; nunca lança', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'binario.cube'), Buffer.from([0x4c, 0x55, 0x00, 0x01]));
  fs.writeFileSync(path.join(dir, 'sem-tamanho.cube'), `TITLE "x"\n${rows3d(2).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'vazio.cube'), '');
  fs.writeFileSync(path.join(dir, 'virgula.cube'), `LUT_3D_SIZE 2,0\n${rows3d(2).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'nota.txt'), cube3d(2));
  fs.mkdirSync(path.join(dir, 'pasta.cube'));
  assert.deepEqual(CubeParser.readHeaderQuick(path.join(dir, 'binario.cube')), { kind: null, lutSize: null, title: null });
  assert.deepEqual(CubeParser.readHeaderQuick(path.join(dir, 'sem-tamanho.cube')), { kind: null, lutSize: null, title: 'x' });
  assert.equal(CubeParser.readHeaderQuick(path.join(dir, 'virgula.cube')).kind, null, 'tamanho com vírgula não vale');
  for (const bad of ['vazio.cube', 'nota.txt', 'pasta.cube', 'nao-existe.cube']) assert.equal(CubeParser.readHeaderQuick(path.join(dir, bad)), null, bad);
  assert.equal(CubeParser.readHeaderQuick(''), null);
  assert.equal(CubeParser.readHeaderQuick(null), null);
});

test('readHeaderQuick: título com marcas de direção e controles sai limpo, como na validação', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 't.cube'), `TITLE "a‮b\u0007c"\nLUT_3D_SIZE 2\n${rows3d(2).join('\n')}\n`);
  assert.equal(CubeParser.readHeaderQuick(path.join(dir, 't.cube')).title, 'abc');
});

test('cabeçalho do painel: arquivo grande lê só o começo (totalEntries nulo, partial) e traz a prévia de 100 linhas', () => {
  const dir = tmpDir();
  const big = path.join(dir, 'grande.cube');
  fs.writeFileSync(big, cube3d(33, { title: 'Grande' }));
  const whole = mock.method(fs, 'readFileSync');
  try {
    const header = CubeParser.parseHeader(big);
    assert.equal(header.size, 33);
    assert.equal(header.title, 'Grande');
    assert.equal(header.partial, true);
    assert.equal(header.totalEntries, null);
    assert.equal(header.preview.length, 100);
    assert.equal(whole.mock.calls.filter((c) => String(c.arguments[0]) === big).length, 0, 'não leu o arquivo inteiro');
  } finally { whole.mock.restore(); }
});

test('cabeçalho do painel: arquivo pequeno segue lido inteiro, com a contagem real (exata)', () => {
  const dir = tmpDir();
  const small = path.join(dir, 'pequena.cube');
  fs.writeFileSync(small, `TITLE "T"\nLUT_3D_SIZE 3\n${rows3d(3).slice(0, 10).join('\n')}\n`);
  const header = CubeParser.parseHeader(small);
  assert.equal(header.partial, false);
  assert.equal(header.totalEntries, 10);
});
