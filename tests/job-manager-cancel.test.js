'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../src/core/jobs/JobManager');

test('cancelar job em execução só libera a vaga quando o executor termina', async () => {
  const jm = new JobManager({ concurrency: 1 });
  let release;
  let started2 = false;
  const a = jm.submit({ type: 'test', title: 'a', executor: () => new Promise((r) => { release = r; }) });
  jm.submit({ type: 'test', title: 'b', executor: async () => { started2 = true; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(jm.running.size, 1);
  jm.cancel(a.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(started2, false, 'o segundo job não pode começar com o primeiro ainda rodando');
  assert.equal(jm.running.size, 1);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(started2, true);
  assert.ok(jm.listHistory().some((h) => h.id === a.id && h.status === 'cancelled'));
});
