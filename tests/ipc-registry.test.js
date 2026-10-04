'use strict';

// Registrador central de canais IPC (RK-010): esquemas por tipo, remetente (página do app x webview/
// frames de terceiros), estratégias de erro por domínio e garantia de que TODO canal tem esquema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { t, validateArgs, SchemaError, describeSpec } = require('../src/ipc/schema');
const { createRegistry, senderProblem, isAppPageUrl, listChannels, CHANNELS, EVENTS, APP_PAGE, MSG_ORIGIN } = require('../src/ipc/channelRegistry');

const ROOT = path.join(__dirname, '..');
const APP_URL = pathToFileURL(APP_PAGE).href;

// --- utilidades ------------------------------------------------------------------------------

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}

function appEvent(over = {}) {
  const url = over.url || APP_URL;
  return {
    senderFrame: { url, parent: null, ...(over.frame || {}) },
    sender: { getType: () => over.type || 'window', getURL: () => over.senderUrl || url }
  };
}

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof SchemaError && (!re || re.test(e.message)));
const one = (spec, value) => validateArgs([spec], [value])[0];

function tmpFile(name = 'f.txt', content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-ipc-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { dir, file };
}

// --- esquemas: um caso por tipo --------------------------------------------------------------

test('esquema: string (tipo, limite, enum, nonBlank, NUL, obrigatório x optional)', () => {
  assert.equal(one(t.string({ name: 'x' }), 'abc'), 'abc');
  rejects(() => one(t.string({ name: 'x' }), 5), /texto/);
  rejects(() => one(t.string({ max: 3 }), 'abcd'), /muito longo/);
  rejects(() => one(t.string({ enum: ['a', 'b'] }), 'c'), /opção válida/);
  assert.equal(one(t.string({ enum: ['a', 'b'] }), 'b'), 'b');
  rejects(() => one(t.string({ nonBlank: true }), '   '), /vazio/);
  rejects(() => one(t.string({ min: 1 }), ''), /obrigatório/);
  rejects(() => one(t.string(), 'a\0b'));
  rejects(() => one(t.string({ pattern: /^\d+$/ }), 'abc'));
  rejects(() => one(t.string({ name: 'x' }), undefined), /obrigatório/);
  rejects(() => one(t.string({ name: 'x' }), null), /obrigatório/);
  assert.equal(one(t.string({ optional: true }), undefined), undefined);
  assert.equal(one(t.string({ optional: true }), null), null);
  assert.equal(one(t.string({ optional: true, allowEmpty: true, min: 1 }), ''), '');
});

test('esquema: number, int e id', () => {
  assert.equal(one(t.number(), 1.5), 1.5);
  rejects(() => one(t.number(), '1'), /número/);
  rejects(() => one(t.number(), NaN));
  rejects(() => one(t.number(), Infinity));
  rejects(() => one(t.int(), 1.5), /inteiro/);
  rejects(() => one(t.number({ min: 0 }), -1), /mínimo/);
  rejects(() => one(t.number({ max: 10 }), 11), /máximo/);
  assert.equal(one(t.id(), 7), 7);
  assert.equal(one(t.id(), '12'), '12');
  rejects(() => one(t.id(), 0), /positivo/);
  rejects(() => one(t.id(), -3));
  rejects(() => one(t.id(), 1.2));
  rejects(() => one(t.id(), '1; DROP TABLE'));
  rejects(() => one(t.id(), {}));
  rejects(() => one(t.id(), Number.MAX_SAFE_INTEGER + 10));
});

test('esquema: boolean', () => {
  assert.equal(one(t.boolean(), false), false);
  rejects(() => one(t.boolean(), 0), /verdadeiro ou falso/);
  rejects(() => one(t.boolean(), 'true'));
});

