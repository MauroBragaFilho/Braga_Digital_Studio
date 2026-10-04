'use strict';

// Interface do grupo "produção": nenhum nome de motor/serviço interno nos textos das telas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SCREENS_DIR } = require('./helpers/renderer-harness');

const FORBIDDEN = /yt-dlp|youtube-dl|ffmpeg|ffprobe|whisper|ggml|spotdl|untrunc|exiftool|librawn|rawpy|sql\.js|sqlite|cuda|cublas|direct stream|stream copy|spotify/i;

for (const name of ['download', 'converter', 'silence', 'metadata', 'transcription', 'upload']) {
  test(`${name}.html sem nomes de motores`, () => {
    const html = fs.readFileSync(path.join(SCREENS_DIR, `${name}.html`), 'utf8');
    assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), FORBIDDEN);
  });
}

test('download.js: rótulos de música não exibem a marca', () => {
  const js = fs.readFileSync(path.join(SCREENS_DIR, 'download.js'), 'utf8');
  const strings = js.match(/(['"`])(?:(?!\1)[^\\n]|\.)*\1/g) || [];
  const bad = strings.filter((s) => /spotify/i.test(s) && !/spotify\.com/i.test(s));
  assert.deepEqual(bad, []);
});

test('todas as telas de produção importam o tradutor de erros (exceto upload)', () => {
  for (const name of ['download', 'converter', 'silence', 'metadata', 'transcription']) {
    const js = fs.readFileSync(path.join(SCREENS_DIR, `${name}.js`), 'utf8');
    assert.match(js, /friendlyError\.js/, name);
    assert.doesNotMatch(js, /\$\{(?:err|e|error)\.message\}/, `${name}: err.message cru na interface`);
  }
});
