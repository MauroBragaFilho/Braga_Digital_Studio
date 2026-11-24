'use strict';

// Configurações → Inteligência Artificial: seção Áudio (ordem e interruptores da transcrição, salvos na hora), seções
// Imagem e Vídeo, e o submenu único (a aba Transcrição não existe mais).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const ROOT = path.join(__dirname, '..');
const url = (rel) => pathToFileURL(path.join(ROOT, 'renderer', 'components', rel)).href;
let seq = 0;

const PROVIDERS = [
  { id: 'groq', label: 'Groq', hasKey: true, keySource: 'chat', model: 'whisper-large-v3-turbo', models: [{ id: 'whisper-large-v3-turbo', label: 'Turbo', hint: 'Rápido' }, { id: 'whisper-large-v3', label: 'Completo', hint: 'Preciso' }] },
  { id: 'elevenlabs', label: 'ElevenLabs', hasKey: false, keySource: null, model: 'scribe_v2', models: [{ id: 'scribe_v2', label: 'Scribe v2', hint: 'ElevenLabs' }] }
];

async function mountAudio({ settings = {}, confirm = true, ai = null, extra = {} } = {}) {
  const saved = [];
  const h = await mountScreen('luts', {
    init: false,
    bds: {
      ...(ai ? { aiGetConfig: { ok: true, data: ai } } : {}),
      modulesCloudGet: { ok: true, data: { encryptionAvailable: true, providers: PROVIDERS } },
      modulesGetStatus: { ok: true, data: { whisper: { ready: true, engine: { installed: true }, models: [{ id: 'small', label: 'Small', active: true }] } } },
      getSettings: async () => ({ transcriptionOrder: ['local', 'groq', 'elevenlabs'], transcriptionFallback: ['local'], ...settings }),
      saveSettings: async (patch) => { saved.push(patch); return {}; },
      ...extra
    }
  });
  h.window.bdsModal.confirm = async () => confirm;
  const host = h.document.createElement('div');
  h.document.body.append(host);
  const mod = await import(`${url('ai-audio-section.js')}?t=${++seq}`);
  await mod.mountAudioSection(host);
  await settle(20);
  return { h, host, mod, saved };
}

const click = (h, el) => { const ev = new h.window.Event('click', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); };
const change = (h, el) => el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
const rows = (host) => [...host.querySelectorAll('.aud-row')];
const names = (host) => rows(host).map((r) => r.querySelector('strong').textContent);

test('Áudio: três motores na ordem salva; de fábrica só este computador está ligado', async () => {
  const t = await mountAudio();
  assert.deepEqual(names(t.host), ['Neste computador', 'Groq', 'ElevenLabs']);
  const on = rows(t.host).map((r) => Boolean(r.querySelector('.aud-enabled').checked));
  assert.deepEqual(on, [true, false, false]);
  assert.match(rows(t.host)[0].textContent, /Pronto/);
  assert.match(rows(t.host)[1].textContent, /Desligado/, 'Groq tem chave (do chat) mas não está ligado');
  assert.equal(rows(t.host)[2].querySelector('.aud-enabled').disabled, true, 'sem chave não dá para ligar');
  assert.match(rows(t.host)[2].textContent, /Sem chave/);
  await t.h.cleanup();
});

test('Áudio: subir/descer grava a ordem na hora (só ids dos motores) sem tocar nos ligados', async () => {
  const t = await mountAudio();
  click(t.h, rows(t.host)[1].querySelector('.aud-up'));
  await settle(20);
  assert.deepEqual(names(t.host), ['Groq', 'Neste computador', 'ElevenLabs']);
  assert.deepEqual(t.saved.at(-1), { transcriptionOrder: ['groq', 'local', 'elevenlabs'], transcriptionFallback: ['local'] });
  assert.equal(rows(t.host)[0].querySelector('.aud-up').disabled, true);
  await t.h.cleanup();
});

test('Áudio: ligar um serviço de nuvem pede confirmação (o áudio sai do computador); recusar não liga', async () => {
  const no = await mountAudio({ confirm: false });
  const box = rows(no.host)[1].querySelector('.aud-enabled');
  box.checked = true;
  change(no.h, box);
  await settle(20);
  assert.equal(no.saved.length, 0, 'recusou: nada foi gravado');
  assert.equal(Boolean(rows(no.host)[1].querySelector('.aud-enabled').checked), false);
  await no.h.cleanup();

  const yes = await mountAudio({ confirm: true });
  const box2 = rows(yes.host)[1].querySelector('.aud-enabled');
  box2.checked = true;
  change(yes.h, box2);
  await settle(20);
  assert.deepEqual(yes.saved.at(-1).transcriptionFallback, ['local', 'groq']);
  assert.match(rows(yes.host)[1].textContent, /Ligado/);
  await yes.h.cleanup();
});

