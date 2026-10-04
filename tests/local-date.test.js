'use strict';

// Fuso do Brasil: 'YYYY-MM-DD' lido como UTC cairia no dia anterior (precisa ser definido antes de qualquer Date)
process.env.TZ = 'America/Sao_Paulo';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseLocalDate, daysUntilLocal, formatLocalDate } = require('../src/services/localDate');

test('data só com dia vira meia-noite LOCAL (não UTC)', () => {
  const d = parseLocalDate('2026-10-05');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 0);
});

test('"YYYY-MM-DDT00:00:00(.000)Z" legado também é tratado como dia local', () => {
  assert.equal(parseLocalDate('2026-10-05T00:00:00.000Z').getDate(), 5);
  assert.equal(parseLocalDate('2026-10-05T00:00:00Z').getDate(), 5);
});

test('timestamps completos continuam sendo instantes', () => {
  const d = parseLocalDate('2026-10-05T15:30:00.000Z');
  assert.equal(d.getTime(), Date.parse('2026-10-05T15:30:00.000Z'));
});

test('entradas vazias ou inválidas devolvem null', () => {
  for (const v of [null, undefined, '', 'abc', '2026-02-31', '2026-13-01', new Date('x')]) {
    assert.equal(parseLocalDate(v), null, String(v));
  }
});

test('daysUntilLocal: hoje, amanhã, atrasado e virada de mês', () => {
  const now = new Date(2026, 9, 5, 23, 30); // 05/10/2026 23:30 local
  assert.equal(daysUntilLocal('2026-10-05', now), 0);
  assert.equal(daysUntilLocal('2026-10-06', now), 1);
  assert.equal(daysUntilLocal('2026-10-03', now), -2);
  assert.equal(daysUntilLocal('2026-11-04', now), 30);
  assert.equal(daysUntilLocal('lixo', now), null);
});

test('daysUntilLocal não depende da hora do dia', () => {
  const madrugada = new Date(2026, 9, 5, 0, 1);
  const noite = new Date(2026, 9, 5, 23, 59);
  assert.equal(daysUntilLocal('2026-10-07', madrugada), 2);
  assert.equal(daysUntilLocal('2026-10-07', noite), 2);
});

test('formatLocalDate mostra o dia salvo, sem recuar um dia', () => {
  assert.equal(formatLocalDate('2026-10-05'), '05/10/2026');
  assert.equal(formatLocalDate(null), '-');
  assert.equal(formatLocalDate('lixo'), '-');
});

test('espelho do renderer (ESM) tem o mesmo comportamento', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'localDate.js')).href);
  assert.equal(mod.parseLocalDate('2026-10-05').getDate(), 5);
  assert.equal(mod.formatLocalDate('2026-10-05'), '05/10/2026');
  assert.equal(mod.daysUntilLocal('2026-10-06', new Date(2026, 9, 5, 22)), 1);
});

test('DeadlineNotifier._daysLeft usa a data local', () => {
  const notifier = require('../src/infrastructure/desktop/DeadlineNotifier');
  const hoje = new Date();
  const iso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  assert.equal(notifier._daysLeft(iso), 0);
  assert.equal(notifier._daysLeft('lixo'), null);
});
