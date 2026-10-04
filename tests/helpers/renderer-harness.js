'use strict';

// Harness leve para testar as telas do renderer (ESM do navegador) sem Electron.
//   - DOM: linkedom (puro JS, ~1 MB; jsdom pesa ~7 MB e traz dezenas de dependências).
//   - window.bds simulado: Proxy que devolve uma função "no-op" (Promise resolvida) para qualquer
//     API não configurada e registra os ouvintes onXxx, para o teste disparar eventos com emit().
//   - Cada mountScreen() importa uma CÓPIA NOVA do módulo da tela (estado de módulo zerado).
//
// Uso:
//   const h = await mountScreen('metadata', { bds: { probeMetadataFile: async () => ({...}) } });
//   h.bds.emit('onConverterFinished', { failed: 1 });
//   h.bds.calls.saveMetadata  // argumentos de cada chamada
//   await h.cleanup();

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseHTML } = require('linkedom');

const SCREENS_DIR = path.join(__dirname, '..', '..', 'renderer', 'screens');

// O package.json do app não declara "type": o Node reparseia as telas como ESM (detecção automática)
// e avisa a cada import; o aviso é ruído de teste.
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = (rest[0] && rest[0].code) || rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return undefined;
  return origEmitWarning.call(this, warning, ...rest);
};

const NAMESPACES = new Set(['downloads', 'recovery']);

/** Respostas padrão plausíveis (o preload real nunca devolve undefined para estes). */
const DEFAULT_BDS = {
  getThumbDir: 'C:/bds-thumbs',
  getSettings: {},
  getDefaultOutputDir: 'C:/Videos',
  getVideosPath: 'C:/Videos',
  getDownloadsPath: 'C:/Downloads',
  getToolsPath: 'C:\tools',
  getVersion: '0.0.0-test',
  isPackaged: false,
  checkEncoders: [],
  getHardwareInfo: {},
  getLibraryStats: { totalMedia: 0, totalSize: 0, byType: {} },
  searchLibrary: { items: [], total: 0 },
  getRecentMedia: [],
  getLibraryFilterOptions: { origins: [], types: [], projects: [], tags: [] },
  getAllLibraries: [],
  getCustomSources: [],
  getStorageInfo: { total: 0, free: 0, used: 0 },
  getCacheInfo: { totalBytes: 0, totalFormatted: '0 B', categories: [] },
  listProjects: [],
  getLuts: [],
  getAllDevices: [],
  listHistory: [],
  listConversions: [],
  getYoutubeAccounts: [],
  modulesList: { modules: [] },
  modulesGetStatus: {},
  getMontageQueue: []
};

/** Cria o window.bds simulado. `impl` sobrepõe/define APIs (funções ou valores fixos). */
function createFakeBds(impl = {}) {
  const calls = {};
  const handlers = {};
  const store = { ...DEFAULT_BDS, ...impl };
  const record = (name, args) => { (calls[name] = calls[name] || []).push(args); };

  const make = (name) => {
    if (/^on[A-Z]/.test(name)) {
      return (cb) => {
        (handlers[name] = handlers[name] || []).push(cb);
        record(name, [cb]);
        return () => { handlers[name] = (handlers[name] || []).filter((f) => f !== cb); };
      };
    }
    return (...args) => {
      record(name, args);
      const v = store[name];
      return typeof v === 'function' ? v(...args) : Promise.resolve(v);
    };
  };

  const target = {
    calls,
    handlers,
    /** Dispara o evento onXxx para todos os ouvintes registrados. */
    emit(name, payload) { for (const cb of [...(handlers[name] || [])]) cb(payload); },
    /** Define/substitui uma API depois da montagem. */
    set(name, value) { store[name] = value; }
  };
  const cache = new Map();
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      // Objetos aninhados do preload (downloads, recovery)
      if (NAMESPACES.has(prop) && store[prop] && typeof store[prop] === 'object') {
        return new Proxy(store[prop], {
          get: (o, k) => (typeof o[k] === 'function' ? (...a) => { record(`${prop}.${String(k)}`, a); return o[k](...a); }
            : (/^on[A-Z]/.test(String(k)) ? () => () => {} : () => Promise.resolve(o[k])))
        });
      }
      if (prop === 'downloads') {
        return new Proxy({}, { get: (_o, k) => (/^on[A-Z]/.test(String(k)) ? () => () => {} : () => Promise.resolve([])) });
      }
      if (!cache.has(prop)) cache.set(prop, make(prop));
      return cache.get(prop);
    },
    has() { return true; }
  });
}

