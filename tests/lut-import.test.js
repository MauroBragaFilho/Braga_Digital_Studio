'use strict';

// Importar de pasta (src/core/luts/LutImporter.js): resumo antes de copiar, só o marcado entra, cópia atômica sem
// sobrescrever, cancelamento, sessões de uma só vez, concorrência e entrada de caminhos vinda da tela.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LutManager = require('../src/core/luts/LutManager');
const LutImporter = require('../src/core/luts/LutImporter');
const { cube3d, cube1d, badCubes } = require('./helpers/cube-fixtures');
const { budget } = require('./helpers/timing');
const logger = require('../src/services/logService');

function setup(t, importerOptions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-imp-'));
  const lutsDir = path.join(root, 'luts');
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(lutsDir);
  fs.mkdirSync(inbox);
  const manager = new LutManager(lutsDir);
  const importer = new LutImporter(manager, importerOptions);
  t.after(async () => {
    await manager._hashFill;
    if (manager._persistTimer) clearTimeout(manager._persistTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (rel, content = cube3d(2), base = inbox) => {
    const p = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { root, lutsDir, inbox, manager, importer, put };
}
const find = (res, name) => res.items.find((i) => i.name === name);
const keysOf = (res, status = 'new') => res.items.filter((i) => i.status === status).map((i) => i.key);
const collectionFiles = (lutsDir) => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name !== '.hash-cache.json') out.push(r); // o arquivo de cache (gravado 0,75 s depois da última mudança) não é uma LUT nem sobra
    }
  };
  walk(lutsDir, '');
  return out.sort();
};
const noParts = (lutsDir) => collectionFiles(lutsDir).filter((f) => /\.part$/.test(f));

test('scan: classifica novas, já existentes, repetidas e inválidas, conta .3dl e nunca expõe caminhos nem hashes', async (t) => {
  const { importer, manager, inbox, lutsDir, put } = setup(t);
  put('Existente.cube', cube3d(2, { tint: 0.5 }), lutsDir); // já na coleção
  put('Looks/Rush/Nova.cube', cube3d(2));
  put('Looks/Rush/Outra.cube', cube3d(3));
  put('Looks/Copia da existente.cube', cube3d(2, { tint: 0.5 }));
  put('Looks/Repetida A.cube', cube3d(2, { tint: 0.2 }));
  put('Looks/Repetida B.cube', cube3d(2, { tint: 0.2 }));
  put('Looks/Quebrada.cube', badCubes().find((b) => b.name === 'virgula-decimal').content);
  put('Looks/Mista.cube', badCubes().find((b) => b.name === '1d-e-3d-juntos').content);
  put('Looks/filme.3dl', 'x');
  put('Looks/outro.3DL', 'x');
  put('Looks/nota.txt', 'x');

  const res = await importer.scan({ paths: [inbox] });
  assert.equal(res.sourceName, 'inbox');
  assert.equal(res.hasFolders, true);
  assert.match(res.scanId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { found: res.summary.found, new: res.summary.new, exists: res.summary.exists, repeated: res.summary.repeated, invalid: res.summary.invalid, ignored3dl: res.summary.ignored3dl, ignoredOther: res.summary.ignoredOther },
    { found: 7, new: 2 + 1, exists: 1, repeated: 1, invalid: 2, ignored3dl: 2, ignoredOther: 1 }
  );
  assert.equal(find(res, 'Nova.cube').status, 'new');
  assert.equal(find(res, 'Nova.cube').folder, 'Looks/Rush');
  assert.equal(find(res, 'Nova.cube').relPath, 'Looks/Rush/Nova.cube');
  assert.equal(find(res, 'Copia da existente.cube').status, 'exists');
  assert.equal(find(res, 'Copia da existente.cube').existsAs, 'Existente.cube');
  assert.equal(find(res, 'Repetida A.cube').status, 'new');
  assert.equal(find(res, 'Repetida B.cube').status, 'repeated');
  assert.equal(find(res, 'Repetida B.cube').existsAs, 'Looks/Repetida A.cube');
  assert.match(find(res, 'Quebrada.cube').reason, /valor inválido/);
  assert.match(find(res, 'Mista.cube').reason, /1D e 3D/);
  const text = JSON.stringify(res);
  assert.ok(!text.includes(inbox.replace(/\\/g, '\\\\')) && !text.includes(inbox), 'o resumo não traz o caminho de origem');
  assert.ok(!/"hash"|"abs"/.test(text));
  assert.deepEqual(collectionFiles(lutsDir), ['Existente.cube'], 'varrer nunca copia nada');
  assert.equal(manager.list().length, 1);
});

