'use strict';

// Handlers IPC de LUTs (src/ipc/lutHandlers.js) registrados de verdade pelo channelRegistry, com o módulo
// "electron" simulado: caminho confiável só dentro da coleção, resultado { ok } da leitura, "Abrir pasta" e imagem de referência.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const registered = new Map();
const shellCalls = { openPath: [], reveal: [], trash: [] };
const behavior = { openPathResult: '', trashError: null, pickedPaths: null, dialogOptions: null };
const electron = {
  ipcMain: { handle: (channel, fn) => registered.set(channel, fn) },
  dialog: { showOpenDialog: async (_win, options) => { behavior.dialogOptions = options; return behavior.pickedPaths ? { canceled: false, filePaths: behavior.pickedPaths } : { canceled: true, filePaths: [] }; } },
  shell: {
    openPath: async (p) => { shellCalls.openPath.push(p); return behavior.openPathResult; },
    showItemInFolder: (p) => { shellCalls.reveal.push(p); },
    trashItem: async (p) => { shellCalls.trash.push(p); if (behavior.trashError) throw behavior.trashError; fs.unlinkSync(p); }
  },
  BrowserWindow: { getFocusedWindow: () => null }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : originalLoad.call(this, request, ...rest); };

const { APP_PAGE, CHANNELS } = require('../src/ipc/channelRegistry');
const LutManager = require('../src/core/luts/LutManager');
const registerLutHandlers = require('../src/ipc/lutHandlers');
const { cube3d, badCubes } = require('./helpers/cube-fixtures');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-lut-ipc-'));
const lutsDir = path.join(root, 'luts');
const outsideDir = path.join(root, 'fora');
fs.mkdirSync(lutsDir);
fs.mkdirSync(outsideDir);
const settings = { lutPreviewImage: '' };
const manager = new LutManager(lutsDir);
registerLutHandlers(manager, { settingsManager: { load: () => ({ ...settings }) } });

test.after(async () => {
  await manager._hashFill;
  if (manager._persistTimer) clearTimeout(manager._persistTimer);
  Module._load = originalLoad;
  fs.rmSync(root, { recursive: true, force: true });
});

const appUrl = pathToFileURL(APP_PAGE).href;
const event = { senderFrame: { parent: null, url: appUrl }, sender: { getType: () => 'window', getURL: () => appUrl } };
const call = (channel, ...args) => registered.get(channel)(event, ...args);
const put = (dir, name, content = cube3d(2)) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
const reset = () => {
  for (const dir of [lutsDir, outsideDir]) for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  shellCalls.openPath.length = 0; shellCalls.reveal.length = 0; shellCalls.trash.length = 0;
  behavior.openPathResult = ''; behavior.trashError = null; behavior.pickedPaths = null; behavior.dialogOptions = null;
  settings.lutPreviewImage = '';
  // cache de hash e de cabeçalhos zerado, sem deixar a gravação adiada do teste anterior cair dentro do próximo
  if (manager._persistTimer) { clearTimeout(manager._persistTimer); manager._persistTimer = null; }
  manager._hashesDirty = false;
  manager._hashes = null;
  manager._headers = null;
};
const NOT_INSIDE = /Esta LUT não está na pasta de LUTs/;

test('todos os canais luts:* da tabela têm handler registrado (e só eles)', () => {
  // luts:usage é do domínio das LUTs de projeto (projectLutHandlers.js; tests/project-lut-handlers.test.js)
  const wanted = Object.keys(CHANNELS).filter((c) => CHANNELS[c].domain === 'luts').sort();
  assert.deepEqual([...registered.keys()].sort(), wanted);
  assert.ok(wanted.includes('luts:list') && wanted.includes('luts:openFolder'));
  assert.ok(!wanted.includes('luts:get'), 'o canal antigo saiu da tabela');
});

