'use strict';

// Executa um preload.js com 'electron' simulado e devolve a "superfície" de window.bds:
// para cada chave (com namespaces aninhados): tipo, aridade e, ao chamar a função com argumentos
// sentinela, qual canal ipcRenderer.invoke / ipcRenderer.on foi usado e com que argumentos.
// Serve para provar que o preload gerado é equivalente ao escrito à mão.

const path = require('node:path');
const Module = require('node:module');

const SENTINELS = ['@1', '@2', '@3', '@4', '@5'];

function loadApi(source, file) {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke: (ch, ...args) => { calls.push({ op: 'invoke', ch, args }); return Promise.resolve(); },
    on: (ch) => { calls.push({ op: 'on', ch }); },
    removeListener: (ch) => { calls.push({ op: 'off', ch }); }
  };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, obj) => { if (name === 'bds') api = obj; } },
    ipcRenderer,
    webUtils: { getPathForFile: (f) => { calls.push({ op: 'webUtils', arg: norm(f) }); return 'caminho'; } }
  };
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    m._compile(source, file);
  } finally {
    Module._load = origLoad;
  }
  if (!api) throw new Error('preload não expôs window.bds');
  return { api, calls };
}

// undefined (inclusive aninhado) vira marcador: o fixture é JSON e JSON descarta chaves undefined.
const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? '__undefined__' : v, (k, x) => (x === undefined ? '__undefined__' : x)));

function extractSurface(source, file = path.join(process.cwd(), 'preload.js')) {
  const surface = {};
  const visit = (fresh, prefix) => {
    for (const k of Object.keys(fresh.api)) {
      const full = prefix ? `${prefix}.${k}` : k;
      const v = fresh.api[k];
      if (v && typeof v === 'object') {
        surface[full] = { type: 'object' };
        // Reexecuta o preload para cada folha: chamadas anteriores não contaminam as seguintes.
        visit({ api: v, calls: fresh.calls }, full);
        continue;
      }
      if (typeof v !== 'function') { surface[full] = { type: typeof v }; continue; }
      const entry = { type: 'function', length: v.length };
      const probe = (args) => {
        const before = fresh.calls.length;
        let ret;
        try { ret = v(...args); } catch (e) { return { threw: true }; }
        const made = fresh.calls.slice(before).map((c) => (
          c.op === 'invoke' ? { op: 'invoke', ch: c.ch, args: c.args.map(norm) } : c
        ));
        // Retorno de função de desinscrição (listeners) conta como "funçao".
        // A ordem de remoção em removeAllListeners depende da ordem de registro (artefato da sonda): ordena.
        if (full === 'removeAllListeners') made.sort((x, y) => (x.ch < y.ch ? -1 : x.ch > y.ch ? 1 : 0));
        return { made, returns: typeof ret === 'function' ? 'function' : (ret && typeof ret.then === 'function' ? 'promise' : typeof ret) };
      };
      entry.withSentinels = probe(SENTINELS.slice(0, Math.max(v.length, 1) + 1).map((s) => (/(^|\.)on[A-Z]/.test(full) ? () => {} : s)));
      entry.noArgs = probe([]);
      if (full === 'fullscreenWindow') entry.exit = probe(['exit']);
      if (full === 'getAllDevices') entry.force = probe([true]);
      if (full === 'regenerateMissingThumbnails') entry.opts = probe([{ batchSize: 3 }]);
      if (/(^|\.)on[A-Z]/.test(full)) {
        // desinscrever: chama a função devolvida e registra o removeListener
        const before = fresh.calls.length;
        try { const off = v(() => {}); if (typeof off === 'function') { off(); off(); } } catch (_) { /* ignore */ }
        entry.unsubscribe = fresh.calls.slice(before).map((c) => ({ op: c.op, ch: c.ch }));
      }
      surface[full] = entry;
    }
  };
  const first = loadApi(source, file);
  visit(first, '');
  return Object.fromEntries(Object.entries(surface).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

module.exports = { extractSurface, loadApi };