test('Áudio: desligar não pergunta; chave do chat aparece como tal; a chave nunca é exibida', async () => {
  const t = await mountAudio({ settings: { transcriptionFallback: ['groq', 'local'] } });
  const local = rows(t.host)[0].querySelector('.aud-enabled');
  local.checked = false;
  change(t.h, local);
  await settle(20);
  assert.deepEqual(t.saved.at(-1).transcriptionFallback, ['groq']);
  assert.match(rows(t.host)[1].querySelector('.aud-detail').textContent, /Usando a chave do provedor de chat/);
  assert.ok(!t.host.innerHTML.includes('gsk_'), 'nenhuma chave na tela');
  await t.h.cleanup();
});

test('Áudio: o campo da chave fica sempre à vista, sem "Trocar"; com chave diz "Chave guardada, cole outra para trocar" e vazio não muda nada', async () => {
  const t = await mountAudio({ settings: { transcriptionFallback: ['local'] } });
  const key = (i) => rows(t.host)[i].querySelector('.aud-key');
  assert.equal(key(0), null, 'o motor local não tem chave');
  assert.ok(key(1), 'Groq (chave do chat) mostra o campo');
  assert.equal(key(1).getAttribute('placeholder'), 'Chave guardada, cole outra para trocar');
  assert.equal(key(1).getAttribute('type'), 'password');
  assert.equal(key(1).value, '');
  assert.match(rows(t.host)[1].querySelector('.aud-detail').textContent, /Usando a chave do provedor de chat/);
  assert.equal(key(2).getAttribute('placeholder'), 'Cole a chave aqui', 'sem chave: pede colar');
  assert.equal(t.host.querySelector('.aud-key-change'), null, 'não há botão Trocar nem Usar outra');
  assert.equal(t.host.querySelector('.aud-keyrow'), null);
  await t.h.cleanup();
});

test('Áudio: Salvar e testar com o campo vazio não envia chave; colando uma, ela segue uma vez e o campo é limpo', async () => {
  const sets = [];
  const t = await mountAudio({ settings: { transcriptionFallback: ['local'] }, extra: {
    modulesCloudSet: async (patch) => { sets.push(patch); return { ok: true, data: { encryptionAvailable: true, providers: PROVIDERS } }; },
    modulesCloudTest: { ok: true, data: {} }
  } });
  click(t.h, rows(t.host)[1].querySelector('.aud-save'));
  await settle(30);
  assert.equal(sets.length, 1);
  assert.equal('apiKey' in sets[0], false, 'vazio não troca a chave');
  rows(t.host)[1].querySelector('.aud-key').value = '  gsk_nova_chave  ';
  click(t.h, rows(t.host)[1].querySelector('.aud-save'));
  await settle(30);
  assert.equal(sets[1].apiKey, 'gsk_nova_chave');
  assert.equal(rows(t.host)[1].querySelector('.aud-key').value, '', 'a chave enviada sai do campo');
  assert.ok(!t.host.innerHTML.includes('gsk_nova'), 'a chave não fica na tela');
  await t.h.cleanup();
});

test('Áudio: o que foi digitado num campo de chave sobrevive a um redesenho da lista (abrir outra linha)', async () => {
  const t = await mountAudio();
  rows(t.host)[2].querySelector('.aud-key').value = 'el_digitando';
  click(t.h, rows(t.host)[0].querySelector('.aud-toggle'));
  await settle(10);
  assert.equal(rows(t.host)[2].querySelector('.aud-key').value, 'el_digitando');
  await t.h.cleanup();
});

test('Áudio: "Salvar e testar" traz o nome do motor no aria-label; Remover a chave guardada continua confirmando', async () => {
  const t = await mountAudio({ settings: { transcriptionFallback: ['local'] } });
  const saves = rows(t.host).map((r) => r.querySelector('.aud-save')).filter(Boolean);
  assert.deepEqual(saves.map((b) => b.getAttribute('aria-label')), ['Salvar e testar Groq', 'Salvar e testar ElevenLabs']);
  assert.ok(saves.every((b) => /Salvar e testar$/.test(b.textContent.trim())));
  await t.h.cleanup();
});

