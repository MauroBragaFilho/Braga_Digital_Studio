'use strict';

// Teste de FIAÇÃO (RK-062): sem Electron, por análise estática/execução do preload simulado,
// garante que as pontas do IPC se encontram:
//   (a) invoke do preload  <->  ipcMain.handle (src/ + main.js)
//   (b) window.bds.<nome> usado no renderer  ->  chave exposta pelo preload
//   (c) listener onXxx do preload  ->  emissor webContents.send/_send no main
//   (d) getElementById/$ de uma tela  ->  id existente no HTML da tela (ou criado dinamicamente)
//
// As listas *_CONHECIDAS abaixo são dívida registrada: cada entrada tem justificativa e TODO.
// Meta: esvaziá-las; o teste também FALHA se uma exceção deixar de ser necessária (lista não apodrece).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

// Remove comentários /* */ e // (preservando quebras de linha, para os números de linha baterem)
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function lineOf(text, needle) {
  const i = text.indexOf(needle);
  return i < 0 ? 0 : text.slice(0, i).split('\n').length;
}

// ---------------------------------------------------------------------------
// Exceções conhecidas (preencher SOMENTE com justificativa + TODO)
// ---------------------------------------------------------------------------

// (a1) canais do preload sem ipcMain.handle
const INVOKE_SEM_HANDLER_CONHECIDOS = {
};

// (a2) ipcMain.handle sem exposição no preload (uso interno/futuro/legado)
const HANDLE_SEM_PRELOAD_CONHECIDOS = {
  'converter:listQueue': 'bootstrap.js:720 — legado do conversor (fila vem por evento converter:queue); sem chamador — TODO remover ou expor',
  'download:cancel': 'bootstrap.js:709 — API antiga de download, substituída por downloads:* (fila nova) — TODO remover',
  'download:clearQueue': 'bootstrap.js:711 — API antiga de download, substituída por downloads:clearCompleted — TODO remover',
  'download:getQueue': 'bootstrap.js:710 — API antiga de download, substituída por downloads:getQueue — TODO remover',
  'download:removeJob': 'bootstrap.js:712 — API antiga de download, substituída por downloads:remove — TODO remover',
  'download:start': 'bootstrap.js:680 — API antiga de download, substituída por downloads:add/start — TODO remover',
  'jobs:cancel': 'jobHandlers.js:14 — gerenciador de jobs sem exposição no preload (nenhuma tela o usa ainda) — TODO expor ou remover',
  'jobs:cancelAll': 'jobHandlers.js:18 — idem jobs:cancel — TODO',
  'jobs:clearHistory': 'jobHandlers.js:27 — idem jobs:cancel — TODO',
  'jobs:getHistory': 'jobHandlers.js:23 — idem jobs:cancel — TODO',
  'jobs:getStatus': 'jobHandlers.js:10 — idem jobs:cancel — TODO',
  'jobs:pause': 'jobHandlers.js:32 — idem jobs:cancel — TODO',
  'jobs:resume': 'jobHandlers.js:37 — idem jobs:cancel — TODO',
  'updates:check': 'bootstrap.js:750 — canal legado de atualização (o preload usa updates:checkSystem/checkAll) — TODO remover',
  'updates:checkLegacy': 'bootstrap.js:751 — canal legado de atualização — TODO remover'
};

// (b) window.bds.<nome> usado no renderer mas ausente no preload
const BDS_API_INEXISTENTE_CONHECIDAS = {
  cancelMontage: 'montage.js:1016 — ramo "else if (window.bds.cancelMontage)" protegido por existência; o preload só tem cancelMontageJob — TODO remover o ramo morto'
};

// (c) listener onXxx sem emissor no main
const LISTENER_SEM_EMISSOR_CONHECIDOS = {
};

// (d) por tela: ids usados no JS sem elemento no HTML
// Obs.: `<tela>View` é criado por renderer/app.js (loadScreen) e é aceito automaticamente.
const ID_SEM_ELEMENTO_CONHECIDOS = {
};

// ---------------------------------------------------------------------------
// Preload: executado com 'electron' simulado -> árvore de chaves + canais
// ---------------------------------------------------------------------------

function loadPreload() {
  const invoked = new Set();
  const listened = new Set();
  let api = null;
  const ipcRenderer = {
    invoke: (ch) => { invoked.add(ch); return Promise.resolve(); },
    on: (ch) => { listened.add(ch); },
    removeListener() {}
  };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, obj) => { if (name === 'bds') api = obj; } },
    ipcRenderer,
    webUtils: { getPathForFile: () => 'x' }
  };
  const file = path.join(ROOT, 'preload.js');
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    m._compile(rd('preload.js'), file);
  } finally {
    Module._load = origLoad;
  }
  assert.ok(api, 'preload deve expor window.bds');

  const keys = new Set();
  const listenerChannels = new Set();
  const visit = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      keys.add(full);
      if (v && typeof v === 'object') { visit(v, full); continue; }
      if (typeof v !== 'function') continue;
      const before = new Set(listened);
      try { v(() => {}, 'a', 'b'); } catch (_) { /* getPathForFile etc. */ }
      for (const ch of listened) if (!before.has(ch)) listenerChannels.add(ch);
      if (/(^|\.)on[A-Z]/.test(full)) { /* listeners não chamam invoke */ }
    }
  };
  visit(api, '');
  // canais de listener não contam como invoke
  return { keys, invoked, listenerChannels };
}

