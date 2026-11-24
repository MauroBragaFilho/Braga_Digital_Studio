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

async function mountAudio({ settings = {}, confirm = true } = {}) {
  const saved = [];
  const h = await mountScreen('luts', {
    init: false,
    bds: {
      modulesCloudGet: { ok: true, data: { encryptionAvailable: true, providers: PROVIDERS } },
      modulesGetStatus: { ok: true, data: { whisper: { ready: true, engine: { installed: true }, models: [{ id: 'small', label: 'Small', active: true }] } } },
      getSettings: async () => ({ transcriptionOrder: ['local', 'groq', 'elevenlabs'], transcriptionFallback: ['local'], ...settings }),
      saveSettings: async (patch) => { saved.push(patch); return {}; }
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

test('Vídeo: aparece como "Ainda não disponível"; Imagem lê o estado do modelo local', async () => {
  const h = await mountScreen('luts', {
    init: false,
    bds: { aiLocalLlmStatus: { ok: true, data: { supported: true, installed: true, vision: true, modelLabel: 'Qwen3-VL 2B' } } }
  });
  const image = h.document.createElement('div');
  const video = h.document.createElement('div');
  h.document.body.append(image, video);
  const mod = await import(`${url('ai-media-sections.js')}?t=${++seq}`);
  await mod.renderMediaSections({ image, video });
  await settle(10);
  assert.match(video.textContent, /Ainda não disponível/);
  assert.match(image.textContent, /Qwen3-VL 2B/);
  assert.equal(image.querySelector('button'), null, 'quando está tudo certo não há botão');
  await h.cleanup();
});

// ------------------------------------------------------------------ menu único e submenu

test('Configurações: a aba Transcrição não existe; IA tem submenu com 4 itens e cada subpainel existe', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'screens', 'settings.html'), 'utf8');
  assert.doesNotMatch(html, /data-tab="settingsTranscriptionView"/);
  assert.doesNotMatch(html, /id="settingsTranscriptionView"/);
  const subs = [...html.matchAll(/data-ai-sub="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(subs, ['assistant', 'providers', 'local', 'agents']);
  for (const s of subs) assert.match(html, new RegExp(`data-ai-panel="${s}"`), s);
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