test('Áudio: com um motor só (sem os serviços de nuvem) as setas nem são desenhadas', async () => {
  const t = await mountAudio({ extra: { modulesCloudGet: { ok: false, error: 'indisponível' } } });
  assert.equal(rows(t.host).length, 1);
  assert.equal(rows(t.host)[0].querySelector('.aud-up'), null);
  assert.equal(rows(t.host)[0].querySelector('.aud-down'), null);
  assert.ok(rows(t.host)[0].querySelector('.aud-enabled'));
  await t.h.cleanup();
});

const provider = (label, baseUrl, counts) => ({ id: label.toLowerCase(), label, baseUrl, models: [], modelCounts: { chat: 0, audio: 0, image: 0, video: 0, ...counts } });

test('Áudio: catálogo dos provedores de chat só informa (sem seletor nem botão); Groq e OpenAI mandam ligar o motor, os demais dizem que falta motor', async () => {
  const t = await mountAudio({ ai: { providers: [
    provider('Groq', 'https://api.groq.com/openai/v1', { audio: 3 }),
    provider('OpenAI', 'https://api.openai.com/v1', { audio: 1 }),
    provider('LM Studio (local)', 'http://localhost:1234/v1', { audio: 2 }),
    provider('Sem áudio', 'https://api.exemplo.com/v1', { chat: 4 })
  ] } });
  const found = [...t.host.querySelectorAll('.aud-found')].map((e) => e.textContent);
  assert.equal(found.length, 3, 'só quem tem modelos de áudio');
  assert.match(found[0], /Modelos de áudio encontrados em Groq: 3\./);
  assert.match(found[0], /Ligue o Groq acima: ele usa a chave deste provedor\./);
  assert.match(found[1], /Modelos de áudio encontrados em OpenAI: 1\./);
  assert.match(found[1], /Ligue o OpenAI acima: ele usa a chave deste provedor\./);
  assert.match(found[2], /Modelos de áudio encontrados em LM Studio \(local\): 2\./);
  assert.match(found[2], /Ainda não há motor de transcrição para este endereço\./);
  assert.equal(t.host.querySelector('.aud-catalog button, .aud-catalog select, .aud-catalog input'), null);
  assert.equal(rows(t.host).length, 3, 'a lista de motores não muda');
  await t.h.cleanup();
});

test('Áudio: provedor desligado ou com o aviso de servidor externo pendente não promete a chave; a dica manda ativar e aceitar', async () => {
  const t = await mountAudio({ ai: { providers: [
    { ...provider('Groq', 'https://api.groq.com/openai/v1', { audio: 3 }), enabled: true, needsRemoteConsent: true },
    { ...provider('OpenAI', 'https://api.openai.com/v1', { audio: 1 }), enabled: false, needsRemoteConsent: false },
    { ...provider('Groq 2', 'https://api.groq.com/openai/v1', { audio: 2 }), enabled: true, needsRemoteConsent: false }
  ] } });
  const found = [...t.host.querySelectorAll('.aud-found')].map((e) => e.textContent);
  assert.match(found[0], /Ative o Groq em Chat e aceite o aviso de servidor externo: o motor usa a chave dele\./);
  assert.match(found[1], /Ative o OpenAI em Chat e aceite o aviso de servidor externo/);
  assert.match(found[2], /Ligue o Groq acima: ele usa a chave deste provedor\./);
  await t.h.cleanup();
});

test('Áudio: sem catálogo de áudio (ou sem a leitura da IA) a seção fica como antes', async () => {
  const none = await mountAudio({ ai: { providers: [provider('Groq', 'https://api.groq.com/openai/v1', { chat: 2 })] } });
  assert.equal(none.host.querySelector('.aud-catalog'), null);
  await none.h.cleanup();
  const absent = await mountAudio();
  assert.equal(absent.host.querySelector('.aud-catalog'), null);
  await absent.h.cleanup();
});

test('Áudio: o texto da seção não cita nomes de motores internos', async () => {
  const t = await mountAudio();
  assert.doesNotMatch(t.host.textContent, /whisper|ffmpeg|cuda|sha-?256/i);
  await t.h.cleanup();
});

// ------------------------------------------------------------------ imagem e vídeo

