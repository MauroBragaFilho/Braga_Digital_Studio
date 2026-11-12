'use strict';

// Servidor MCP: autenticação, anti DNS rebinding, protocolo (initialize/tools/list/tools/call), confirmação de ações
// (recusa = nada acontece, aviso de agente externo), ferramentas de módulo desligado e a ponte stdio.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const McpService = require('../src/services/ai/mcp/McpService');
const { ToolBox } = require('../src/services/ai/tools');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-mcp-'));
let svc; let port; let token; let asked; let answer = false;
let clip = '';

const fakeDb = { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) };
function makeToolbox() {
  return new ToolBox({
    getDb: () => fakeDb,
    library: { searchMedia: () => ({ items: [], total: 0 }), getStats: () => ({}) },
    projects: { list: () => [] },
    services: { downloads: { getQueue: () => [], add: () => { throw new Error('não deveria baixar'); } } },
    settings: { load: () => ({ mp4Folder: path.join(os.tmpdir(), 'v'), mp3Folder: path.join(os.tmpdir(), 'm') }) },
    confirm: async (req) => { asked = req; return answer; },
    getEnabledModules: () => ({ library: true, download: true, projects: false })
  });
}

function rpc(body, { auth = `Bearer ${token}`, host, origin, method = 'POST', p = '/mcp' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (auth) headers.Authorization = auth;
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) { /* vazio */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const call = (id, name, args) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

before(async () => {
  const tb = makeToolbox();
  svc = new McpService({ configDir: dir, getToolbox: () => tb, clipboard: { writeText: (t) => { clip = t; } } });
  await svc.setEnabled(true);
  port = svc.status().port;
  token = svc.config.getToken();
});
after(async () => { await svc.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('desligado por padrão: nada escuta', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-mcp2-'));
  const s2 = new McpService({ configDir: d2, getToolbox: () => null });
  await s2.init();
  assert.equal(s2.status().running, false);
  assert.equal(s2.status().enabled, false);
  fs.rmSync(d2, { recursive: true, force: true });
});

test('recusa sem token, com token errado, Host estranho e Origin de navegador', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: '' })).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: 'Bearer errado' })).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'evil.example.com' })).status, 403);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await rpc(undefined, { method: 'GET' })).status, 405);
  assert.equal((await rpc({}, { p: '/outro' })).status, 404);
});

test('initialize negocia a versão e informa o servidor; notificação devolve 202', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'Antigravity' } } });
  assert.equal(r.json.result.protocolVersion, '2025-03-26');
  assert.equal(r.json.result.serverInfo.name, 'braga-digital-studio');
  assert.ok(r.json.result.capabilities.tools);
  assert.equal(svc.status().client, 'Antigravity');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'nao/existe' })).json.error.code, -32601);
});

test('tools/list: só módulos ligados, com esquema e anotações', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const byName = Object.fromEntries(r.json.result.tools.map((t) => [t.name, t]));
  assert.ok(byName.library_search && byName.add_download);
  assert.equal(byName.projects_list, undefined, 'módulo Projetos desligado não é oferecido');
  assert.equal(byName.library_search.annotations.readOnlyHint, true);
  assert.equal(byName.add_download.annotations.readOnlyHint, false);
  assert.equal(byName.add_download.annotations.destructiveHint, false);
  assert.equal(byName.library_search.inputSchema.type, 'object');
});

test('tools/call: leitura devolve o texto do ToolBox; inexistente, módulo desligado e argumento inválido viram erro', async () => {
  const ok = await call(1, 'library_stats', {});
  assert.equal(ok.json.result.isError, false);
  assert.match(ok.json.result.content[0].text, /Dados do aplicativo/);
  assert.equal((await call(2, 'apagar_tudo', {})).json.result.isError, true);
  const off = await call(3, 'projects_list', {});
  assert.equal(off.json.result.isError, true);
  assert.match(off.json.result.content[0].text, /desligado/);
  assert.equal((await call(4, 'library_search', { naoExiste: 1 })).json.result.isError, true);
});

test('ação: pede confirmação com aviso de agente externo; recusar não faz nada', async () => {
  asked = null; answer = false;
  const r = await call(1, 'add_download', { url: 'https://example.com/video', formato: 'video' });
  assert.ok(asked, 'o diálogo de confirmação foi pedido');
  assert.match(asked.title, /agente de IA/);
  assert.match(asked.message, /agente de IA externo/);
  assert.match(r.json.result.content[0].text, /recusou/);
});

test('copyConfig monta os três formatos e o token só vai para a área de transferência', () => {
  for (const kind of ['antigravity', 'http', 'stdio']) {
    svc.copyConfig(kind);
    const cfg = JSON.parse(clip).mcpServers['braga-digital-studio'];
    if (kind === 'stdio') assert.equal(cfg.command, 'node');
    else assert.equal(cfg.headers.Authorization, `Bearer ${token}`);
  }
  assert.equal(JSON.stringify(svc.status()).includes(token), false, 'o estado público não leva o token');
  assert.throws(() => svc.copyConfig('xyz'), /desconhecido/);
});

test('novo token invalida o antigo sem reiniciar', async () => {
  const old = token;
  svc.regenerateToken();
  token = svc.config.getToken();
  assert.notEqual(old, token);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: `Bearer ${old}` })).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
});

test('ponte stdio repassa a requisição ao servidor', async () => {
  const bridge = svc.config.writeBridge();
  const child = spawn(process.execPath, [bridge, svc.config.file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; if (buf.includes('\n')) resolve(buf.trim()); });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
    setTimeout(() => reject(new Error('ponte sem resposta')), 8000);
  });
  child.stdin.end();
  assert.ok(JSON.parse(out).result.tools.length > 0);
});

test('desligar fecha a porta', async () => {
  await svc.setEnabled(false);
  await assert.rejects(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }));
});

test('opções: sem token a conexão local abre; sem confirmação a ação roda; Origin segue bloqueado', async () => {
  await svc.setEnabled(true);
  port = svc.status().port;
  svc.setOptions({ requireToken: false, autoConfirm: true });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: '' })).status, 200);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: '', origin: 'https://evil.example.com' })).status, 403);
  svc.copyConfig('antigravity');
  assert.equal(JSON.parse(clip).mcpServers['braga-digital-studio'].headers, undefined);
  asked = null;
  let ran = false;
  svc.server.getToolbox().deps.services.downloads.add = () => { ran = true; return { id: 1 }; };
  await call(1, 'add_download', { url: 'https://example.com/video', formato: 'video' });
  assert.equal(asked, null, 'não abriu confirmação');
  assert.equal(ran, true, 'a ação foi executada');
  svc.setOptions({ requireToken: true, autoConfirm: false });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: '' })).status, 401);
});