test('esquema: object (tipo, forma, strict, limite de chaves) e array (itens, limites)', () => {
  const spec = t.object({ a: t.string({ max: 2 }), b: t.id({ optional: true }) });
  assert.deepEqual(one(spec, { a: 'x', extra: 1 }), { a: 'x', extra: 1 }); // chaves extras passam (o serviço decide)
  rejects(() => one(spec, { a: 'xyz' }), /muito longo/);
  rejects(() => one(spec, {}), /obrigatório/);
  rejects(() => one(spec, []), /objeto/);
  rejects(() => one(spec, 'texto'), /objeto/);
  rejects(() => one(t.object({ a: t.string({ optional: true }) }, { strict: true }), { b: 1 }), /não permitidos/);
  rejects(() => one(t.object({}, { maxKeys: 2 }), { a: 1, b: 2, c: 3 }), /campos demais/);
  const arr = t.array(t.id(), { max: 3, label: 'Lista' });
  assert.deepEqual(one(arr, [1, 2]), [1, 2]);
  rejects(() => one(arr, [1, 2, 3, 4]), /máximo/);
  rejects(() => one(arr, [1, 'x']));
  rejects(() => one(arr, 'texto'), /lista/);
  rejects(() => one(t.array(t.id(), { min: 2 }), [1]), /ao menos/);
});

test('esquema: oneOf e any (o motivo é obrigatório)', () => {
  const spec = t.oneOf([t.int(), t.string({ max: 3 })]);
  assert.equal(one(spec, 4), 4);
  assert.equal(one(spec, 'ab'), 'ab');
  rejects(() => one(spec, 'abcd'));
  rejects(() => one(spec, {}));
  assert.throws(() => t.any(''), /motivo/);
  assert.throws(() => t.any(), /motivo/);
  const any = t.any('valor livre justificado no teste', { name: 'v' });
  assert.deepEqual(one(any, { qualquer: 1 }), { qualquer: 1 });
  assert.equal(one(any, undefined), undefined);
});

