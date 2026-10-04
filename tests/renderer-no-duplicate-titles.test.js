'use strict';

// O nome da tela já aparece na barra superior do app (#globalPageTitle, vindo do menu lateral).
// Nenhuma tela de produção deve repetir esse nome como título (h1/h2) dentro do próprio conteúdo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const DEV_ONLY = new Set(['recovery', 'montage']);

function navLabels() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const out = new Map();
  for (const m of html.matchAll(/<button[^>]*data-view="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const label = m[2].replace(/<span[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (label) out.set(m[1], label);
  }
  return out;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

test('o menu lateral tem as telas e seus nomes', () => {
  const labels = navLabels();
  assert.ok(labels.size >= 12);
  assert.equal(labels.get('settings'), 'Configurações');
});

test('nenhuma tela de produção repete o nome da tela como título (h1/h2) no conteúdo', () => {
  const labels = navLabels();
  const names = new Set([...labels].filter(([id]) => !DEV_ONLY.has(id)).map(([, label]) => norm(label)));
  const repeated = [];
  for (const [id] of labels) {
    if (DEV_ONLY.has(id)) continue;
    const file = path.join(RENDERER, 'screens', `${id}.html`);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/g)) {
      const text = norm(m[1].replace(/<[^>]+>/g, ''));
      if (names.has(text) && text === norm(labels.get(id))) repeated.push(`${id}.html: "${text}"`);
    }
  }
  assert.deepEqual(repeated, [], 'título repetido (já aparece na barra superior)');
});