test('luts:list devolve { folder, items, problems } sem esconder as demais LUTs', async () => {
  reset();
  put(lutsDir, 'a.cube');
  put(lutsDir, 'b.cube', cube3d(2, { tint: 0.1 }));
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));
  const res = await call('luts:list');
  assert.equal(res.folder, lutsDir);
  assert.deepEqual(res.items.map((i) => i.name).sort(), ['a.cube', 'b.cube']);
  assert.deepEqual(res.problems, []);
  await assert.rejects(() => call('luts:list', 'extra'), /demais/);
});

test('luts:parse: LUT da coleção vira { ok: true, ... } com a tabela', async () => {
  reset();
  const p = put(lutsDir, 'boa.cube', cube3d(3));
  const res = await call('luts:parse', p);
  assert.equal(res.ok, true);
  assert.equal(res.name, 'boa.cube');
  assert.equal(res.size, 3);
  assert.ok(res.data instanceof Float32Array, 'tabela compacta');
  assert.equal(res.data.length, 27 * 3);
  assert.equal(res.is1D, false);
  assert.equal(res.preview.length, 27);
});

test('luts:getHeader de LUT grande lê só o começo (totalEntries nulo); a pequena segue exata', async () => {
  reset();
  const big = put(lutsDir, 'grande.cube', cube3d(33));
  const header = await call('luts:getHeader', big);
  assert.deepEqual({ ok: header.ok, size: header.size, partial: header.partial, totalEntries: header.totalEntries, preview: header.preview.length }, { ok: true, size: 33, partial: true, totalEntries: null, preview: 100 });
  const small = put(lutsDir, 'pequena.cube', cube3d(3));
  assert.deepEqual({ partial: (await call('luts:getHeader', small)).partial, total: (await call('luts:getHeader', small)).totalEntries }, { partial: false, total: 27 });
});

test('luts:list traz kind, lutSize e title de cada LUT (cabeçalho curto)', async () => {
  reset();
  put(lutsDir, 'tres.cube', cube3d(5, { title: 'Filme' }));
  const res = await call('luts:list');
  assert.deepEqual([res.items[0].kind, res.items[0].lutSize, res.items[0].title], ['3D', 5, 'Filme']);
});

test('luts:getInfo: resumo da coleção para as Configurações (sem argumentos)', async () => {
  reset();
  put(lutsDir, 'a.cube');
  fs.mkdirSync(path.join(lutsDir, 'Pasta'));
  put(path.join(lutsDir, 'Pasta'), 'b.cube', cube3d(2, { tint: 0.2 }));
  const info = await call('luts:getInfo');
  assert.deepEqual(info, { folder: lutsDir, count: 2, groups: 1, problems: [], problemCount: 0 });
  await assert.rejects(() => call('luts:getInfo', 'extra'), /demais/);
});

test('luts:parse: conteúdo inválido volta como { ok: false, code, reason }, não como erro (e a recusa é a mesma da importação)', async () => {
  reset();
  for (const bad of badCubes()) {
    const p = put(lutsDir, `${bad.name}.cube`, bad.content);
    const res = await call('luts:parse', p);
    assert.equal(res.ok, false, bad.name);
    assert.equal(res.code, bad.code, bad.name);
    assert.equal(typeof res.reason, 'string');
    assert.equal(res.data, undefined);
  }
});

test('luts:parse, luts:getHeader, luts:load e luts:reveal NÃO vazam .cube de fora da coleção', async () => {
  reset();
  const outside = put(outsideDir, 'segredo.cube');
  put(lutsDir, 'dentro.cube');
  for (const channel of ['luts:parse', 'luts:getHeader', 'luts:load', 'luts:reveal']) {
    await assert.rejects(() => call(channel, outside), NOT_INSIDE, channel);
    await assert.rejects(() => call(channel, path.join(lutsDir, '..', 'fora', 'segredo.cube')), NOT_INSIDE, channel);
    await assert.rejects(() => call(channel, path.join(lutsDir, 'sumiu.cube')), /não foi encontrada/, channel);
    await assert.rejects(() => call(channel, 'relativo.cube'), /LUT/, channel);
    await assert.rejects(() => call(channel, path.join(lutsDir, 'dentro.txt')), /LUT/, channel);
  }
  assert.deepEqual(shellCalls.reveal, []);
});