test('esquema: caminhos — relativo recusado, absoluto normalizado, arquivo/pasta/.cube', () => {
  const { dir, file } = tmpFile('a.txt');
  rejects(() => one(t.absPath(), 'relativo/arquivo.txt'), /absoluto/);
  rejects(() => one(t.absPath(), '..\\x'), /absoluto/);
  rejects(() => one(t.absPath(), 5));
  rejects(() => one(t.absPath(), `${file}\0.exe`));
  assert.equal(one(t.absPath(), file), path.resolve(file));
  assert.equal(one(t.file(), file), path.resolve(file));
  rejects(() => one(t.file(), dir), /não é um arquivo/);
  rejects(() => one(t.file(), path.join(dir, 'nao-existe.txt')), /não encontrado/);
  rejects(() => one(t.file(), 'a.txt'), /absoluto/);
  assert.equal(one(t.dir(), dir), path.resolve(dir));
  rejects(() => one(t.dir(), file), /não é uma pasta/);
  rejects(() => one(t.dir(), path.parse(dir).root), /raiz de um drive/);
  assert.equal(one(t.searchDir(), path.parse(dir).root), path.resolve(path.parse(dir).root));
  rejects(() => one(t.searchDir(), file), /não é uma pasta/);
  const cube = path.join(dir, 'x.cube');
  assert.equal(one(t.cube(), cube), cube);
  rejects(() => one(t.cube(), path.join(dir, 'x.exe')), /LUT/);
  rejects(() => one(t.cube(), 'x.cube'), /LUT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateArgs: recusa argumentos extras e aceita os opcionais ausentes', () => {
  const schema = [t.string({ name: 'a' }), t.int({ name: 'b', optional: true })];
  assert.deepEqual(validateArgs(schema, ['x']), ['x', undefined]);
  assert.deepEqual(validateArgs(schema, ['x', 2]), ['x', 2]);
  rejects(() => validateArgs(schema, ['x', 2, 3]), /demais/);
  rejects(() => validateArgs([], ['x']), /demais/);
  assert.deepEqual(validateArgs([], []), []);
  assert.deepEqual(validateArgs(schema, ['x', 2, 3], { maxArgs: 3 }), ['x', 2, 3]);
});

test('describeSpec resume o esquema', () => {
  assert.match(describeSpec(t.id({ name: 'id', optional: true })), /id: id\?/);
  assert.match(describeSpec(t.string({ name: 's', max: 10 })), /string≤10/);
});

// --- remetente -------------------------------------------------------------------------------

test('remetente: página do app (frame principal) é aceita, com consulta/âncora e no Windows sem diferenciar caixa', () => {
  assert.equal(senderProblem(appEvent()), null);
  assert.equal(senderProblem(appEvent({ url: `${APP_URL}?x=1#y` })), null);
  if (process.platform === 'win32') assert.equal(senderProblem(appEvent({ url: APP_URL.toUpperCase().replace('FILE:', 'file:') })), null);
  assert.equal(isAppPageUrl(APP_URL), true);
});

test('remetente: webview, frames de terceiros e páginas externas são recusados', () => {
  // o <webview> do YouTube Studio
  assert.match(senderProblem(appEvent({ url: 'https://studio.youtube.com/channel/UC1', type: 'webview' })), /webview/);
  assert.ok(senderProblem(appEvent({ url: 'https://studio.youtube.com/', type: 'window' })));
  assert.ok(senderProblem(appEvent({ url: 'https://accounts.google.com/signin' })));
  // webview apontando para a própria página do app continua recusado pelo tipo
  assert.match(senderProblem(appEvent({ type: 'webview' })), /webview/);
  // sub-frame (iframe) da página do app
  assert.match(senderProblem(appEvent({ frame: { parent: { url: APP_URL } } })), /frame principal/);
  // outra página file:// e esquemas perigosos
  assert.ok(senderProblem(appEvent({ url: pathToFileURL(path.join(ROOT, 'renderer', 'screens', 'home.html')).href })));
  assert.ok(senderProblem(appEvent({ url: pathToFileURL(path.join(os.tmpdir(), 'renderer', 'index.html')).href })));
  assert.ok(senderProblem(appEvent({ url: 'about:blank' })));
  assert.ok(senderProblem(appEvent({ url: 'data:text/html,<script></script>' })));
  assert.ok(senderProblem(appEvent({ url: 'devtools://devtools/bundled/x.html' })));
  assert.ok(senderProblem(appEvent({ url: `https://evil.example/${APP_URL}` })));
  // URL do WebContents diferente da do frame
  assert.ok(senderProblem(appEvent({ senderUrl: 'https://studio.youtube.com/' })));
  // sem frame / sem remetente / evento vazio
  assert.ok(senderProblem({ sender: {} }));
  assert.ok(senderProblem({ senderFrame: { url: APP_URL, parent: null } }));
  assert.ok(senderProblem(undefined));
});

// --- registrador -----------------------------------------------------------------------------

function mkTable(entries) {
  const table = {};
  for (const [channel, def] of Object.entries(entries)) table[channel] = { domain: 'teste', args: [], returns: 'x', error: 'throw', api: [], ...def };
  return table;
}

function setup(entries, opts = {}) {
  const ipc = fakeIpc();
  const logs = [];
  const logger = { warn: (...a) => logs.push(a) };
  const reg = createRegistry({ ipcMain: ipc, table: mkTable(entries), logger, ...opts });
  return { ipc, reg, logs, call: (ch, event, ...args) => ipc.handlers.get(ch)(event, ...args) };
}

test('registrador: chama o handler com os argumentos validados e normalizados', async () => {
  const { dir, file } = tmpFile();
  const { reg, call } = setup({ 'a:b': { args: [t.file({ name: 'f' }), t.int({ name: 'n', optional: true })] } });
  reg.handle('a:b', (ev, f, n) => ({ f, n, ev: !!ev }));
  assert.deepEqual(await call('a:b', appEvent(), file), { f: path.resolve(file), n: undefined, ev: true });
  await assert.rejects(() => call('a:b', appEvent(), 'relativo.txt'), /absoluto/);
  await assert.rejects(() => call('a:b', appEvent(), file, 1, 2), /demais/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registrador: remetente inválido NÃO chega ao handler (webview do YouTube Studio recusado)', async () => {
  let called = 0;
  const { reg, call, logs } = setup({ 'a:b': {} });
  reg.handle('a:b', () => { called++; return 'segredo'; });
  const ev = appEvent({ url: 'https://studio.youtube.com/channel/x', type: 'webview' });
  await assert.rejects(() => call('a:b', ev), (e) => e.message === MSG_ORIGIN && e.code === 'EFORBIDDEN');
  await assert.rejects(() => call('a:b', undefined), (e) => e.message === MSG_ORIGIN);
  assert.equal(called, 0);
  assert.equal(logs.length, 2);
  assert.equal(await call('a:b', appEvent()), 'segredo');
  assert.equal(called, 1);
});

test('registrador: estratégia de erro do domínio (throw, wrap, success, null, empty)', async () => {
  const bad = appEvent({ type: 'webview', url: 'https://x.test/' });
  const { reg, call } = setup({
    'e:throw': { error: 'throw', args: [t.int({ name: 'n' })] },
    'e:wrap': { error: 'wrap', args: [t.int({ name: 'n' })] },
    'e:success': { error: 'success', args: [t.int({ name: 'n' })] },
    'e:null': { error: 'null', args: [t.int({ name: 'n' })] },
    'e:empty': { error: 'empty', args: [t.int({ name: 'n' })] }
  });
  for (const ch of ['e:throw', 'e:wrap', 'e:success', 'e:null', 'e:empty']) reg.handle(ch, (_, n) => n * 2);
  // argumento inválido
  await assert.rejects(() => call('e:throw', appEvent(), 'x'), /número/);
  assert.deepEqual(await call('e:wrap', appEvent(), 'x'), { ok: false, error: 'n deve ser um número.', code: 'EINVALID' });
  assert.deepEqual(await call('e:success', appEvent(), 'x'), { success: false, error: 'n deve ser um número.' });
  assert.equal(await call('e:null', appEvent(), 'x'), null);
  assert.deepEqual(await call('e:empty', appEvent(), 'x'), []);
  // remetente inválido
  await assert.rejects(() => call('e:throw', bad, 2), (e) => e.message === MSG_ORIGIN);
  assert.deepEqual(await call('e:wrap', bad, 2), { ok: false, error: MSG_ORIGIN, code: 'EFORBIDDEN' });
  assert.deepEqual(await call('e:success', bad, 2), { success: false, error: MSG_ORIGIN });
  assert.equal(await call('e:null', bad, 2), null);
  assert.deepEqual(await call('e:empty', bad, 2), []);
  // sucesso: só 'wrap' envelopa
  assert.equal(await call('e:throw', appEvent(), 2), 4);
  assert.deepEqual(await call('e:wrap', appEvent(), 2), { ok: true, data: 4 });
  assert.equal(await call('e:success', appEvent(), 2), 4);
});

test('registrador: erros do próprio handler — wrap converte, os demais propagam o original', async () => {
  const boom = Object.assign(new Error('falhou'), { code: 'BUSY' });
  const { reg, call } = setup({ 'w:x': { error: 'wrap' }, 't:x': { error: 'throw' } });
  reg.handle('w:x', () => { throw boom; });
  reg.handle('t:x', () => { throw boom; });
  assert.deepEqual(await call('w:x', appEvent()), { ok: false, error: 'falhou', code: 'BUSY' });
  await assert.rejects(() => call('t:x', appEvent()), (e) => e === boom);
});

test('registrador: opção error explícita sobrepõe a estratégia da tabela; esquema explícito sobrepõe args', async () => {
  const { reg, call } = setup({ 'o:x': { error: 'throw', args: [t.int({ name: 'n' })] } });
  reg.handle('o:x', [t.string({ name: 's' })], (_, s) => s, { error: 'success' });
  assert.deepEqual(await call('o:x', appEvent(), 5), { success: false, error: 's deve ser um texto.' });
  assert.equal(await call('o:x', appEvent(), 'ok'), 'ok');
});

test('registrador: recusa canal fora da tabela, sem esquema, sem handler, duplicado ou estratégia desconhecida', () => {
  const { reg } = setup({ 'ok:x': {}, 'bad:strategy': { error: 'xyz' }, 'no:schema': { args: undefined } });
  assert.throws(() => reg.handle('fora:tabela', () => 1), /sem entrada na tabela/);
  assert.throws(() => reg.handle('ok:x'), /esquema|handler/);
  assert.throws(() => reg.handle('ok:x', []), /handler ausente/);
  assert.throws(() => reg.handle('bad:strategy', () => 1), /estratégia/);
  assert.throws(() => reg.handle('no:schema', () => 1), /esquema/);
  reg.handle('ok:x', () => 1);
  assert.throws(() => reg.handle('ok:x', () => 2), /duas vezes/);
  assert.deepEqual([...reg.registered().keys()], ['ok:x']);
});

// --- a tabela e o código --------------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// Chamadas diretas a ipcMain.handle permitidas FORA do registrador (arquivo -> justificativa). Hoje: nenhuma.
const IPCMAIN_DIRETO_PERMITIDO = {};

test('nenhum ipcMain.handle direto fora do registrador (exceto lista explícita e justificada)', () => {
  const files = [path.join(ROOT, 'main.js'), ...walk(path.join(ROOT, 'src'))];
  const found = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === 'src/ipc/channelRegistry.js') continue;
    const src = strip(fs.readFileSync(f, 'utf8'));
    if (/\bipcMain\s*\.\s*(handle|handleOnce)\s*\(/.test(src) || /\{[^}]*\bipcMain\b[^}]*\}\s*=\s*require\('electron'\)/.test(src) && /\bipcMain\b/.test(src.replace(/\{[^}]*\}\s*=\s*require\('electron'\)/, ''))) {
      found.push(rel);
    }
  }
  const real = found.filter((f) => !(f in IPCMAIN_DIRETO_PERMITIDO));
  assert.deepEqual(real, [], `ipcMain direto fora do registrador:\n${real.join('\n')}`);
  for (const [f, why] of Object.entries(IPCMAIN_DIRETO_PERMITIDO)) {
    assert.ok(why && why.length > 10, `exceção ${f} sem justificativa`);
    assert.ok(found.includes(f), `exceção obsoleta: ${f}`);
  }
});