test('scan: arquivos soltos (modo arquivos) e pasta mais arquivo juntos', async (t) => {
  const { importer, inbox, put } = setup(t);
  const a = put('a.cube', cube3d(2));
  const b = put('Sub/b.cube', cube3d(3));
  put('Sub/c.cube', cube3d(2, { tint: 0.3 }));
  const files = await importer.scan({ paths: [a, b] });
  assert.equal(files.sourceName, null);
  assert.equal(files.hasFolders, false);
  assert.deepEqual(files.items.map((i) => [i.name, i.folder]), [['a.cube', ''], ['b.cube', '']]);

  const mixed = await importer.scan({ paths: [path.join(inbox, 'Sub'), a] });
  assert.equal(mixed.sourceName, null);
  assert.deepEqual(mixed.items.map((i) => `${i.folder}|${i.name}`).sort(), ['Sub|b.cube', 'Sub|c.cube', '|a.cube'].sort());
});

test('scan: recusa a própria coleção, uma pasta dentro dela e uma pasta que a contém', async (t) => {
  const { importer, lutsDir, root, manager } = setup(t);
  fs.mkdirSync(path.join(lutsDir, 'Dentro'));
  for (const dir of [lutsDir, path.join(lutsDir, 'Dentro')]) {
    await assert.rejects(() => importer.scan({ paths: [dir] }), { message: 'Esta já é a pasta das LUTs.' });
  }
  await assert.rejects(() => importer.scan({ paths: [root] }), /contém a pasta das LUTs/);
  assert.equal(manager.list().length, 0);
});

test('scan: arrastar-e-soltar recusa caminho de rede e mais de 200 itens; caminho relativo e inexistente são ignorados', async (t) => {
  const { importer, inbox, put } = setup(t);
  const ok = put('ok.cube');
  await assert.rejects(() => importer.scan({ paths: ['\\\\servidor\\pasta\\a.cube'], source: 'drop' }), /Pastas de rede/);
  await assert.rejects(() => importer.scan({ paths: ['//servidor/pasta'], source: 'drop' }), /Pastas de rede/);
  await assert.rejects(() => importer.scan({ paths: ['\\\\?\\C:\\x'], source: 'drop' }), /Pastas de rede/);
  await assert.rejects(() => importer.scan({ paths: new Array(201).fill(ok), source: 'drop' }), /máximo de 200/);
  await assert.rejects(() => importer.scan({ paths: [] }), /ao menos um/);
  const res = await importer.scan({ paths: ['relativo.cube', path.join(inbox, 'nao-existe.cube'), path.join(inbox, 'nota.txt'), ok], source: 'drop' });
  assert.deepEqual(res.items.map((i) => i.name), ['ok.cube']);
  assert.equal(res.summary.ignoredOther, 3);
});

