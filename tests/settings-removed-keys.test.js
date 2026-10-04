'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SettingsManager = require('../src/core/settings/SettingsManager');

test('configurações antigas: chaves do Telegram (recurso removido) são apagadas ao carregar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-removed-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    theme: 'light',
    telegramNotificationsEnabled: true,
    telegramBotToken: '123:ABC',
    telegramBotTokenEnc: 'xxxx',
    telegramChatId: '42'
  }));
  const loaded = new SettingsManager(dir, dir).load();
  assert.equal(loaded.theme, 'light'); // o resto é preservado
  for (const k of ['telegramNotificationsEnabled', 'telegramBotToken', 'telegramBotTokenEnc', 'telegramChatId']) {
    assert.equal(k in loaded, false, k);
  }
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes('123:ABC'), 'o token antigo não pode ficar no disco');
});