test('luts:parse e luts:reveal recusam a própria pasta e pastas chamadas "x.cube"', async () => {
  reset();
  fs.mkdirSync(path.join(lutsDir, 'pasta.cube'));
  for (const channel of ['luts:parse', 'luts:getHeader', 'luts:load', 'luts:reveal']) {
    await assert.rejects(() => call(channel, path.join(lutsDir, 'pasta.cube')), NOT_INSIDE, channel);
  }
  // a própria pasta não passa nem pelo esquema (não termina em .cube)
  await assert.rejects(() => call('luts:reveal', lutsDir), /LUT/);
  assert.deepEqual(shellCalls.reveal, []);
});

test('luts:getHeader: cabeçalho tolerante (arquivo incompleto traz a contagem real) e { ok: false } só para o que não é texto', async () => {
  reset();
  const partial = put(lutsDir, 'incompleta.cube', 'TITLE "T"\nLUT_3D_SIZE 3\n0 0 0\n1 1 1\n');
  const bin = put(lutsDir, 'binaria.cube', Buffer.from([0x4c, 0x00, 0x55]));
  const header = await call('luts:getHeader', partial);
  assert.equal(header.ok, true);
  assert.equal(header.size, 3);
  assert.equal(header.totalEntries, 2);
  assert.equal(header.title, 'T');
  const res = await call('luts:getHeader', bin);
  assert.deepEqual({ ok: res.ok, code: res.code }, { ok: false, code: 'BINARY' });
});

test('luts:load: conteúdo bruto da LUT da coleção, com corte em 2 MB', async () => {
  reset();
  const small = put(lutsDir, 'pequena.cube', cube3d(2));
  const res = await call('luts:load', small);
  assert.equal(res.truncated, false);
  assert.match(res.rawContent, /LUT_3D_SIZE 2/);
  const big = put(lutsDir, 'grande.cube', `# ${'x'.repeat(3 * 1024 * 1024)}\n`);
  const cut = await call('luts:load', big);
  assert.equal(cut.truncated, true);
  assert.equal(cut.totalBytes, fs.statSync(big).size);
  assert.ok(cut.rawContent.length <= 2 * 1024 * 1024);
});

test('luts:reveal: mostra o arquivo da coleção no gerenciador de arquivos', async () => {
  reset();
  const p = put(lutsDir, 'a.cube');
  assert.equal(await call('luts:reveal', p), true);
  assert.deepEqual(shellCalls.reveal, [p]);
});

test('luts:openFolder: abre a pasta da coleção (cria se não existir), sem argumentos e sem tocar em arquivos', async () => {
  reset();
  assert.equal(await call('luts:openFolder'), true);
  assert.deepEqual(shellCalls.openPath, [lutsDir]);
  assert.deepEqual(shellCalls.reveal, []);

  fs.rmSync(lutsDir, { recursive: true, force: true });
  assert.equal(await call('luts:openFolder'), true);
  assert.ok(fs.existsSync(lutsDir), 'a pasta foi criada');
  await assert.rejects(() => call('luts:openFolder', 'a', 'b'), /demais/);
});

test('luts:openFolder com relPath: abre só uma subpasta comum da coleção; o resto vira mensagem amigável', async () => {
  reset();
  put(lutsDir, 'raiz.cube');
  fs.mkdirSync(path.join(lutsDir, 'Looks', 'Rush'), { recursive: true });
  put(path.join(lutsDir, 'Looks', 'Rush'), 'a.cube');
  assert.equal(await call('luts:openFolder', 'Looks/Rush'), true);
  assert.deepEqual(shellCalls.openPath, [path.join(lutsDir, 'Looks', 'Rush')]);
  assert.equal(await call('luts:openFolder', ''), true, 'vazio = a raiz da coleção');
  assert.equal(shellCalls.openPath[1], lutsDir);

  const before = shellCalls.openPath.length;
  const outside = path.join(root, 'fora');
  const bad = ['Sumiu', 'raiz.cube', '..', '../fora', 'C:\\Windows', '\\\\servidor\\pasta', 'Looks/../..', '.', 'CON'];
  for (const relPath of bad) {
    await assert.rejects(() => call('luts:openFolder', relPath), (err) => /Esta pasta (não existe mais|não está na pasta de LUTs)/.test(err.message), relPath);
  }
  assert.equal(shellCalls.openPath.length, before, 'nada foi aberto');
  assert.ok(!shellCalls.openPath.includes(outside));
});