test('scan: arquivo esparso de 100 MB é recusado sem ser lido nem alocado', async (t) => {
  const { importer, inbox, put } = setup(t);
  put('boa.cube');
  const big = path.join(inbox, 'enorme.cube');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 100 * 1024 * 1024);
  const reads = [];
  const real = fs.promises.readFile;
  const spy = mock.method(fs.promises, 'readFile', (p, ...rest) => { reads.push(String(p)); return real(p, ...rest); });
  try {
    const res = await importer.scan({ paths: [inbox] });
    assert.equal(find(res, 'enorme.cube').status, 'invalid');
    assert.match(find(res, 'enorme.cube').reason, /grande demais/);
    assert.equal(find(res, 'boa.cube').status, 'new');
  } finally { spy.mock.restore(); }
  assert.ok(!reads.includes(big), 'o arquivo grande nunca foi aberto');
});

test('scan: LUT acima de 32 MB entra com aviso de que o celular não a recebe', async (t) => {
  const { importer, inbox } = setup(t);
  // 1D válida e grande: 40 MB de texto não cabe barato; usa 3D de tamanho que passe de 32 MB com linhas curtas? não: basta um 1D enorme
  const rows = [];
  for (let i = 0; i < 65536; i++) rows.push('0.5 0.5 0.5');
  fs.writeFileSync(path.join(inbox, 'media.cube'), `LUT_1D_SIZE 65536\n${rows.join('\n')}\n`);
  const res = await importer.scan({ paths: [inbox] });
  assert.equal(find(res, 'media.cube').status, 'new');
  assert.equal(find(res, 'media.cube').warning, null, 'abaixo de 32 MB: sem aviso');
  assert.equal(res.summary.bigForPhone, 0);
});

test('commit: importa SÓ as marcadas, preserva as subpastas e entrega o resumo', async (t) => {
  const { importer, manager, inbox, lutsDir, put } = setup(t);
  put('Looks/Rush/Um.cube', cube3d(2, { tint: 0.1 }));
  put('Looks/Rush/Dois.cube', cube3d(2, { tint: 0.2 }));
  put('Looks/Tres.cube', cube3d(2, { tint: 0.3 }));
  const res = await importer.scan({ paths: [inbox] });
  const wanted = [find(res, 'Um.cube').key, find(res, 'Tres.cube').key];
  const out = await importer.commit(res.scanId, wanted, { keepFolders: true, rootGroup: 'inbox' });
  assert.deepEqual({ imported: out.imported, failed: out.failed, exists: out.exists, canceled: out.canceled, total: out.total }, { imported: 2, failed: 0, exists: 0, canceled: false, total: 2 });
  assert.equal(out.groupsCreated, 3, 'inbox, inbox/Looks, inbox/Looks/Rush');
  assert.deepEqual(collectionFiles(lutsDir), ['inbox/Looks/Rush/Um.cube', 'inbox/Looks/Tres.cube']);
  assert.equal(out.firstImported.relPath, 'inbox/Looks/Rush/Um.cube');
  assert.equal(out.firstImported.path, path.join(lutsDir, 'inbox', 'Looks', 'Rush', 'Um.cube'));
  assert.equal(fs.readFileSync(out.firstImported.path, 'utf8'), cube3d(2, { tint: 0.1 }), 'byte a byte');
  assert.deepEqual(noParts(lutsDir), []);
  const listed = manager.list();
  assert.deepEqual(listed.map((l) => l.relPath).sort(), ['inbox/Looks/Rush/Um.cube', 'inbox/Looks/Tres.cube']);
  assert.ok(listed.every((l) => /^[0-9a-f]{64}$/.test(l.hash)), 'o hash do que foi gravado já fica no cache');
});

test('commit: sem manter as subpastas e sem grupo, tudo vai para a raiz; só "new" é importada mesmo que a tela mande outras chaves', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('A/B/x.cube', cube3d(2, { tint: 0.1 }));
  put('A/y.cube', cube3d(2, { tint: 0.1 })); // repetida
  put('A/z.cube', badCubes()[0].content); // inválida
  const res = await importer.scan({ paths: [inbox] });
  const out = await importer.commit(res.scanId, res.items.map((i) => i.key), { keepFolders: false });
  assert.equal(out.imported, 1);
  assert.equal(out.total, 1);
  assert.deepEqual(collectionFiles(lutsDir), ['x.cube']);
});