test('Imagem: descreve o modelo local que entende imagens, o que falta e quando não há', async () => {
  const mod = await import(`${url('ai-media-sections.js')}?t=${++seq}`);
  const ok = mod.describeImage({ supported: true, installed: true, vision: true, modelLabel: 'Qwen3-VL 4B' });
  assert.equal(ok.ok, true);
  assert.match(ok.title, /Qwen3-VL 4B/);
  assert.match(ok.hint, /organização das fotos/);
  const other = mod.describeImage({ supported: true, installed: true, vision: false, models: [{ id: 'a', label: 'Qwen3-VL 2B', vision: true, installed: true }] });
  assert.equal(other.ok, false);
  assert.match(other.hint, /Qwen3-VL 2B/);
  assert.equal(other.action, true);
  const none = mod.describeImage({ supported: true, installed: false, vision: false, models: [{ id: 'a', vision: true, installed: false }] });
  assert.match(none.title, /Nenhum disponível/);
  assert.equal(none.action, true);
  assert.equal(mod.describeImage({ supported: false }).action, false);
  assert.equal(mod.describeImage(null).ok, false);
});

async function mountMedia(ai, local = { supported: true, installed: true, vision: true, modelLabel: 'Qwen3-VL 2B' }) {
  const h = await mountScreen('luts', {
    init: false,
    bds: { aiLocalLlmStatus: { ok: true, data: local }, ...(ai ? { aiGetConfig: { ok: true, data: ai } } : {}) }
  });
  const wrapper = h.document.createElement('section');
  wrapper.className = 'ana-sec';
  const image = h.document.createElement('div');
  const video = h.document.createElement('div');
  wrapper.append(video);
  h.document.body.append(image, wrapper);
  const mod = await import(`${url('ai-media-sections.js')}?t=${++seq}`);
  await mod.renderMediaSections({ image, video });
  await settle(10);
  return { h, image, video, wrapper };
}

test('Imagem lê o estado do modelo local e acrescenta, por provedor, quantos modelos do catálogo entendem imagens (só informação)', async () => {
  const t = await mountMedia({ providers: [
    provider('Groq', 'https://api.groq.com/openai/v1', { image: 2 }),
    provider('OpenAI', 'https://api.openai.com/v1', { image: 1 }),
    provider('Sem imagem', 'https://api.exemplo.com/v1', { chat: 3 })
  ] });
  assert.match(t.image.textContent, /Qwen3-VL 2B/);
  const lines = [...t.image.querySelectorAll('.med-catalog')].map((e) => e.textContent);
  assert.deepEqual(lines, ['Também entendem imagens: 2 modelos em Groq (uso em breve).', 'Também entendem imagens: 1 modelo em OpenAI (uso em breve).']);
  assert.equal(t.image.querySelector('button'), null, 'quando está tudo certo não há botão');
  await t.h.cleanup();
});

// ------------------------------------------------------------------ atalho único para "Neste computador"

