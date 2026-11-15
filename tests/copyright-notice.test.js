'use strict';

// Aviso de direitos autorais (itens F-49, F-50, F-84 e F-108 da análise de conformidade): um esclarecimento permanente,
// sem aceite e sem bloqueio, na tela de Downloads, no instalador e no README. Estes testes só impedem que o aviso suma
// sem querer e que a pausa entre downloads volte a ser descrita como forma de driblar o robô do site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const flat = (s) => s.replace(/\s+/g, ' ');

test('tela de Downloads: aviso permanente de direitos autorais, com estilo próprio', () => {
  const html = flat(read('renderer/screens/download.html'));
  assert.match(html, /id="downloadsRightsNote"/);
  assert.match(html, /Baixe só o que você tem direito de baixar/);
  assert.match(html, /direitos autorais e os termos de cada site é responsabilidade de quem baixa/);
  assert.match(html, /usá-las em um vídeo publicado exige licença/);
  assert.match(read('renderer/screens/download.css'), /\.downloads-rights-note\s*\{/);
});

test('o aviso dos Downloads só esclarece: não tem caixa de aceite, botão nem link', () => {
  const m = /<p id="downloadsRightsNote"[^>]*>([\s\S]*?)<\/p>/.exec(read('renderer/screens/download.html'));
  assert.ok(m, 'parágrafo do aviso não encontrado');
  assert.doesNotMatch(m[1], /<(input|button|a)\b/i);
});

test('a pausa entre downloads é descrita como ritmo moderado, não como forma de enganar o robô do site', () => {
  const settings = read('renderer/screens/settings.html');
  assert.doesNotMatch(settings, /não tratar a fila como robô/);
  assert.doesNotMatch(settings, /ritmo de robô/);
  assert.match(settings, /ritmo moderado e não sobrecarregar o site/);
  assert.doesNotMatch(read('renderer/screens/download.js'), /evita bloqueio do YouTube/);
  assert.doesNotMatch(read('src/services/downloadService.js'), /trate a fila como robô/);
  assert.doesNotMatch(read('src/core/settings/SettingsManager.js'), /evita bloqueio do YouTube/);
});

test('o aviso das Configurações dos agentes lembra que a responsabilidade pelo que é baixado continua do usuário', () => {
  assert.match(flat(read('renderer/screens/settings.html')), /Você continua responsável pelo que for baixado: direitos autorais e termos de cada site/);
});

test('instalador: a página de boas-vindas traz o mesmo esclarecimento (e a de atualização continua pulada)', () => {
  const nsh = flat(read('installer/installer.nsh'));
  assert.match(nsh, /MUI_WELCOMEPAGE_TEXT "[^"]*Baixe só o que você tem direito de baixar/);
  assert.match(nsh, /direitos autorais e os termos de cada site é responsabilidade de quem baixa/);
  assert.match(nsh, /MUI_PAGE_CUSTOMFUNCTION_PRE BdsSkipIfUpdated\s+!define MUI_WELCOMEPAGE_TITLE/);
});

test('README em português e em inglês: seção de direitos autorais antes da licença', () => {
  const pt = read('README.md');
  const en = read('README.en.md');
  const hPt = pt.indexOf('## ⚖️ Direitos autorais e uso responsável');
  const hEn = en.indexOf('## ⚖️ Copyright and responsible use');
  assert.ok(hPt > 0 && hPt < pt.indexOf('## 📄 Licença'));
  assert.ok(hEn > 0 && hEn < en.indexOf('## 📄 License'));
  assert.match(flat(pt), /usá-las como trilha de um vídeo publicado exige licença/);
  assert.match(flat(en), /soundtrack of a published video requires a license/);
});
