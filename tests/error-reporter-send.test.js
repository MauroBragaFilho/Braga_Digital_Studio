'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ErrorReporter } = require('../src/infrastructure/telemetry/ErrorReporter');

function makeReporter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-reports-'));
  const reporter = new ErrorReporter();
  reporter.crashReportsDir = dir; // sem init(): não registra handlers globais no processo de teste
  reporter.logsDir = dir;
  reporter.getSettings = () => ({});
  return { reporter, dir };
}

test('sem relatórios: nada para enviar', async () => {
  const { reporter, dir } = makeReporter();
  assert.deepEqual(await reporter.sendAllReports(), { method: 'none', count: 0, sent: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sem endpoint: devolve um único mailto com o resumo e mantém os relatórios', async () => {
  const { reporter, dir } = makeReporter();
  for (const message of ['Falha A', 'Falha B']) {
    const data = reporter._buildReportPayload({ name: 'Error', message, stack: `Error: ${message}\n    at x (C:\Users\fulano\app.js:1:1)` }, { source: 'teste' });
    reporter._saveReportToDisk(data);
  }
  const result = await reporter.sendAllReports();
  assert.equal(result.method, 'email');
  assert.equal(result.count, 2);
  assert.ok(result.mailto.startsWith('mailto:'));
  const body = decodeURIComponent(result.mailto.split('body=')[1]);
  assert.match(body, /2 relatório\(s\)/);
  assert.match(body, /Falha A/);
  assert.doesNotMatch(body, /fulano/); // dados pessoais não vão no resumo
  assert.equal(reporter.listLocalReports().length, 2); // continuam guardados até o usuário limpar
  assert.deepEqual(reporter.clearAllReports(), { deleted: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});