const shortcutOf = (el) => [...el.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Gerenciar modelos neste computador');
const listenOpenSub = (h) => { const got = []; h.window.addEventListener('bds:ai-open-sub', (e) => got.push(e.detail)); return got; };

test('Atalho único: Áudio só mostra "Gerenciar modelos" quando falta algo instalado; pronto vira frase na dica', async () => {
  const ready = await mountAudio();
  const localDetail = rows(ready.host)[0].querySelector('.aud-detail');
  assert.equal(shortcutOf(localDetail).length, 0, 'tudo pronto: sem botão');
  assert.match(localDetail.textContent, /Usa o modelo Small\. Nada sai do computador\. Para trocar ou apagar modelos, abra "Neste computador"\./);
  await ready.h.cleanup();

  const noEngine = await mountAudio({ extra: { modulesGetStatus: { ok: true, data: { whisper: { ready: false, engine: { installed: false }, models: [] } } } } });
  const open = listenOpenSub(noEngine.h);
  const btns = shortcutOf(rows(noEngine.host)[0].querySelector('.aud-detail'));
  assert.equal(btns.length, 1, 'sem a transcrição instalada: o atalho aparece');
  assert.equal(btns[0].textContent.replace(/^tune/, ''), 'Gerenciar modelos');
  assert.equal(btns[0].getAttribute('title'), 'Gerenciar modelos neste computador');
  click(noEngine.h, btns[0]);
  assert.deepEqual(open, ['local'], 'o mesmo evento de sempre, abrindo o subpainel Neste computador');
  await noEngine.h.cleanup();

  const noModel = await mountAudio({ extra: { modulesGetStatus: { ok: true, data: { whisper: { ready: false, engine: { installed: true }, models: [{ id: 'small', label: 'Small', active: false }] } } } } });
  assert.equal(shortcutOf(rows(noModel.host)[0].querySelector('.aud-detail')).length, 1, 'transcrição instalada, mas sem modelo em uso: o atalho aparece');
  await noModel.h.cleanup();
});

test('Atalho único: Imagem usa o mesmo botão (mesmo rótulo e aria-label) só quando falta algo, e o evento não muda', async () => {
  const missing = await mountMedia(null, { supported: true, installed: false, vision: false, models: [{ id: 'a', vision: true, installed: false }] });
  const open = listenOpenSub(missing.h);
  const btns = shortcutOf(missing.image);
  assert.equal(btns.length, 1);
  assert.equal(btns[0].textContent.replace(/^tune/, ''), 'Gerenciar modelos');
  assert.equal(missing.image.querySelectorAll('button').length, 1, 'continua um botão só');
  click(missing.h, btns[0]);
  assert.deepEqual(open, ['local']);
  await missing.h.cleanup();

  const ready = await mountMedia(null);
  assert.equal(ready.image.querySelector('button'), null, 'pronto: nenhum botão');
  await ready.h.cleanup();
});

test('Vídeo: a seção INTEIRA some sem modelos de vídeo no catálogo e aparece (só leitura) com eles', async () => {
  const without = await mountMedia({ providers: [provider('Groq', 'https://api.groq.com/openai/v1', { chat: 2, image: 1 })] });
  assert.equal(without.wrapper.hidden, true, 'o contêiner .ana-sec some, não só o conteúdo');
  assert.equal(without.video.textContent, '');
  await without.h.cleanup();

  const absent = await mountMedia(null);
  assert.equal(absent.wrapper.hidden, true, 'sem leitura da IA também some');
  assert.match(absent.image.textContent, /Qwen3-VL 2B/, 'Imagem continua mostrando o modelo local');
  await absent.h.cleanup();

  const withVideo = await mountMedia({ providers: [provider('Provedor X', 'https://api.exemplo.com/v1', { video: 2 }), provider('Provedor Y', 'https://api.outro.com/v1', { video: 1 })] });
  assert.equal(withVideo.wrapper.hidden, false);
  assert.match(withVideo.video.textContent, /O app ainda não usa vídeo\./);
  assert.deepEqual([...withVideo.video.querySelectorAll('.med-catalog')].map((e) => e.textContent), ['Provedor X: 2 modelos de vídeo.', 'Provedor Y: 1 modelo de vídeo.']);
  assert.equal(withVideo.video.querySelector('button, select, input'), null, 'lista só de leitura');
  await withVideo.h.cleanup();
});

// ------------------------------------------------------------------ menu único e submenu

test('Configurações: a aba Transcrição não existe; IA tem submenu com 4 itens e cada subpainel existe', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="settingsTranscriptionView"/);
  assert.doesNotMatch(html, /id="settingsTranscriptionView"/);
  const aiView = html.slice(html.indexOf('id="settingsAiView"'), html.indexOf('id="settingsLutsView"'));
  const subs = [...aiView.matchAll(/data-sub="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(subs, ['assistant', 'providers', 'local', 'agents']);
  for (const s of subs) assert.match(aiView, new RegExp(`data-sub-panel="${s}"`), s);
  assert.doesNotMatch(html, /data-ai-sub|data-ai-panel/, 'a IA usa o mesmo submenu genérico das outras abas');
  assert.match(html, /Claude, ChatGPT e outros \(HTTP\)/);
  assert.match(html, /<option value="antigravity">Antigravity<\/option>/);
  assert.doesNotMatch(html, /\bAlice\b|\bLiz\b/);
  assert.equal((html.match(/id="settingsCloudCard"/g) || []).length, 0, 'o card da nuvem foi para a seção Áudio');
  assert.doesNotMatch(html, /trFallback/);
});

test('os atalhos de fora pedem o subpainel pela chave de sessão que o submenu lê', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const file of ['renderer/screens/settings.js', 'renderer/screens/transcription.js', 'renderer/components/ai-assistant.js']) {
    assert.match(read(file), /bdsAiSubRequest/, file);
  }
  assert.doesNotMatch(read('renderer/screens/transcription.js'), /settingsTranscriptionView/);
  assert.doesNotMatch(read('renderer/screens/settings.js'), /settingsTranscriptionView/);
});
