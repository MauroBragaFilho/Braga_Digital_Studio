'use strict';

// Política de segurança (itens F-114, F-113, F-96 e F-128 da análise de conformidade): canal para relatar falhas, prazos e roteiro
// em caso de incidente. Estes testes mantêm o arquivo no lugar certo, ligado ao README, e com o MESMO contato que o app usa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');

test('SECURITY.md existe, pede relato privado e diz o que esperar e o que está no escopo', () => {
  const md = flat(read('SECURITY.md'));
  assert.match(md, /^# Política de Segurança/);
  assert.match(md, /Não abra uma issue pública/);
  assert.match(md, /Report a vulnerability/);
  assert.match(md, /confirmação de que recebi o relato: até 7 dias/);
  assert.match(md, /divulgação coordenada/i);
  assert.match(md, /## Se um problema afetar os usuários/);
  assert.match(md, /ANPD \(LGPD, art\. 48\)/);
  assert.match(md, /## English summary/);
});

test('o contato do SECURITY.md é o mesmo que o app usa (appInfo): ao trocar por um e-mail dedicado, muda nos dois lugares', () => {
  const { DEVELOPER_EMAIL } = require('../src/config/appInfo');
  assert.ok(DEVELOPER_EMAIL, 'appInfo tem o e-mail do desenvolvedor');
  const md = read('SECURITY.md');
  const emails = new Set(md.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []);
  assert.deepEqual([...emails], [DEVELOPER_EMAIL], 'um único endereço, igual ao do app');
});

test('SECURITY.md não promete o que o código não faz: sem "segurança total" e com os prazos como metas', () => {
  const md = flat(read('SECURITY.md'));
  assert.doesNotMatch(md, /segurança total|absolute security/i);
  assert.match(md, /Não há contrato de suporte nem prazo garantido/);
  assert.match(md, /Estes prazos são metas, não promessas/);
});

test('README em português e em inglês apontam para a política de segurança', () => {
  assert.match(read('README.md'), /\[Política de Segurança\]\(SECURITY\.md\)/);
  assert.match(read('README.en.md'), /\[Security Policy\]\(SECURITY\.md\)/);
});