test('todo canal registrado nos módulos de src/ipc está na tabela com esquema (e vice-versa)', () => {
  const registered = new Set();
  for (const f of walk(path.join(ROOT, 'src', 'ipc'))) {
    if (path.basename(f) === 'channelRegistry.js') continue;
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/(?<![\w$.])handle\(\s*(['"`])([^'"`]+)\1/g)) registered.add(m[2]);
    assert.deepEqual([...src.matchAll(/(?<![\w$.])handle\(\s*[^'"`\s)]/g)], [], `${path.basename(f)}: canal de handle() deve ser literal`);
  }
  const table = Object.keys(CHANNELS);
  assert.deepEqual([...registered].filter((c) => !table.includes(c)), [], 'canal registrado sem entrada na tabela');
  assert.deepEqual(table.filter((c) => !registered.has(c)), [], 'entrada da tabela sem handler');
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ipc-channels.json'), 'utf8'));
  assert.deepEqual(table.slice().sort(), snapshot.handlers, 'tabela deve ter exatamente os canais do snapshot');
});

test('tabela: toda entrada tem domínio, esquema (lista), estratégia válida, retorno e argumentos nomeados', () => {
  const STRATEGIES = ['throw', 'wrap', 'success', 'null', 'empty'];
  for (const [channel, m] of Object.entries(CHANNELS)) {
    assert.match(channel, /^[a-z][\w-]*:[\w:.-]+$/i, channel);
    assert.ok(m.domain && typeof m.domain === 'string', `${channel}: domínio`);
    assert.ok(Array.isArray(m.args), `${channel}: args deve ser lista (esquema vazio = [])`);
    assert.ok(STRATEGIES.includes(m.error), `${channel}: estratégia de erro`);
    assert.ok(m.returns && typeof m.returns === 'string', `${channel}: retorno resumido`);
    for (const spec of m.args) {
      assert.ok(spec && spec.kind, `${channel}: especificação de argumento inválida`);
      if (spec.kind === 'any') assert.ok(spec.reason.length >= 8, `${channel}: any sem justificativa`);
    }
    // canais expostos no preload precisam de nomes de argumento (o gerador usa)
    const customOnly = m.api.every((a) => typeof a === 'object' && a.params !== undefined);
    if (m.api.length && !customOnly) for (const spec of m.args) assert.ok(spec.name, `${channel}: argumento sem name`);
  }
  // domínios usam estratégia coerente: ai/modules em wrap
  for (const [channel, m] of Object.entries(CHANNELS)) {
    if (m.domain === 'ai' || m.domain === 'modules') assert.equal(m.error, 'wrap', channel);
  }
});

test('tabela: nomes expostos no preload são únicos e eventos não colidem com invokes', () => {
  const names = new Map();
  for (const [channel, m] of Object.entries(CHANNELS)) {
    for (const a of m.api) {
      const name = typeof a === 'string' ? a : a.name;
      assert.ok(!names.has(name), `nome duplicado no preload: ${name} (${channel} e ${names.get(name)})`);
      names.set(name, channel);
    }
  }
  for (const [name] of EVENTS) assert.ok(!names.has(name), `evento ${name} colide com um invoke`);
  assert.equal(new Set(EVENTS.map((e) => e[0])).size, EVENTS.length);
});

test('listChannels devolve a tabela documentável (canal, domínio, args, retorno, erro)', () => {
  const rows = listChannels();
  assert.equal(rows.length, 244);
  const row = rows.find((r) => r.channel === 'library:moveMediaBulk');
  assert.equal(row.domain, 'library');
  assert.equal(row.error, 'throw');
  assert.ok(row.args.length === 2 && /ids/.test(row.args[0]));
});

test('esquemas reais: caminho relativo, id inválido e tipo errado são recusados por canal', () => {
  const run = (channel, ...args) => validateArgs(CHANNELS[channel].args, args);
  // caminho relativo
  rejects(() => run('montage:probe', 'video.mp4'), /absoluto/);
  rejects(() => run('metadata:probe', '..\\..\\Windows\\system.ini'), /absoluto/);
  rejects(() => run('luts:parse', 'lut.cube'), /LUT/);
  rejects(() => run('luts:parse', path.resolve('lut.exe')), /LUT/);
  rejects(() => run('photo:getMetadata', 'foto.jpg'), /absoluto/);
  rejects(() => run('usb:list-folder', 'E:relativo', []), /absoluto/);
  // ids
  rejects(() => run('projects:get', 'abc'), /inteiro positivo/);
  rejects(() => run('projects:get', -1), /inteiro positivo/);
  rejects(() => run('library:deleteMediaBulk', ['1', 'x']));
  rejects(() => run('library:deleteMediaBulk', 'todos'), /lista/);
  assert.deepEqual(run('library:deleteMediaBulk', [1, 2, 3]), [[1, 2, 3]]);
  // tipos
  rejects(() => run('settings:save', 'texto'), /objeto/);
  rejects(() => run('settings:save', [1]), /objeto/);
  rejects(() => run('library:toggleFavorite', 1, 'sim'), /verdadeiro ou falso/);
  rejects(() => run('modules:setEnabled', 'whisper', 'sim'), /verdadeiro ou falso/);
  rejects(() => run('downloads:reorder', 5, 'sideways'), /opção válida/);
  rejects(() => run('system:exportCookies', 'dominio com espaço', 'C:\\x.txt'), /Domínio/);
  rejects(() => run('window:fullscreen', 'enter'), /opção válida/);
  // extras e canais sem argumentos
  rejects(() => run('settings:get', 'extra'), /demais/);
  assert.deepEqual(run('settings:get'), []);
  // opcionais
  assert.deepEqual(run('dialog:selectFolder'), [undefined]);
  assert.deepEqual(run('dialog:selectFiles', { title: 'x' }), [{ title: 'x' }]);
});

test('esquemas reais: aceita as chamadas que o renderer faz hoje', () => {
  const { dir, file } = tmpFile('v.mp4');
  const run = (channel, ...args) => validateArgs(CHANNELS[channel].args, args);
  assert.deepEqual(run('montage:probe', file), [path.resolve(file)]);
  assert.deepEqual(run('converter:addFiles', [file, { path: file, duration: 3 }]).length, 1);
  assert.deepEqual(run('converter:removeFile', '1712345678'), ['1712345678']);
  assert.deepEqual(run('projects:createBin', 3, null, 'Pasta'), [3, null, 'Pasta']);
  assert.deepEqual(run('projects:updateBin', 4, 'Novo', null), [4, 'Novo', null]);
  assert.deepEqual(run('projects:addMedia', 1, null, 2, null), [1, null, 2, null]);
  assert.deepEqual(run('projects:getMarkers', 1, undefined), [1, undefined]);
  assert.equal(run('projects:getWaveform', { uuid: 'abc-123_X', filePath: file, peaksPerSecond: 50, streamIndex: 0 })[0].filePath, path.resolve(file));
  assert.deepEqual(run('recovery:diagnose', { corruptPath: file, referencePath: '' })[0].referencePath, '');
  assert.deepEqual(run('devices:get-all', true), [true]);
  assert.deepEqual(run('bdsm:getMedia', '192.168.0.5', 8080), ['192.168.0.5', 8080]);
  assert.deepEqual(run('library:getRecent', 10), [10]);
  assert.deepEqual(run('library:regenerateMissingThumbnails', {}), [{}]);
  assert.deepEqual(run('modules:transcribe', { files: [file], srt: true })[0].files, [file]);
  assert.deepEqual(run('luts:import'), [undefined]);
  assert.deepEqual(run('updates:updateTool', 'ffmpeg', { allowUnverified: true }), ['ffmpeg', { allowUnverified: true }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
