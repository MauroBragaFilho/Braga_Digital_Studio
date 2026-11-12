#!/usr/bin/env node
'use strict';

/**
 * Ponte MCP (stdio) do Braga Digital Studio — sem dependências, roda com o Node comum.
 *
 * Para agentes de IA que só sabem iniciar um comando (stdio). Ela repassa cada mensagem JSON-RPC recebida na entrada
 * padrão ao servidor MCP local do aplicativo (que precisa estar aberto e com "Conectar agentes (MCP)" ligado) e
 * devolve a resposta na saída padrão. Lê porta e token do mcp.json que fica nesta mesma pasta.
 *
 * Uso:  node mcp-bridge.js [caminho-do-mcp.json]
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');

const configFile = process.argv[2] || path.join(__dirname, 'mcp.json');

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (c && c.enabled === true && Number.isInteger(c.port) && (c.requireToken === false || (typeof c.token === 'string' && c.token))) return c;
  } catch (_) { /* tratado abaixo */ }
  return null;
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const failure = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

function post(cfg, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: cfg.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(cfg.requireToken === false ? {} : { Authorization: `Bearer ${cfg.token}` }),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('Tempo esgotado esperando o aplicativo (alguma confirmação ficou sem resposta?).')));
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let id = null;
  let isRequest = false;
  try {
    const msg = JSON.parse(text);
    if (msg && !Array.isArray(msg) && msg.id !== undefined && msg.id !== null) { id = msg.id; isRequest = true; }
  } catch (_) { /* o servidor responde o erro de JSON */ }

  const cfg = readConfig();
  if (!cfg) {
    if (isRequest) failure(id, 'Braga Digital Studio: o servidor MCP está desligado. Ligue em Configurações → Inteligência Artificial → Conectar agentes (MCP).');
    return;
  }
  pending++;
  post(cfg, text).then((r) => {
    if (r.status === 202 || !r.text) return;
    if (r.status === 401) { if (isRequest) failure(id, 'Token recusado. Copie a configuração de novo em Configurações → Inteligência Artificial.'); return; }
    process.stdout.write(`${r.text.replace(/\r?\n/g, ' ')}\n`);
  }).catch((err) => {
    if (isRequest) failure(id, err && err.code === 'ECONNREFUSED' ? 'Braga Digital Studio não está aberto. Abra o aplicativo e tente de novo.' : `Falha ao falar com o Braga Digital Studio: ${err && err.message}`);
  }).finally(() => { pending--; maybeExit(); });
});
rl.on('close', () => { closed = true; maybeExit(); });