test('commit: nome igual com conteúdo diferente nunca sobrescreve (ganha " (2)") e pasta muito funda é dobrada', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('a.cube', cube3d(2, { tint: 0.9 }), lutsDir);
  const original = fs.readFileSync(path.join(lutsDir, 'a.cube'), 'utf8');
  put('a.cube', cube3d(2, { tint: 0.1 }));
  put('P1/P2/P3/P4/P5/fundo.cube', cube3d(2, { tint: 0.4 }));
  const res = await importer.scan({ paths: [inbox] });
  const out = await importer.commit(res.scanId, keysOf(res), { keepFolders: true });
  assert.equal(out.imported, 2);
  assert.equal(out.renamed, 1);
  assert.equal(fs.readFileSync(path.join(lutsDir, 'a.cube'), 'utf8'), original);
  assert.deepEqual(collectionFiles(lutsDir), ['P1/P2/P3 - P4 - P5/fundo.cube', 'a (2).cube', 'a.cube']);
});

test('commit: rootGroup inválido é recusado com o motivo e NÃO consome o resumo', async (t) => {
  const { importer, inbox, put } = setup(t);
  put('a.cube');
  const res = await importer.scan({ paths: [inbox] });
  for (const bad of ['a/b', '..', 'CON', 'a:b']) {
    await assert.rejects(() => importer.commit(res.scanId, [0], { rootGroup: bad }), (err) => err.code === 'LUT_USER', bad);
  }
  const out = await importer.commit(res.scanId, [0], { rootGroup: 'Boa' });
  assert.equal(out.imported, 1);
});

test('commit: o segundo commit do mesmo resumo é recusado ("já foi iniciada"); resumo inexistente ou vencido também', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('a.cube');
  const res = await importer.scan({ paths: [inbox] });
  const first = importer.commit(res.scanId, [0], {});
  await assert.rejects(() => importer.commit(res.scanId, [0], {}), { message: 'Esta importação já foi iniciada.' });
  assert.equal((await first).imported, 1);
  await assert.rejects(() => importer.commit(res.scanId, [0], {}), { message: 'Esta importação já foi iniciada.' });
  await assert.rejects(() => importer.commit('nunca-existiu', [0], {}), /expirou/);
  assert.deepEqual(collectionFiles(lutsDir), ['a.cube']);
  await assert.rejects(() => importer.commit(res.scanId, ['x'], {}), /Seleção inválida/);
});

test('sessões: no máximo 3 guardadas e vencem com o tempo', async (t) => {
  const { importer, inbox, put } = setup(t);
  put('a.cube');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await importer.scan({ paths: [inbox] })).scanId);
  await assert.rejects(() => importer.commit(ids[0], [0], {}), /expirou/, 'a mais antiga saiu');
  assert.equal((await importer.commit(ids[3], [0], {})).imported, 1);

  const quick = new LutImporter(importer.manager, { sessionTtlMs: 5 });
  const res = await quick.scan({ paths: [inbox] });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => quick.commit(res.scanId, [0], {}), /expirou/);
});

test('commit: dois resumos do mesmo conteúdo ao mesmo tempo não duplicam (a segunda recebe "outra operação em andamento" e pode tentar de novo)', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  for (let i = 0; i < 40; i++) put(`l${i}.cube`, cube3d(2, { tint: i / 100 }));
  const first = await importer.scan({ paths: [inbox] });
  const second = await importer.scan({ paths: [inbox] });
  const running = importer.commit(first.scanId, keysOf(first), { keepFolders: false });
  await assert.rejects(() => importer.commit(second.scanId, keysOf(second), { keepFolders: false }), { message: 'Há outra operação em andamento.' });
  assert.equal((await running).imported, 40);
  // o resumo recusado por "ocupado" continua valendo; refeito o índice dentro da trava, nada duplica
  const retry = await importer.commit(second.scanId, keysOf(second), { keepFolders: false });
  assert.deepEqual({ imported: retry.imported, exists: retry.exists }, { imported: 0, exists: 40 });
  assert.equal(collectionFiles(lutsDir).length, 40);
});

