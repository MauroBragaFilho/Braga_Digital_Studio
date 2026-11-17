'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Histórico: na inicialização apaga registros com mais de 180 dias', async (t) => {
  const HistoryService = require('../src/services/historyService');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-hist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await HistoryService.create(dir);
  h.addDownload({ titulo: 'novo', url: 'u1', tipo: 'v', pasta: 'p', status: 'ok' });
  h.downloadsDb.run("INSERT INTO downloads (titulo, url, data_download) VALUES ('velho', 'u2', datetime('now', 'localtime', '-200 days'))");
  h.conversionsDb.run("INSERT INTO conversions (arquivo_origem, data_conversao) VALUES ('velho', datetime('now', 'localtime', '-181 days'))");
  const removed = h.applyRetention();
  assert.deepEqual(removed, { downloads: 1, conversions: 1 });
  assert.deepEqual(h.listDownloads().map((r) => r.titulo), ['novo']);
  assert.equal(HistoryService.HISTORY_RETENTION_DAYS, 180);
  clearTimeout(h._downloadsSaveTimer); clearTimeout(h._conversionsSaveTimer);
});

test('ErrorReporter: apaga relatórios de falha com mais de 30 dias', (t) => {
  let mod;
  try { mod = require('../src/infrastructure/telemetry/ErrorReporter'); } catch (e) { t.skip(`sem electron: ${e.message}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = new mod.ErrorReporter();
  r.crashReportsDir = dir;
  const old = path.join(dir, 'velho.json');
  fs.writeFileSync(old, '{}'); fs.writeFileSync(path.join(dir, 'novo.json'), '{}');
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  assert.deepEqual(r.pruneOldReports(), { deleted: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['novo.json']);
});
