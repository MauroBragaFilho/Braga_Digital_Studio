'use strict';

// P22: o campo thumbnail do pacote .bdspro só aceita nome simples de imagem.
const test = require('node:test');
const assert = require('node:assert');
const { validateProjectData } = require('../src/core/projects/BdsproPackageService');

test('thumbnail do pacote: aceita nome de imagem e reduz caminho ao nome base', () => {
    const data = { media: [
        { thumbnail: 'abc-123.jpg' },
        { thumbnail: 'C:\\Users\\x\\Thumbnails\\abc_9.png' },
        { thumbnail: '/home/x/Thumbnails/def.webp' },
    ] };
    validateProjectData(data);
    assert.deepStrictEqual(data.media.map((m) => m.thumbnail), ['abc-123.jpg', 'abc_9.png', 'def.webp']);
});

test('thumbnail do pacote: descarta arquivos que não são imagem ou nomes inseguros', () => {
    const data = { media: [
        { thumbnail: 'C:\\Users\\x\\Documents\\senhas.txt' },
        { thumbnail: '../../segredo.jpg.exe' },
        { thumbnail: '.jpg' },
        { thumbnail: 42 },
    ] };
    validateProjectData(data);
    assert.deepStrictEqual(data.media.map((m) => m.thumbnail), [null, null, null, null]);
});