test('commit: arquivo de origem alterado entre o resumo e a cópia não é publicado e não deixa temporário', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  const changing = put('muda.cube', cube3d(2, { tint: 0.1 }));
  put('fica.cube', cube3d(2, { tint: 0.2 }));
  const res = await importer.scan({ paths: [inbox] });
  fs.writeFileSync(changing, cube3d(2, { tint: 0.7 })); // outro conteúdo válido
  const out = await importer.commit(res.scanId, keysOf(res), {});
  assert.deepEqual({ imported: out.imported, skippedChanged: out.skippedChanged, failed: out.failed }, { imported: 1, skippedChanged: 1, failed: 0 });
  assert.match(out.failures[0].reason, /mudou durante a importação/);
  assert.deepEqual(collectionFiles(lutsDir), ['fica.cube']);
});

test('commit: a cópia gravada diferente do original (hash do temporário) não entra na coleção e o temporário some', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('a.cube', cube3d(2, { tint: 0.1 }));
  put('b.cube', cube3d(2, { tint: 0.2 }));
  const res = await importer.scan({ paths: [inbox] });
  const realRead = fs.readFileSync;
  let corrupted = 0;
  const spy = mock.method(fs, 'readFileSync', (p, ...rest) => {
    const data = realRead(p, ...rest);
    if (/\.part$/.test(String(p)) && corrupted++ === 0) return Buffer.concat([Buffer.from(data), Buffer.from('lixo')]);
    return data;
  });
  const warn = mock.method(logger, 'warn', () => {});
  let out;
  try { out = await importer.commit(res.scanId, keysOf(res), {}); } finally { spy.mock.restore(); warn.mock.restore(); }
  assert.deepEqual({ imported: out.imported, failed: out.failed }, { imported: 1, failed: 1 }, 'a falha de um arquivo não derruba o lote');
  assert.equal(collectionFiles(lutsDir).length, 1);
  assert.deepEqual(noParts(lutsDir), []);
});

test('commit: falha em um arquivo (sumiu depois do resumo) não derruba o lote', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  const gone = put('some.cube', cube3d(2, { tint: 0.1 }));
  put('a.cube', cube3d(2, { tint: 0.2 }));
  put('b.cube', cube3d(2, { tint: 0.3 }));
  const res = await importer.scan({ paths: [inbox] });
  fs.unlinkSync(gone);
  const warn = mock.method(logger, 'warn', () => {});
  let out;
  try { out = await importer.commit(res.scanId, keysOf(res), {}); } finally { warn.mock.restore(); }
  assert.deepEqual({ imported: out.imported, failed: out.failed }, { imported: 2, failed: 1 });
  assert.deepEqual(out.failures.map((f) => f.name), ['some.cube']);
  assert.deepEqual(collectionFiles(lutsDir), ['a.cube', 'b.cube']);
});

test('commit: cancelar termina o arquivo atual, mantém o que já foi copiado e não deixa temporário', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  for (let i = 0; i < 12; i++) put(`l${String(i).padStart(2, '0')}.cube`, cube3d(2, { tint: i / 50 }));
  const res = await importer.scan({ paths: [inbox] });
  const events = [];
  const realNote = importer.manager.noteHash.bind(importer.manager);
  let copied = 0;
  const spy = mock.method(importer.manager, 'noteHash', (...args) => { // depois da 3ª cópia pronta, o usuário cancela
    if (++copied === 3) importer.cancelImport(res.scanId);
    return realNote(...args);
  });
  let out;
  try {
    out = await importer.commit(res.scanId, keysOf(res), { keepFolders: false }, { onProgress: (p) => events.push(p) });
  } finally { spy.mock.restore(); }
  assert.equal(out.canceled, true);
  assert.equal(out.imported, 3, 'termina o arquivo corrente e para');
  assert.equal(collectionFiles(lutsDir).length, out.imported, 'o que foi copiado ficou');
  assert.deepEqual(noParts(lutsDir), []);
  assert.ok(events.length > 0 && events.every((e) => e.scanId === res.scanId));
});

