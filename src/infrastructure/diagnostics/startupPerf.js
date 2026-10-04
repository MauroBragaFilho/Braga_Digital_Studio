'use strict';

/**
 * Diagnóstico de inicialização (BDS_PERF=1). Desligado por padrão: sem a variável de ambiente,
 * todas as funções abaixo são no-ops e nada é gravado nem cronometrado.
 *
 * Com BDS_PERF=1 o app grava `startup-perf-<data>.json` na pasta de logs (ou em BDS_PERF_FILE,
 * se definido) com:
 *   - marks:    marcos do processo principal (ms desde o início do processo)
 *   - renderer: marcos do renderer, convertidos para o mesmo relógio do main
 *   - requires: os require() mais caros (tempo próprio e inclusivo)
 *   - bg:       término de cada tarefa de segundo plano e `allDoneMs`
 *
 * Uso: mark('nome'), time('nome', fn), timeAsync('nome', fn), expect([...]) / done('tarefa').
 */

const enabled = process.env.BDS_PERF === '1';

const NOOP = () => {};
let api;

if (!enabled) {
  api = {
    enabled: false,
    mark: NOOP,
    time: (_name, fn) => fn(),
    timeAsync: (_name, fn) => fn(),
    expect: NOOP,
    done: NOOP,
    setOutputDir: NOOP,
    attachWindow: NOOP,
    flushSync: NOOP,
  };
} else {
  const { performance } = require('node:perf_hooks');
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');

  const marks = [];
  const bg = {};
  const requireStats = new Map(); // arquivo -> { inclusiveMs, selfMs }
  let outputDir = null;
  let pending = null; // Set de tarefas esperadas
  let allDoneMs = null;
  let rendererData = null;
  let timer = null;
  const startedAt = new Date();

  const now = () => performance.now();

  // Atraso do event loop do processo principal: registra bloqueios > 80 ms (início e duração) para achar
  // trabalho síncrono pesado que atrasa a janela/IPC.
  // Processos filhos (exec/spawn...): quando foram disparados e quanto a chamada bloqueou o processo principal.
  const spawns = [];
  try {
    const cp = require('node:child_process');
    for (const fnName of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync']) {
      const original = cp[fnName];
      if (typeof original !== 'function') continue;
      cp[fnName] = function patchedChildProcess(...args) {
        const t = now();
        try {
          return original.apply(this, args);
        } finally {
          if (spawns.length < 100) {
            spawns.push({ fn: fnName, atMs: Math.round(t), blockedMs: Math.round((now() - t) * 10) / 10, cmd: String(args[0]).replace(/-EncodedCommand \S+/, '-EncodedCommand ...').slice(0, 90) });
          }
        }
      };
    }
  } catch (_) { /* ignora */ }

  const lags = [];
  let lastTick = now();
  const lagTimer = setInterval(() => {
    const t = now();
    const lag = t - lastTick - 50;
    if (lag > 80) lags.push({ atMs: Math.round(lastTick), lagMs: Math.round(lag) });
    lastTick = t;
  }, 50);
  if (lagTimer.unref) lagTimer.unref();

  function mark(name, meta) {
    marks.push({ name, ms: Math.round(now() * 100) / 100, ...(meta ? { meta } : {}) });
    schedule();
  }

  // --- require() cronometrado: tempo inclusivo e próprio (exclui os filhos) ---
  const stack = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    let filename = null;
    try { filename = Module._resolveFilename(request, parent, isMain); } catch (_) { /* deixa o load original lançar */ }
    if (!filename || Module._cache[filename]) return originalLoad.apply(this, arguments);
    const frame = { filename, start: now(), children: 0 };
    stack.push(frame);
    try {
      return originalLoad.apply(this, arguments);
    } finally {
      stack.pop();
      const total = now() - frame.start;
      if (stack.length) stack[stack.length - 1].children += total;
      const prev = requireStats.get(filename) || { inclusiveMs: 0, selfMs: 0 };
      prev.inclusiveMs += total;
      prev.selfMs += total - frame.children;
      requireStats.set(filename, prev);
    }
  };

  function topRequires(limit = 25) {
    const root = path.resolve(__dirname, '..', '..', '..');
    return [...requireStats.entries()]
      .map(([file, s]) => ({
        file: file.startsWith(root) ? path.relative(root, file) : file,
        inclusiveMs: Math.round(s.inclusiveMs * 100) / 100,
        selfMs: Math.round(s.selfMs * 100) / 100,
      }))
      .sort((a, b) => b.inclusiveMs - a.inclusiveMs)
      .slice(0, limit);
  }

  function report() {
    return {
      startedAt: startedAt.toISOString(),
      electron: process.versions.electron,
      packaged: Boolean(process.resourcesPath && !/node_modules[\\/]electron[\\/]dist/i.test(process.resourcesPath)),
      marks,
      lags,
      spawns,
      bg,
      allDoneMs,
      renderer: rendererData,
      requireTotalMs: Math.round([...requireStats.values()].reduce((a, s) => a + s.selfMs, 0) * 100) / 100,
      requires: topRequires(),
    };
  }

  function targetFile() {
    if (process.env.BDS_PERF_FILE) return process.env.BDS_PERF_FILE;
    if (!outputDir) return null;
    return path.join(outputDir, `startup-perf-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  }

  function flushSync() {
    const file = targetFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report(), null, 2));
    } catch (_) { /* diagnóstico nunca derruba o app */ }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushSync(); }, 400);
    if (timer.unref) timer.unref();
  }

  function expect(names) {
    pending = new Set(names);
  }

  function done(name) {
    bg[name] = Math.round(now() * 100) / 100;
    mark(`bg:${name}`);
    if (pending && pending.delete(name) && pending.size === 0) {
      allDoneMs = bg[name];
      mark('bg:all-done');
    }
  }

  /** Lê os marcos do renderer (performance.mark 'bds:*' + paints) e os converte para o relógio do main. */
  function attachWindow(win) {
    const wc = win.webContents;
    const mainOrigin = performance.timeOrigin;
    const script = `(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint').map(p => ({ name: p.name, ms: p.startTime }));
      const marks = performance.getEntriesByType('mark').filter(m => m.name.startsWith('bds:')).map(m => ({ name: m.name, ms: m.startTime }));
      const res = performance.getEntriesByType('resource').map(r => ({ name: r.name.split('/renderer/')[1] || r.name, start: r.startTime, dur: r.duration, size: r.transferSize || r.decodedBodySize || 0 }));
      return JSON.stringify({ origin: performance.timeOrigin, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, paints, marks, res });
    })()`;
    let tries = 0;
    const poll = async () => {
      if (wc.isDestroyed()) return;
      tries++;
      try {
        const data = JSON.parse(await wc.executeJavaScript(script));
        const toMain = (ms) => Math.round((data.origin + ms - mainOrigin) * 100) / 100;
        const hasHome = data.marks.some((m) => m.name === 'bds:home-data-painted');
        if (hasHome || tries >= 40) {
          rendererData = {
            domContentLoadedMs: data.dcl ? toMain(data.dcl) : null,
            loadMs: data.load ? toMain(data.load) : null,
            paints: data.paints.map((p) => ({ name: p.name, ms: toMain(p.ms) })),
            marks: data.marks.map((m) => ({ name: m.name, ms: toMain(m.ms) })),
            resources: data.res.map((r) => ({ name: r.name, startMs: toMain(r.start), durMs: Math.round(r.dur * 100) / 100, size: r.size })).sort((a, b) => b.durMs - a.durMs).slice(0, 20),
          };
          mark('renderer:collected');
          return;
        }
      } catch (_) { /* página ainda carregando */ }
      setTimeout(poll, 250);
    };
    wc.once('did-finish-load', () => { mark('window:did-finish-load'); poll(); });
    wc.once('dom-ready', () => mark('window:dom-ready'));
    win.once('ready-to-show', () => mark('window:ready-to-show'));
    win.once('show', () => mark('window:show'));
  }

  api = {
    enabled: true,
    mark,
    time(name, fn) {
      const t = now();
      try { return fn(); } finally { mark(name, { durMs: Math.round((now() - t) * 100) / 100 }); }
    },
    async timeAsync(name, fn) {
      const t = now();
      try { return await fn(); } finally { mark(name, { durMs: Math.round((now() - t) * 100) / 100 }); }
    },
    expect,
    done,
    setOutputDir(dir) { outputDir = dir; },
    attachWindow,
    flushSync,
  };
  mark('process:main-js-start');
}

module.exports = api;
