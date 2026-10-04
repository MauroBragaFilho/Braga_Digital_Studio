'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../src/core/modules/ModuleRegistry');

test('padrões: todos os módulos desligados, exceto o assistente de IA (ligado por padrão, também no app final)', () => {
  for (const isDev of [true, false]) {
    const e = reg.resolveEnabled({}, { isDev });
    assert.ok(reg.MODULES.filter((m) => m.id !== 'ai').every((m) => e[m.id] === false), `demais desligados (isDev=${isDev})`);
    assert.ok(reg.MODULES.filter((m) => m.id !== 'ai').every((m) => m.defaultEnabled === false));
    assert.equal(e.ai, true, `assistente ligado por padrão (isDev=${isDev})`);
  }
  assert.deepEqual(reg.MODULES.filter((m) => m.defaultEnabled).map((m) => m.id), ['ai']);
});

test('chave ausente ou enabledModules inválido usa o padrão (desligado)', () => {
  for (const s of [undefined, null, {}, { enabledModules: null }, { enabledModules: [] }, { enabledModules: { silence: 'sim' } }]) {
    assert.equal(reg.resolveEnabled(s).silence, false);
  }
  assert.equal(reg.resolveEnabled({ enabledModules: { silence: true } }).silence, true);
  assert.equal(reg.resolveEnabled({ enabledModules: { silence: false } }).silence, false);
});

test('devOnly (Montagem e Recuperação) nunca fica ligado fora do desenvolvimento; o assistente liberado fica ligado também no app final', () => {
  const s = { enabledModules: { ai: true, montage: true, recovery: true } };
  const prod = reg.resolveEnabled(s, { isDev: false });
  assert.deepEqual([prod.montage, prod.recovery], [false, false]);
  assert.equal(prod.ai, true, 'assistente liberado no app final');
  const dev = reg.resolveEnabled(s, { isDev: true });
  assert.deepEqual([dev.ai, dev.montage, dev.recovery], [true, true, true]);
  // desligar continua valendo em qualquer build
  assert.equal(reg.resolveEnabled({ enabledModules: { ai: false } }, { isDev: false }).ai, false);
  assert.equal(reg.resolveEnabled({ enabledModules: { ai: false } }, { isDev: true }).ai, false);
});

test('isEnabled e ids desconhecidos', () => {
  assert.equal(reg.isEnabled('metadata', {}), false);
  assert.equal(reg.isEnabled('metadata', { enabledModules: { metadata: true } }), true);
  assert.equal(reg.isEnabled('nao-existe', { enabledModules: { 'nao-existe': true } }), false);
  assert.equal(reg.isKnownId('__proto__'), false);
});

test('sanitizeEnabledModules mantém só ids conhecidos com booleano', () => {
  assert.deepEqual(
    reg.sanitizeEnabledModules({ silence: false, ai: 1, foo: true, metadata: true }),
    { silence: false, metadata: true }
  );
  assert.deepEqual(reg.sanitizeEnabledModules('x'), {});
  assert.deepEqual(reg.sanitizeEnabledModules([true]), {});
});

test('moduleForScreen e definições coerentes', () => {
  assert.equal(reg.moduleForScreen('silence').id, 'silence');
  assert.equal(reg.moduleForScreen('home'), null);
  const orders = reg.MODULES.map((m) => m.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(reg.MODULES.find((m) => m.id === 'transcription').hasEngine, true);
});

test('motores: transcrição usa o painel do Whisper; recuperação baixa o motor sob demanda', () => {
  assert.equal(reg.getModule('transcription').engine, 'whisper');
  const recovery = reg.getModule('recovery');
  assert.equal(recovery.hasEngine, true);
  assert.equal(recovery.engine, 'tool:untrunc');
  for (const id of ['silence', 'metadata', 'montage', 'ai']) assert.equal(reg.getModule(id).hasEngine, false);
});

test('assistente de IA: módulo sem tela (botão flutuante), liberado no app final e ligado por padrão', () => {
  const { ASSISTANT_ALLOWED_IN_PACKAGED_APP } = require('../src/services/ai/releaseGate');
  assert.equal(ASSISTANT_ALLOWED_IN_PACKAGED_APP, true, 'liberado no app final (releaseGate.js)');
  const ai = reg.getModule('ai');
  assert.deepEqual([...ai.screens], [], 'não é uma tela do menu lateral');
  assert.equal(ai.devOnly, false, 'não é mais só de desenvolvimento');
  assert.equal(ai.defaultEnabled, true);
  assert.equal(reg.moduleForScreen('ai'), null);
  for (const isDev of [true, false]) {
    assert.equal(reg.isEnabled('ai', {}, { isDev }), true, `chave ausente = ligado (isDev=${isDev})`);
    assert.equal(reg.isEnabled('ai', { enabledModules: { ai: true } }, { isDev }), true);
    assert.equal(reg.isEnabled('ai', { enabledModules: { ai: false } }, { isDev }), false);
  }
});