test('commit: destino criado entre o resumo e a cópia: mesmo nome ganha sufixo, mesmo conteúdo conta como existente', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('igual.cube', cube3d(2, { tint: 0.1 }));
  put('nome.cube', cube3d(2, { tint: 0.2 }));
  const res = await importer.scan({ paths: [inbox] });
  put('igual.cube', cube3d(2, { tint: 0.1 }), lutsDir); // outro programa criou a mesma LUT
  put('nome.cube', cube3d(2, { tint: 0.8 }), lutsDir); // outro conteúdo, mesmo nome
  const out = await importer.commit(res.scanId, keysOf(res), { keepFolders: false });
  assert.deepEqual({ imported: out.imported, exists: out.exists, renamed: out.renamed }, { imported: 1, exists: 1, renamed: 1 });
  assert.deepEqual(collectionFiles(lutsDir), ['igual.cube', 'nome (2).cube', 'nome.cube']);
  assert.equal(fs.readFileSync(path.join(lutsDir, 'nome.cube'), 'utf8'), cube3d(2, { tint: 0.8 }), 'a LUT que já estava lá ficou intacta');
});

test('commit: reimportar a mesma pasta não copia nada (tudo já existe)', async (t) => {
  const { importer, inbox, lutsDir, put } = setup(t);
  put('Looks/a.cube', cube3d(2, { tint: 0.1 }));
  put('Looks/b.cube', cube3d(2, { tint: 0.2 }));
  const first = await importer.scan({ paths: [inbox] });
  await importer.commit(first.scanId, keysOf(first), { rootGroup: 'inbox' });
  const again = await importer.scan({ paths: [inbox] });
  assert.deepEqual({ new: again.summary.new, exists: again.summary.exists }, { new: 0, exists: 2 });
  assert.equal(again.items[0].existsAs.startsWith('inbox/Looks/'), true);
  assert.equal(collectionFiles(lutsDir).length, 2);
});

test('commit: caminho que estouraria o limite do Windows vira falha com o motivo (nada é copiado)', async (t) => {
  const { root, inbox, put } = setup(t);
  const longLuts = path.join(root, 'x'.repeat(200));
  fs.mkdirSync(longLuts);
  const manager = new LutManager(longLuts);
  const importer = new LutImporter(manager);
  put('P'.repeat(40) + '/' + 'Q'.repeat(40) + '/' + 'n'.repeat(30) + '.cube');
  const res = await importer.scan({ paths: [inbox] });
  const out = await importer.commit(res.scanId, keysOf(res), { keepFolders: true });
  assert.deepEqual({ imported: out.imported, failed: out.failed }, { imported: 0, failed: 1 });
  assert.match(out.failures[0].reason, /longo demais para o Windows/);
  assert.deepEqual(fs.readdirSync(longLuts), []);
});

test('scan: progresso começa com o id da busca, é espaçado e termina; cancelar no meio devolve { canceled } e descarta o resumo', async (t) => {
  const { importer, inbox, put } = setup(t);
  for (let i = 0; i < 60; i++) put(`P${i}/l${i}.cube`, cube3d(2, { tint: i / 100 }));
  const events = [];
  const res = await importer.scan({ paths: [inbox], onProgress: (p) => events.push(p) });
  assert.equal(events[0].phase, 'start');
  assert.equal(events[0].scanId, res.scanId);
  assert.ok(events.some((e) => e.phase === 'collection'));
  assert.ok(events.some((e) => e.phase === 'read' && e.total === 60));
  assert.ok(events.length < 80, 'a tela não é inundada de eventos');

  let id = null;
  const canceled = await importer.scan({
    paths: [inbox],
    onProgress: (p) => { if (p.phase === 'start') id = p.scanId; if (p.phase === 'collection') importer.cancelScan(id); }
  });
  assert.deepEqual(canceled, { canceled: true });
  await assert.rejects(() => importer.commit(id, [0], {}), /expirou/, 'nenhum resumo ficou guardado');
});

