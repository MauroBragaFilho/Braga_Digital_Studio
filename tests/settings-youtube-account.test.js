'use strict';

// Configurações > Mídia > Conta do YouTube: o uso da conta nos downloads é opcional (desligado por padrão) e há um botão para
// sair da conta e apagar a sessão. Também confere a nota da tela Downloads (liga/desliga) e que a tela Envio não exporta mais
// a sessão sozinha.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const read = (...p) => fs.readFileSync(path.join(SCREENS_DIR, ...p), 'utf8');

test('o HTML tem o cartão "Conta do YouTube": opção desligada de fábrica e botão de sair', () => {
  const html = read('settings.html');
  const input = /<input[^>]*id="useYoutubeAccountInput"[^>]*>/.exec(html);
  assert.ok(input, 'opção "Usar minha conta nos downloads do YouTube"');
  assert.doesNotMatch(input[0], /\bchecked\b/, 'vem desligada: o uso da conta é opcional');
  assert.match(html, /<button id="btnYoutubeSignOut"[^>]*>\s*Sair e apagar a sessão\s*<\/button>/);
  assert.match(html, /Enquanto baixa, o BDS cria um arquivo temporário com a sessão e o apaga ao terminar/);
});

test('a opção reflete o que está salvo, entra no que é salvo e o botão pede confirmação antes de sair da conta', async () => {
  const saved = [];
  let signOuts = 0;
  let signOutResult = { success: true };
  const h = await mountScreen('settings', {
    shell: true,
    bds: {
      getSettings: async () => ({ useYoutubeAccount: true }),
      saveSettings: async (payload) => { saved.push(payload); return payload; },
      youtubeSignOut: async () => { signOuts++; return signOutResult; }
    }
  });
  try {
    await settle(80);
    const doc = h.document;
    const toasts = () => doc.getElementById('bdsToasts')?.textContent || '';
    const box = doc.getElementById('useYoutubeAccountInput');
    assert.equal(box.checked, true, 'mostra a escolha salva');

    box.checked = false;
    doc.getElementById('saveSettingsButton').click();
    await settle(60);
    assert.ok(saved.length >= 1, 'salvou');
    assert.equal(saved.at(-1).useYoutubeAccount, false, 'a escolha vai no que é salvo');
    box.checked = true;
    doc.getElementById('saveSettingsButton').click();
    await settle(60);
    assert.equal(saved.at(-1).useYoutubeAccount, true);

    // Sair da conta: recusar a confirmação não faz nada
    let answer = false;
    h.window.bdsModal.confirm = async (msg) => { h.lastConfirm = String(msg); return answer; };
    doc.getElementById('btnYoutubeSignOut').click();
    await settle(30);
    assert.equal(signOuts, 0, 'sem confirmação, nada é apagado');
    assert.match(h.lastConfirm, /Sair da conta do YouTube/);
    assert.match(h.lastConfirm, /sessão guardada é apagada/);

    answer = true;
    doc.getElementById('btnYoutubeSignOut').click();
    await settle(40);
    assert.equal(signOuts, 1);
    assert.match(toasts(), /Você saiu da conta do YouTube/);
    assert.equal(doc.getElementById('btnYoutubeSignOut').disabled, false, 'o botão volta ao normal');

    // Falha ao sair: o usuário é avisado
    signOutResult = { success: false, error: 'Não deu certo.' };
    doc.getElementById('btnYoutubeSignOut').click();
    await settle(40);
    assert.equal(signOuts, 2);
    assert.match(toasts(), /Não deu certo/);
  } finally {
    await h.cleanup();
  }
});

test('tela Envio: abrir a página do YouTube Studio não exporta mais a sessão sozinha', () => {
  const js = read('upload.js');
  const html = read('upload.html');
  assert.doesNotMatch(js, /exportYoutubeCookies|syncYoutubeSession/);
  assert.doesNotMatch(html, /cookiesSyncStatusBar/);
  const preload = fs.readFileSync(path.join(SCREENS_DIR, '..', '..', 'preload.js'), 'utf8');
  assert.doesNotMatch(preload, /exportYoutubeCookies|system:exportCookies|exportCookies:/, 'o renderer não pode mandar exportar cookies');
  assert.match(preload, /youtubeSignOut: \(\) => ipcRenderer\.invoke\('youtube:signOut'\)/);
});

test('tela Downloads: a nota da conta só aparece com a conta ligada e diz se há login', async (t) => {
  const stateOf = async (status) => {
    const h = await mountScreen('download', {
      bds: { downloads: { getQueue: async () => [], getWaitState: async () => null, cookiesStatus: async () => status } }
    });
    t.after(() => h.cleanup());
    await settle(60);
    return h.document.getElementById('downloadSessionNote');
  };

  const off = await stateOf({ enabled: false, valid: false });
  assert.equal(off.textContent, '', 'conta desligada: nenhuma linha na tela');

  const noLogin = await stateOf({ enabled: true, valid: false });
  assert.match(noLogin.textContent, /Conta do YouTube ligada, mas sem login/);
  assert.match(noLogin.textContent, /aba Envio/);

  const ok = await stateOf({ enabled: true, valid: true, expiresAt: Date.UTC(2027, 10, 22, 12) });
  assert.match(ok.textContent, /Conta do YouTube ligada \(válida até \d{2}\/\d{2}\/2027\)/);
  assert.ok(ok.classList.contains('active'));
});