// ---------------------------------------------------------------------------
// Main: handlers e emissores
// ---------------------------------------------------------------------------

const mainFiles = [path.join(ROOT, 'main.js'), ...walk(path.join(ROOT, 'src'), ['.js'])];
const mainSrc = new Map(mainFiles.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]));

function collectHandlers() {
  const handlers = new Map(); // canal -> 'arquivo:linha'
  const dynamic = [];
  for (const [file, src] of mainSrc) {
    const re = /ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(src))) {
      if (!handlers.has(m[2])) handlers.set(m[2], `${file}:${lineOf(src, m[0])}`);
    }
    const reAll = /ipcMain\.handle\(\s*([^'"`\s])/g;
    while ((m = reAll.exec(src))) dynamic.push(`${file}:${lineOf(src, m[0])}`);
    // Registrador central: `handle('canal', ...)` nos módulos de src/ipc (o próprio registrador é dinâmico por natureza)
    if (file.startsWith('src/ipc/') && file !== 'src/ipc/channelRegistry.js') {
      const reReg = /(?<![\w$.])handle\(\s*(['"`])([^'"`]+)\1/g;
      while ((m = reReg.exec(src))) {
        if (!handlers.has(m[2])) handlers.set(m[2], `${file}:${lineOf(src, m[0])}`);
      }
      const reRegAll = /(?<![\w$.])handle\(\s*([^'"`\s)])/g;
      while ((m = reRegAll.exec(src))) dynamic.push(`${file}:${lineOf(src, m[0])}`);
    }
  }
  return { handlers, dynamic };
}

function hasEmitter(channel) {
  const esc = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(send\\w*|_send\\w*|emit\\w*|notify\\w*|push|broadcast\\w*)\\(\\s*['"\`]${esc}['"\`]`);
  for (const src of mainSrc.values()) {
    if (re.test(src)) return true;
  }
  return false;
}

function checkKnown(known, actual, label) {
  const unused = Object.keys(known).filter((k) => !actual.includes(k));
  assert.deepEqual(unused, [], `${label}: exceções conhecidas que não são mais necessárias (remova): ${unused.join(', ')}`);
  for (const [k, why] of Object.entries(known)) {
    assert.ok(typeof why === 'string' && why.length > 10, `${label}: exceção "${k}" sem justificativa`);
  }
}

// ---------------------------------------------------------------------------
// (a) invoke <-> handle
// ---------------------------------------------------------------------------

test('(a) todo invoke do preload tem ipcMain.handle', () => {
  const { invoked } = loadPreload();
  const { handlers, dynamic } = collectHandlers();
  assert.deepEqual(dynamic, [], `ipcMain.handle com canal não literal impede a análise: ${dynamic.join(', ')}`);
  assert.ok(handlers.size > 100, 'análise estática deve achar os handlers');
  const preloadSrc = rd('preload.js');
  const missing = [...invoked].filter((ch) => !handlers.has(ch)).sort();
  const real = missing.filter((ch) => !(ch in INVOKE_SEM_HANDLER_CONHECIDOS));
  assert.deepEqual(real,
    [],
    'Canais invocados no preload sem handler:\n' + real.map((c) => `  ${c} (preload.js:${lineOf(preloadSrc, `'${c}'`)})`).join('\n'));
  checkKnown(INVOKE_SEM_HANDLER_CONHECIDOS, missing, 'INVOKE_SEM_HANDLER_CONHECIDOS');
});

test('(a) todo ipcMain.handle é exposto pelo preload (exceções explícitas)', () => {
  const { invoked } = loadPreload();
  const { handlers } = collectHandlers();
  const orphan = [...handlers.keys()].filter((ch) => !invoked.has(ch)).sort();
  const real = orphan.filter((ch) => !(ch in HANDLE_SEM_PRELOAD_CONHECIDOS));
  assert.deepEqual(real,
    [],
    'Handlers sem exposição no preload:\n' + real.map((c) => `  ${c} (${handlers.get(c)})`).join('\n'));
  checkKnown(HANDLE_SEM_PRELOAD_CONHECIDOS, orphan, 'HANDLE_SEM_PRELOAD_CONHECIDOS');
});

// ---------------------------------------------------------------------------
// (b) window.bds.<nome> no renderer existe no preload
// ---------------------------------------------------------------------------

test('(b) todo window.bds.<nome> usado no renderer existe no preload', () => {
  const { keys } = loadPreload();
  const files = walk(path.join(ROOT, 'renderer'), ['.js']);
  const found = new Map(); // nome -> 'arquivo:linha'
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /(?<![\w.$])(?:window\.)?bds\??\.([A-Za-z_]\w*)(?:\??\.([A-Za-z_]\w*))?(?:\??\.([A-Za-z_]\w*))?/g;
    let m;
    while ((m = re.exec(src))) {
      // 'bds' isolado só vale como API se vier com window. ou se o arquivo atribui "= window.bds"
      const viaWindow = m[0].startsWith('window.');
      if (!viaWindow && !/=\s*window\.bds\b/.test(src)) continue;
      let name = m[1];
      if (keys.has(name) && !viaWindow === false) { /* ok */ }
      // objetos aninhados: valida o segundo/terceiro nível se o primeiro é um objeto do preload
      const chain = [m[1], m[2], m[3]].filter(Boolean);
      let cur = '';
      for (const part of chain) {
        const next = cur ? `${cur}.${part}` : part;
        if (!keys.has(next)) { name = next; cur = null; break; }
        cur = next;
        const isObj = [...keys].some((k) => k.startsWith(`${next}.`));
        if (!isObj) break;
      }
      if (cur === null && !found.has(name)) found.set(name, `${rel(f)}:${lineOf(src, m[0])}`);
    }
  }
  const missing = [...found.keys()].sort();
  const real = missing.filter((n) => !(n in BDS_API_INEXISTENTE_CONHECIDAS));
  assert.deepEqual(real,
    [],
    'window.bds.* inexistente no preload:\n' + real.map((n) => `  bds.${n} (${found.get(n)})`).join('\n'));
  checkKnown(BDS_API_INEXISTENTE_CONHECIDAS, missing, 'BDS_API_INEXISTENTE_CONHECIDAS');
});

// ---------------------------------------------------------------------------
// (c) listener onXxx -> emissor
// ---------------------------------------------------------------------------

test('(c) todo listener do preload tem emissor webContents.send/_send', () => {
  const { listenerChannels } = loadPreload();
  assert.ok(listenerChannels.size > 40, 'deve descobrir os canais de listener');
  const preloadSrc = rd('preload.js');
  const missing = [...listenerChannels].filter((ch) => !hasEmitter(ch)).sort();
  const real = missing.filter((ch) => !(ch in LISTENER_SEM_EMISSOR_CONHECIDOS));
  assert.deepEqual(real,
    [],
    'Listeners sem emissor no main:\n' + real.map((c) => `  ${c} (preload.js:${lineOf(preloadSrc, `'${c}'`)})`).join('\n'));
  checkKnown(LISTENER_SEM_EMISSOR_CONHECIDOS, missing, 'LISTENER_SEM_EMISSOR_CONHECIDOS');
});

// ---------------------------------------------------------------------------
// (d) ids usados pela tela existem no HTML
// ---------------------------------------------------------------------------

const idsOfHtml = (html) => new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));

test('(d) ids usados em renderer/screens/<tela>.js existem em <tela>.html', () => {
  const shell = idsOfHtml(rd('renderer/index.html'));
  const dir = path.join(ROOT, 'renderer', 'screens');
  const telas = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  const all = []; // 'tela:id'
  const problems = [];
  for (const tela of telas) {
    const htmlFile = path.join(dir, `${tela}.html`);
    if (!fs.existsSync(htmlFile)) continue;
    const js = fs.readFileSync(path.join(dir, `${tela}.js`), 'utf8');
    const html = fs.readFileSync(htmlFile, 'utf8');
    const present = idsOfHtml(html);
    // ids criados dinamicamente no próprio JS: id="x", .id = 'x', id: 'x', setAttribute('id','x')
    const dyn = new Set();
    for (const m of js.matchAll(/\bid\s*=\s*\\?["']([A-Za-z][\w-]*)\\?["']/g)) dyn.add(m[1]);
    for (const m of js.matchAll(/\.id\s*=\s*['"`]([A-Za-z][\w-]*)['"`]/g)) dyn.add(m[1]);
    for (const m of js.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g)) dyn.add(m[1]);
    const used = new Map();
    const re = /(?:getElementById|\$)\(\s*(['"])([A-Za-z][\w-]*)\1\s*\)/g;
    let m;
    while ((m = re.exec(js))) if (!used.has(m[2])) used.set(m[2], lineOf(js, m[0]));
    const known = ID_SEM_ELEMENTO_CONHECIDOS[tela] || {};
    const missing = [];
    for (const [id, line] of used) {
      if (present.has(id) || dyn.has(id) || shell.has(id) || /^[a-z_]+View$/.test(id)) continue;
      missing.push(id);
      if (!(id in known)) problems.push(`  ${tela}.js:${line} -> #${id}`);
    }
    for (const id of Object.keys(known)) {
      if (!missing.includes(id)) problems.push(`  [exceção obsoleta] ${tela}: #${id} já resolvido, remova de ID_SEM_ELEMENTO_CONHECIDOS`);
    }
    all.push(...missing.map((id) => `${tela}:${id}`));
  }
  assert.deepEqual(problems, [], 'ids sem elemento no HTML:\n' + problems.join('\n'));
});