test('luts:openFolder: falha do sistema vira mensagem amigável (sem texto cru) e a pasta no lugar de arquivo também', async () => {
  reset();
  const friendly = (err) => err.message === 'Não foi possível abrir a pasta das LUTs.';
  behavior.openPathResult = 'Failed to open path: ERROR_ACCESS_DENIED';
  await assert.rejects(() => call('luts:openFolder'), friendly);
  behavior.openPathResult = '';
  const realDir = manager.lutsDir;
  const fileInPlace = path.join(root, 'arquivo-no-lugar-da-pasta');
  fs.writeFileSync(fileInPlace, 'sou um arquivo');
  manager.lutsDir = fileInPlace;
  try {
    await assert.rejects(() => call('luts:openFolder'), friendly);
    assert.deepEqual(shellCalls.openPath.filter((p) => p === fileInPlace), [], 'nunca tenta abrir o arquivo');
  } finally { manager.lutsDir = realDir; }
});

test('luts:delete: envia para a Lixeira só o que está na coleção; falha da Lixeira não vaza texto cru', async () => {
  reset();
  const p = put(lutsDir, 'a.cube');
  const outside = put(outsideDir, 'fora.cube');
  await assert.rejects(() => call('luts:delete', outside), NOT_INSIDE);
  await assert.rejects(() => call('luts:delete', lutsDir), NOT_INSIDE);
  assert.deepEqual(shellCalls.trash, []);
  assert.ok(fs.existsSync(outside));

  behavior.trashError = new Error('Failed to move item to trash: EPERM raw');
  await assert.rejects(() => call('luts:delete', p), (err) => err.message === 'Não foi possível mover a LUT para a Lixeira.');
  assert.ok(fs.existsSync(p));
  behavior.trashError = null;
  assert.equal(await call('luts:delete', p), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(await call('luts:delete', p), false, 'já não existe');
});

test('luts:rename: nome reservado do Windows e caracteres proibidos são recusados com o motivo', async () => {
  reset();
  const p = put(lutsDir, 'a.cube');
  await assert.rejects(() => call('luts:rename', p, 'CON'), /reservado pelo Windows/);
  await assert.rejects(() => call('luts:rename', p, 'a:b'), /caracteres/);
  assert.equal(await call('luts:rename', p, 'Novo nome'), true);
  assert.ok(fs.existsSync(path.join(lutsDir, 'Novo nome.cube')));
});

test('luts:rename, luts:import, luts:delete e luts:reveal: falha do disco ou do sistema vira mensagem em português, sem caminho nem texto cru', async () => {
  reset();
  const raw = "EBUSY: resource busy or locked, rename 'D:\\Segredo\\a.cube' -> 'D:\\Segredo\\b.cube'";
  const noRaw = (message) => (err) => err.message === message && !/EBUSY|ENOSPC|EPERM|Segredo|raw/.test(err.message);
  const p = put(lutsDir, 'a.cube');

  // renomear: o renameSync recusado pelo sistema (arquivo em uso) é explicado; o arquivo continua no lugar
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error(raw); };
  try {
    await assert.rejects(() => call('luts:rename', p, 'Outro'), noRaw('Não foi possível renomear a LUT. Feche os programas que a estejam usando e tente de novo.'));
  } finally { fs.renameSync = realRename; }
  assert.ok(fs.existsSync(p));
  // erros que o próprio gerenciador já escreve em português continuam como estão
  put(lutsDir, 'b.cube', cube3d(2, { tint: 0.3 }));
  await assert.rejects(() => call('luts:rename', p, 'b'), (err) => err.message === 'Já existe um arquivo com esse nome.');

  // importar: pasta da coleção que não pode ser criada, e falha inesperada qualquer
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = () => { throw new Error('ENOSPC: no space left on device, mkdir \'D:\\Segredo\''); };
  try {
    await assert.rejects(() => call('luts:import', [put(outsideDir, 'n.cube')]), (err) => /^Não foi possível acessar a pasta de LUTs/.test(err.message) && !/ENOSPC|Segredo/.test(err.message));
  } finally { fs.mkdirSync = realMkdir; }
  const realImport = manager.importFiles;
  manager.importFiles = () => { throw new Error('EIO raw Segredo'); };
  try {
    await assert.rejects(() => call('luts:import', [put(outsideDir, 'n2.cube')]), noRaw('Não foi possível importar as LUTs.'));
  } finally { manager.importFiles = realImport; }

  // excluir e mostrar: falha inesperada do gerenciador ou do sistema também vira mensagem amigável
  const realDelete = manager.delete;
  manager.delete = async () => { throw new Error('EPERM raw Segredo'); };
  try { await assert.rejects(() => call('luts:delete', p), noRaw('Não foi possível excluir a LUT.')); } finally { manager.delete = realDelete; }
  const realReveal = electron.shell.showItemInFolder;
  electron.shell.showItemInFolder = () => { throw new Error('EPERM raw Segredo'); };
  try { await assert.rejects(() => call('luts:reveal', p), noRaw('Não foi possível mostrar a LUT na pasta.')); } finally { electron.shell.showItemInFolder = realReveal; }
  await assert.rejects(() => call('luts:reveal', path.join(outsideDir, 'n.cube')), NOT_INSIDE);
});