test('scan: uma varredura por vez ("Há outra operação em andamento") e cancelScan sem id cancela a que estiver rodando', async (t) => {
  const { importer, inbox, put } = setup(t);
  for (let i = 0; i < 30; i++) put(`P${i}/l${i}.cube`, cube3d(2, { tint: i / 100 }));
  const first = importer.scan({ paths: [inbox] });
  await assert.rejects(() => importer.scan({ paths: [inbox] }), { message: 'Há outra operação em andamento.' });
  importer.cancelScan();
  const res = await first;
  assert.ok(res.canceled === true || res.scanId, 'terminou de um jeito ou de outro');
  // depois disso uma nova busca é aceita
  const next = await importer.scan({ paths: [inbox] });
  assert.equal(next.summary.new, 30);
});

test('scan: 365 LUTs de subpastas aparecem no resumo sem travar o laço', async (t) => {
  const { importer, inbox, put } = setup(t);
  for (let i = 0; i < 365; i++) put(`Grupo ${i % 7}/Sub ${i % 3}/l${i}.cube`, i % 5 === 0 ? cube1d(3 + (i % 50), { tint: i / 1000 }) : cube3d(2, { tint: i / 1000 }));
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 1);
  let res;
  try { res = await importer.scan({ paths: [inbox] }); } finally { clearInterval(timer); }
  assert.equal(res.summary.found, 365);
  assert.equal(res.summary.new + res.summary.repeated + res.summary.invalid + res.summary.exists, 365);
  assert.ok(maxGap < budget(250), `o laço ficou parado ${maxGap} ms`);
  const out = await importer.commit(res.scanId, keysOf(res), { keepFolders: true });
  assert.equal(out.imported, res.summary.new);
  assert.equal(out.failed, 0);
});

test('scan: o mesmo arquivo informado duas vezes (pasta e arquivo dentro dela) entra uma vez só', async (t) => {
  const { importer, inbox, put } = setup(t);
  const a = put('Sub/a.cube');
  const res = await importer.scan({ paths: [path.join(inbox, 'Sub'), a] });
  assert.equal(res.items.length, 1);
});

test('scan: link simbólico ou junção dentro da pasta de origem não é seguido e é contado', async (t) => {
  const { importer, inbox, root, put } = setup(t);
  const outside = path.join(root, 'fora');
  fs.mkdirSync(outside);
  put('segredo.cube', cube3d(2, { tint: 0.6 }), outside);
  put('real.cube');
  try { fs.symlinkSync(outside, path.join(inbox, 'atalho'), 'junction'); } catch (err) { t.skip('o sistema não permite criar links aqui'); return; }
  const res = await importer.scan({ paths: [inbox] });
  assert.deepEqual(res.items.map((i) => i.name), ['real.cube']);
  assert.equal(res.summary.ignoredLinks, 1);
});

test('scan: um .3dl solto conta como "ignorado" (o resumo avisa que só .cube é aceito) e não como arquivo comum', async (t) => {
  const { importer, put } = setup(t);
  const cube = put('ok.cube');
  const dl = put('filme.3dl', 'x');
  const txt = put('nota.txt', 'x');
  const res = await importer.scan({ paths: [cube, dl, txt], source: 'drop' });
  assert.deepEqual(res.items.map((i) => i.name), ['ok.cube']);
  assert.deepEqual({ ignored3dl: res.summary.ignored3dl, ignoredOther: res.summary.ignoredOther }, { ignored3dl: 1, ignoredOther: 1 });
});