const GLOBAL_KEYS = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Node', 'Element', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
  'DOMParser', 'FileReader', 'Image', 'Audio', 'HTMLCanvasElement', 'HTMLInputElement', 'HTMLSelectElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAudioElement',
  'SVGElement', 'CSS', 'alert', 'confirm', 'prompt', 'scrollTo', 'devicePixelRatio', 'innerWidth', 'innerHeight'
];

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}

let mountSeq = 0;
const installed = [];

/**
 * Monta uma tela: DOM com <div id="<tela>View"> + HTML da tela, window.bds simulado, import ESM novo do .js.
 * @returns {{mod, window, document, bds, errors, cleanup}}
 */
async function mountScreen(screen, { bds = {}, html = null, init = true, bdsModal = true, shell = false, modulePath = null } = {}) {
  // modulePath: módulo ESM fora de screens/ (ex.: '../components/ai-assistant.js'), relativo a renderer/screens; nesse caso
  // `html` pode ser '' (o componente cria o próprio DOM) e initScreen não é chamado automaticamente.
  const htmlFile = path.join(SCREENS_DIR, `${screen}.html`);
  const body = html != null ? html : fs.readFileSync(htmlFile, 'utf8');
  // shell: usa o index.html real + renderer/app.js (navegação real: bdsLoadScreen busca ./screens/<tela>.html)
  const docHtml = shell
    ? fs.readFileSync(path.join(SCREENS_DIR, '..', 'index.html'), 'utf8')
      // links de CSS já presentes: o app.js não espera o "load" (que não existe aqui) de nenhuma tela
      .replace('</head>', fs.readdirSync(SCREENS_DIR).filter((f) => f.endsWith('.css'))
        .map((f) => `<link id="css-modular-${f.slice(0, -4)}" rel="stylesheet" href="x.css">`).join('') + '</head>')
    : `<!doctype html><html><head></head><body><div id="${screen}View" class="screen-view">${body}</div></body></html>`;
  const { window, document } = parseHTML(docHtml);

  const fakeBds = createFakeBds(bds);
  const dialogs = { alerts: [], confirms: [] };
  window.bds = fakeBds;
  const fakeModal = {
    alert: async (msg) => { dialogs.alerts.push(String(msg)); },
    confirm: async (msg) => { dialogs.confirms.push(String(msg)); return true; },
    prompt: async () => null
  };
  if (bdsModal) window.bdsModal = fakeModal;
  // linkedom: <select>.value só tem getter; o navegador permite atribuir (seleciona a <option>)
  const selProto = Object.getPrototypeOf(document.createElement('select'));
  const selDesc = Object.getOwnPropertyDescriptor(selProto, 'value');
  if (selDesc && !selDesc.set) {
    Object.defineProperty(selProto, 'value', {
      configurable: true,
      get: selDesc.get,
      set(v) {
        for (const o of this.querySelectorAll('option')) {
          if (String(o.getAttribute('value') ?? o.textContent) === String(v)) o.setAttribute('selected', '');
          else o.removeAttribute('selected');
        }
      }
    });
  }
  // <dialog>: linkedom não implementa showModal/close
  const elProto = Object.getPrototypeOf(document.createElement('dialog'));
  for (const [name, open] of [['showModal', true], ['show', true], ['close', false]]) {
    if (typeof elProto[name] !== 'function') {
      Object.defineProperty(elProto, name, {
        configurable: true,
        value() { if (open) this.setAttribute('open', ''); else this.removeAttribute('open'); }
      });
    }
  }
  window.localStorage = memoryStorage();
  window.sessionStorage = memoryStorage();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.getComputedStyle = window.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.MutationObserver = window.MutationObserver || class { observe() {} disconnect() {} takeRecords() { return []; } };
  window.scrollTo = () => {};
  window.devicePixelRatio = 1;
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  window.CSS = { supports: () => false, escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  window.Element.prototype.getClientRects = window.Element.prototype.getClientRects || (() => []);
  window.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect || (() => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }));
  // Hooks de módulos compartilhados que o app.js costuma definir
  window.setAppStatus = window.setAppStatus || (() => {});

  const saved = {};
  for (const k of GLOBAL_KEYS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const savedTimers = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
  const errors = [];

  globalThis.window = window;
  globalThis.document = document;
  for (const k of GLOBAL_KEYS) {
    if (k === 'window' || k === 'document') continue;
    const v = window[k];
    if (v === undefined) continue;
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  // 'navigator' é somente-leitura no Node 21+: redefine por defineProperty (acima) e garante clipboard
  // Temporizadores "unref": uma tela esquecida em setInterval não segura o processo de teste
  globalThis.setInterval = (...a) => { const t = savedTimers.setInterval(...a); if (t && t.unref) t.unref(); return t; };
  globalThis.setTimeout = (...a) => { const t = savedTimers.setTimeout(...a); if (t && t.unref) t.unref(); return t; };
  window.setInterval = globalThis.setInterval;
  window.setTimeout = globalThis.setTimeout;
  window.clearInterval = clearInterval;
  window.clearTimeout = clearTimeout;

  const onRejection = (e) => { errors.push(e); };
  process.on('unhandledRejection', onRejection);

  const realFetch = globalThis.fetch;
  let mod;
  if (shell) {
    globalThis.fetch = async (u) => {
      const f = path.join(SCREENS_DIR, '..', String(u).replace(/^\.\//, '').split('?')[0]);
      if (!fs.existsSync(f)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => fs.readFileSync(f, 'utf8'), json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) };
    };
    // sem query: as telas importam '../app.js' e precisam enxergar a MESMA instância
    await import(pathToFileURL(path.join(SCREENS_DIR, '..', 'app.js')).href);
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle(10);
    if (bdsModal) window.bdsModal = fakeModal;
    await window.bdsLoadScreen(screen);
    mod = await import(pathToFileURL(path.join(SCREENS_DIR, `${screen}.js`)).href);
    init = false;
  } else {
    const jsFile = modulePath ? path.resolve(SCREENS_DIR, modulePath) : path.join(SCREENS_DIR, `${screen}.js`);
    const url = `${pathToFileURL(jsFile).href}?harness=${++mountSeq}`;
    mod = await import(url);
    // o app.js (importado pela tela) substitui window.bdsModal pelo modal real: volta ao simulado
    if (bdsModal) window.bdsModal = fakeModal;
  }
  const handle = {
    mod, window, document, bds: fakeBds, dialogs, errors,
    async cleanup() {
      try { if (typeof mod.onLeave === 'function') await mod.onLeave(); } catch (_) { /* noop */ }
      process.removeListener('unhandledRejection', onRejection);
      globalThis.fetch = realFetch;
      globalThis.setInterval = savedTimers.setInterval;
      globalThis.setTimeout = savedTimers.setTimeout;
      for (const k of GLOBAL_KEYS) {
        if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
        else delete globalThis[k];
      }
      const i = installed.indexOf(handle);
      if (i >= 0) installed.splice(i, 1);
    }
  };
  installed.push(handle);
  if (init && typeof mod.initScreen === 'function') await mod.initScreen();
  return handle;
}

/** Aguarda microtarefas/timers curtos (promessas encadeadas das telas). */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = { createFakeBds, mountScreen, settle, SCREENS_DIR };