test('luts:import: sem caminhos abre o seletor (cancelar devolve false); com caminhos valida como a leitura', async () => {
  reset();
  assert.equal(await call('luts:import'), false);
  const good = put(outsideDir, 'ok.cube');
  const bad = put(outsideDir, 'mista.cube', badCubes().find((b) => b.name === '1d-e-3d-juntos').content);
  const res = await call('luts:import', [good, bad]);
  assert.deepEqual(res.imported.map((i) => i.name), ['ok.cube']);
  assert.equal(res.invalid[0].name, 'mista.cube');
  assert.match(res.invalid[0].reason, /1D e 3D/);
  behavior.pickedPaths = [put(outsideDir, 'outra.cube', cube3d(2, { tint: 0.4 }))];
  const picked = await call('luts:import');
  assert.deepEqual(picked.imported.map((i) => i.name), ['outra.cube']);
});

test('LUT dentro de subpastas: ler, mostrar, renomear e excluir funcionam em qualquer nível (e só dentro da coleção)', async () => {
  reset();
  fs.mkdirSync(path.join(lutsDir, 'A', 'B', 'C'), { recursive: true });
  const nested = put(path.join(lutsDir, 'A', 'B', 'C'), 'fundo.cube', cube3d(3));
  const parsed = await call('luts:parse', nested);
  assert.deepEqual({ ok: parsed.ok, size: parsed.size }, { ok: true, size: 3 });
  assert.equal((await call('luts:getHeader', nested)).ok, true);
  assert.match((await call('luts:load', nested)).rawContent, /LUT_3D_SIZE 3/);
  assert.equal(await call('luts:reveal', nested), true);
  assert.deepEqual(shellCalls.reveal, [nested]);
  assert.equal(await call('luts:rename', nested, 'Novo nome'), true);
  const renamed = path.join(lutsDir, 'A', 'B', 'C', 'Novo nome.cube');
  assert.ok(fs.existsSync(renamed));
  const items = (await call('luts:list')).items;
  assert.deepEqual(items.map((i) => [i.relPath, i.folder, i.depth]), [['A/B/C/Novo nome.cube', 'A/B/C', 3]]);
  assert.equal(await call('luts:delete', renamed), true);
  assert.deepEqual(shellCalls.trash, [renamed]);
  // fora da coleção continua recusado, mesmo com o mesmo nome de pasta
  const outside = path.join(outsideDir, 'A', 'B', 'C');
  fs.mkdirSync(outside, { recursive: true });
  const stranger = put(outside, 'fundo.cube');
  for (const channel of ['luts:parse', 'luts:getHeader', 'luts:load', 'luts:reveal', 'luts:delete']) {
    await assert.rejects(() => call(channel, stranger), NOT_INSIDE, channel);
  }
});

