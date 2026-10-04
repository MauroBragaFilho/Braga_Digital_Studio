#!/usr/bin/env node
'use strict';

/**
 * generate-preload.js — gera o preload.js a partir da tabela única de canais (src/ipc/channels.js).
 *
 * O preload com sandbox só pode carregar 'electron' (não lê outros arquivos), por isso o arquivo é
 * GERADO em vez de importar a tabela em tempo de execução. Fluxo:
 *   npm run generate:preload     escreve preload.js
 *   npm run verify:preload       falha (código 1) se preload.js difere do que o gerador produz
 *
 * Fixos no gerador (cabeçalho/rodapé): contextBridge, registerListener com desinscrição idempotente,
 * getPathForFile (webUtils) e removeAllListeners. Todo o resto vem de CHANNELS (invoke) e EVENTS (on*).
 * O arquivo é escrito com CRLF (como o preload.js sempre foi neste repositório).
 */

const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS, EVENTS } = require('../src/ipc/channels');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preload.js');
const EOL = '\r\n';

const HEADER = `// ARQUIVO GERADO por scripts/generate-preload.js a partir de src/ipc/channels.js. NÃO EDITE À MÃO:
// altere a tabela de canais e rode "npm run generate:preload" ("npm run verify:preload" confere).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Conjunto para gerenciar ouvintes e evitar vazamentos de memória
const listeners = new Set();

/**
 * Função auxiliar para registrar ouvintes de forma padronizada
 */
const registerListener = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_, payload) => callback(payload);
  const entry = [channel, listener];
  ipcRenderer.on(channel, listener);
  listeners.add(entry);
  // Retorna uma função de desinscrição (idempotente) que também remove a entrada do Set,
  // evitando que ele cresça indefinidamente a cada tela/montagem.
  return () => {
    ipcRenderer.removeListener(channel, listener);
    listeners.delete(entry);
  };
};

const api = {`;

const FOOTER_ENTRIES = `  // --- Utilitários fixos ---
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Limpeza Global
  removeAllListeners: () => {
    for (const [channel, listener] of listeners) {
      ipcRenderer.removeListener(channel, listener);
    }
    listeners.clear();
  }`;

const FOOTER = `};

contextBridge.exposeInMainWorld('bds', api);
`;

/** Normaliza as entradas \`api\` de um canal: [{ name, params, call }]. */
function apiEntries(channel, meta) {
  const names = meta.args.map((a) => a.name);
  return meta.api.map((item) => {
    const spec = typeof item === 'string' ? { name: item } : item;
    let params = spec.params;
    if (params === undefined) {
      if (names.some((n) => !n)) throw new Error(`Canal ${channel}: argumentos sem "name" (necessário para gerar o preload).`);
      params = names.join(', ');
    }
    const call = spec.call === undefined ? params : spec.call;
    return { name: spec.name, params, call, channel, domain: meta.domain };
  });
}

/** Constrói a árvore (preservando a ordem de inserção) de window.bds. */
function buildTree() {
  const root = { children: new Map() };
  const put = (dotted, leaf) => {
    const parts = dotted.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) { child = { children: new Map() }; node.children.set(part, child); }
      if (child.leaf) throw new Error(`Conflito de nome no preload: ${dotted}`);
      node = child;
    }
    const key = parts[parts.length - 1];
    if (node.children.has(key)) throw new Error(`Nome duplicado no preload: ${dotted}`);
    node.children.set(key, { leaf });
  };
  for (const [channel, meta] of Object.entries(CHANNELS)) {
    for (const e of apiEntries(channel, meta)) put(e.name, { kind: 'invoke', ...e });
  }
  for (const [name, channel] of EVENTS) put(name, { kind: 'event', channel, domain: 'events' });
  return root;
}

const SECTION_TITLES = {
  settings: 'Configurações', app: 'App', updates: 'Atualizações', telemetry: 'Telemetria e relatório de erros',
  window: 'Controles de janela', dialog: 'Diálogos', montage: 'Montagem', silence: 'Remover silêncio',
  metadata: 'Metadados', converter: 'Conversor', downloads: 'Downloads e mídia', youtube: 'YouTube',
  history: 'Histórico', devices: 'Dispositivos (MTP, USB e BDSM)', sony: 'Câmeras Sony', bdsm: 'BDSM',
  recovery: 'Recuperação e logs', luts: 'LUTs', ai: 'IA (a chave de API nunca volta para o renderer)',
  modules: 'Módulos opcionais (Whisper)', library: 'Biblioteca de mídia', system: 'Sistema',
  licenses: 'Licenças de terceiros', upload: 'Upload', photo: 'Prévia de fotos', projects: 'Projetos', events: 'Eventos (main → renderer)'
};

function emitNode(node, depth, lines) {
  const pad = '  '.repeat(depth);
  let lastDomain = null;
  for (const [key, child] of node.children) {
    if (child.leaf) {
      const leaf = child.leaf;
      if (depth === 1 && leaf.domain !== lastDomain) {
        if (lastDomain !== null) lines.push('');
        lines.push(`${pad}// --- ${SECTION_TITLES[leaf.domain] || leaf.domain} ---`);
        lastDomain = leaf.domain;
      }
      if (leaf.kind === 'event') {
        lines.push(`${pad}${key}: (cb) => registerListener('${leaf.channel}', cb),`);
      } else {
        const callArgs = leaf.call ? `, ${leaf.call}` : '';
        lines.push(`${pad}${key}: (${leaf.params}) => ipcRenderer.invoke('${leaf.channel}'${callArgs}),`);
      }
    } else {
      if (depth === 1) { if (lastDomain !== null) lines.push(''); lines.push(`${pad}// --- Namespace ${key} ---`); lastDomain = null; }
      lines.push(`${pad}${key}: {`);
      emitNode(child, depth + 1, lines);
      lines.push(`${pad}},`);
    }
  }
}

/** Texto do preload (com \n; a escrita converte para CRLF). */
function generate() {
  const lines = [];
  emitNode(buildTree(), 1, lines);
  return `${HEADER}\n${lines.join('\n')}\n\n${FOOTER_ENTRIES}\n${FOOTER}`;
}

const toEol = (text) => text.replace(/\r\n/g, '\n').replace(/\n/g, EOL);

function verify() {
  const expected = toEol(generate());
  let current = '';
  try { current = fs.readFileSync(OUT, 'utf8'); } catch (_) { /* inexistente */ }
  return { ok: toEol(current) === expected, expected, current };
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const r = verify();
    if (!r.ok) {
      console.error('preload.js difere do que o gerador produz. Rode: npm run generate:preload');
      process.exit(1);
    }
    console.log('preload.js confere com a tabela de canais.');
  } else {
    fs.writeFileSync(OUT, toEol(generate()), 'utf8');
    console.log(`preload.js gerado (${Object.keys(CHANNELS).length} canais, ${EVENTS.length} eventos).`);
  }
}

module.exports = { generate, verify, buildTree, OUT };