test('luts:import: caminho de rede vindo da tela é recusado (conta como inválido) e nada é copiado', async () => {
  reset();
  const res = await call('luts:import', ['\\\\servidor\\pasta\\a.cube', '//servidor/pasta/b.cube', 'relativo.cube', put(outsideDir, 'boa.cube')]);
  assert.deepEqual(res.imported.map((i) => i.name), ['boa.cube']);
  assert.deepEqual(res.invalid, []);
  assert.deepEqual(fs.readdirSync(lutsDir).filter((n) => !n.startsWith('.')), ['boa.cube']);
});

/** Evento com `sender.send` registrando o progresso que o main manda à tela. */
function eventWithSender() {
  const sent = [];
  return { sent, event: { ...event, sender: { ...event.sender, send: (channel, payload) => sent.push([channel, payload]), isDestroyed: () => false } } };
}
const callWith = (ev, channel, ...args) => registered.get(channel)(ev, ...args);

test('luts:scan: o diálogo abre no main (pasta por padrão, arquivos no modo "files"), cancelar devolve { canceled } e nada vai para a coleção', async () => {
  reset();
  assert.deepEqual(await call('luts:scan'), { canceled: true });
  assert.deepEqual(behavior.dialogOptions.properties, ['openDirectory']);
  assert.deepEqual(await call('luts:scan', undefined, { mode: 'files' }), { canceled: true });
  assert.deepEqual(behavior.dialogOptions.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(behavior.dialogOptions.filters, [{ name: 'LUTs', extensions: ['cube'] }]);

  const inbox = path.join(outsideDir, 'inbox');
  fs.mkdirSync(inbox);
  put(inbox, 'a.cube');
  behavior.pickedPaths = [inbox];
  const { event: ev, sent } = eventWithSender();
  const res = await callWith(ev, 'luts:scan');
  assert.equal(res.summary.new, 1);
  assert.equal(res.sourceName, 'inbox');
  assert.equal(sent[0][0], 'luts:scanProgress', 'o progresso vai para a janela que pediu');
  assert.equal(sent[0][1].scanId, res.scanId);
  assert.deepEqual(fs.readdirSync(lutsDir), [], 'varrer não copia nada');
});

test('luts:scan com caminhos soltos na tela: valida cada um (rede e relativo) e nunca abre o diálogo', async () => {
  reset();
  const inbox = path.join(outsideDir, 'inbox');
  fs.mkdirSync(inbox);
  put(inbox, 'a.cube');
  const res = await call('luts:scan', [inbox]);
  assert.equal(res.summary.found, 1);
  assert.equal(behavior.dialogOptions, null, 'sem diálogo');
  await assert.rejects(() => call('luts:scan', ['\\\\servidor\\pasta']), /Pastas de rede/);
  await assert.rejects(() => call('luts:scan', [lutsDir]), /Esta já é a pasta das LUTs/);
  await assert.rejects(() => call('luts:scan', [[]]), /./, 'o esquema recusa o que não é lista de textos');
});

test('luts:importScanned: copia só as chaves marcadas (a tela nunca manda caminho) e devolve o resumo; progresso pelo evento', async () => {
  reset();
  const inbox = path.join(outsideDir, 'inbox');
  fs.mkdirSync(path.join(inbox, 'Sub'), { recursive: true });
  put(inbox, 'a.cube', cube3d(2, { tint: 0.1 }));
  put(path.join(inbox, 'Sub'), 'b.cube', cube3d(2, { tint: 0.2 }));
  put(path.join(inbox, 'Sub'), 'c.cube', cube3d(2, { tint: 0.3 }));
  const scan = await call('luts:scan', [inbox]);
  const keys = scan.items.filter((i) => i.name !== 'c.cube').map((i) => i.key);
  const { event: ev, sent } = eventWithSender();
  const out = await callWith(ev, 'luts:importScanned', scan.scanId, keys, { keepFolders: true, rootGroup: 'inbox' });
  assert.deepEqual({ imported: out.imported, failed: out.failed, canceled: out.canceled }, { imported: 2, failed: 0, canceled: false });
  assert.ok(fs.existsSync(path.join(lutsDir, 'inbox', 'a.cube')));
  assert.ok(fs.existsSync(path.join(lutsDir, 'inbox', 'Sub', 'b.cube')));
  assert.ok(!fs.existsSync(path.join(lutsDir, 'inbox', 'Sub', 'c.cube')), 'a não marcada ficou de fora');
  assert.ok(sent.some(([channel]) => channel === 'luts:importProgress'));
  await assert.rejects(() => call('luts:importScanned', scan.scanId, keys, {}), { message: 'Esta importação já foi iniciada.' });
  await assert.rejects(() => call('luts:importScanned', 'inexistente', [0]), /expirou/);
  await assert.rejects(() => call('luts:importScanned', scan.scanId, [0], { rootGroup: 'a/b' }), /.*/);
  assert.equal(await call('luts:cancelScan', scan.scanId), true);
  assert.equal(await call('luts:cancelScan'), true);
  assert.equal(await call('luts:cancelImport'), true);
});

test('luts:scan / luts:importScanned: falha inesperada vira mensagem amigável, sem texto cru de exceção', async () => {
  reset();
  const inbox = path.join(outsideDir, 'inbox');
  fs.mkdirSync(inbox);
  put(inbox, 'a.cube');
  const realIndex = manager.hashIndex;
  manager.hashIndex = async () => { throw new Error('EIO: i/o error raw, scandir'); };
  try {
    await assert.rejects(() => call('luts:scan', [inbox]), (err) => err.message === 'Não foi possível procurar as LUTs.');
  } finally { manager.hashIndex = realIndex; }
  const scan = await call('luts:scan', [inbox]);
  manager.hashIndex = async () => { throw new Error('EIO: i/o error raw'); };
  try {
    await assert.rejects(() => call('luts:importScanned', scan.scanId, [0], {}), (err) => err.message === 'Não foi possível importar as LUTs.');
  } finally { manager.hashIndex = realIndex; }
});

test('luts:renameFolder e luts:deleteFolder: qualquer nível, só dentro da coleção, só as LUTs vão para a Lixeira', async () => {
  reset();
  put(lutsDir, 'raiz.cube', cube3d(2, { tint: 0.9 }));
  fs.mkdirSync(path.join(lutsDir, 'Looks', 'Rush'), { recursive: true });
  put(path.join(lutsDir, 'Looks', 'Rush'), 'a.cube', cube3d(2, { tint: 0.1 }));
  put(path.join(lutsDir, 'Looks', 'Rush'), 'notas.txt', 'x');
  put(path.join(lutsDir, 'Looks'), 'b.cube', cube3d(2, { tint: 0.2 }));

  assert.equal(await call('luts:renameFolder', 'Looks/Rush', 'Sprint'), true);
  assert.ok(fs.existsSync(path.join(lutsDir, 'Looks', 'Sprint', 'a.cube')));
  await assert.rejects(() => call('luts:renameFolder', 'Looks/Sprint', 'a/b'), /caracteres/);
  await assert.rejects(() => call('luts:renameFolder', 'Looks/Sprint', 'CON'), /reservado pelo Windows/);
  await assert.rejects(() => call('luts:renameFolder', '..', 'x'), /não está na pasta de LUTs/);
  await assert.rejects(() => call('luts:renameFolder', '', 'x'), /obrigatório/);

  assert.deepEqual(await call('luts:deleteFolder', 'Looks/Sprint', true), { luts: 1, others: 1 });
  assert.deepEqual(shellCalls.trash, [], 'só contou');
  const res = await call('luts:deleteFolder', 'Looks/Sprint');
  assert.deepEqual(res, { trashed: 1, luts: 1, others: 1, remaining: 1, folderRemoved: false });
  assert.deepEqual(shellCalls.trash, [path.join(lutsDir, 'Looks', 'Sprint', 'a.cube')]);
  assert.ok(fs.existsSync(path.join(lutsDir, 'Looks', 'Sprint', 'notas.txt')));
  await assert.rejects(() => call('luts:deleteFolder', ''), /obrigatório/);
  await assert.rejects(() => call('luts:deleteFolder', '..'), /não está na pasta de LUTs/);
  assert.ok(fs.existsSync(path.join(lutsDir, 'raiz.cube')));

  behavior.trashError = new Error('Failed to move item to trash: EPERM raw');
  await assert.rejects(() => call('luts:deleteFolder', 'Looks'), (err) => err.message === 'Não foi possível mover as LUTs para a Lixeira.');
});

test('luts:getReferenceImage: só a imagem salva nas Configurações, nunca outro arquivo nem caminho de rede', async () => {
  reset();
  const png = put(outsideDir, 'ref.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const other = put(outsideDir, 'outra.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  const text = put(outsideDir, 'segredo.txt', 'senha');

  assert.equal(await call('luts:getReferenceImage', png), null, 'nada salvo nas Configurações');
  settings.lutPreviewImage = png;
  const dataUrl = await call('luts:getReferenceImage', png);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(dataUrl.split(',')[1], 'base64').toString('hex'), '89504e47');
  assert.equal(await call('luts:getReferenceImage', other), null, 'outra imagem do disco');
  settings.lutPreviewImage = text;
  assert.equal(await call('luts:getReferenceImage', text), null, 'não é imagem');
  settings.lutPreviewImage = '\\\\servidor\\pasta\\ref.png';
  assert.equal(await call('luts:getReferenceImage', '\\\\servidor\\pasta\\ref.png'), null, 'caminho de rede');
  settings.lutPreviewImage = '//servidor/pasta/ref.png';
  assert.equal(await call('luts:getReferenceImage', '//servidor/pasta/ref.png'), null);
  assert.equal(await call('luts:getReferenceImage', 'relativo.png'), null);
  assert.equal(await call('luts:getReferenceImage'), null);
  settings.lutPreviewImage = png;
  if (process.platform === 'win32') assert.match(await call('luts:getReferenceImage', png.toUpperCase().replace(/\.PNG$/, '.png')), /^data:image\/png/, 'o Windows não diferencia maiúsculas');
});

test('luts:deleteMany: só as LUTs da coleção vão para a Lixeira; o que está fora é recusado sem impedir as outras; erro sem texto cru', async () => {
  reset();
  const a = put(lutsDir, 'a.cube', cube3d(2, { tint: 0.1 }));
  fs.mkdirSync(path.join(lutsDir, 'Looks'));
  const b = put(path.join(lutsDir, 'Looks'), 'b.cube', cube3d(2, { tint: 0.2 }));
  const fora = put(outsideDir, 'fora.cube', cube3d(2, { tint: 0.3 }));
  const sumiu = path.join(lutsDir, 'sumiu.cube');

  const res = await call('luts:deleteMany', [a, fora, b, sumiu]);
  assert.deepEqual(res, { trashed: 2, missing: 1, failed: [{ path: fora, reason: 'Esta LUT não está na pasta de LUTs.' }] });
  assert.deepEqual(shellCalls.trash, [a, b]);
  assert.ok(fs.existsSync(fora), 'o arquivo de fora continua lá');

  const c = put(lutsDir, 'c.cube', cube3d(2, { tint: 0.4 }));
  behavior.trashError = new Error('Failed to move item to trash: EPERM raw');
  const falha = await call('luts:deleteMany', [c]);
  assert.deepEqual(falha, { trashed: 0, missing: 0, failed: [{ path: c, reason: 'Não foi possível mover a LUT para a Lixeira.' }] });
  assert.ok(fs.existsSync(c));
  await assert.rejects(() => call('luts:deleteMany', []), /ao menos 1/);
  await assert.rejects(() => call('luts:deleteMany', ['relativo.cube']), /LUT/);
  await assert.rejects(() => call('luts:deleteMany', [path.join(lutsDir, 'x.txt')]), /LUT/);
});
