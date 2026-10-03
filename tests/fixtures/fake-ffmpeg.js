'use strict';
/**
 * ffmpeg de mentira para os testes: "converte" o arquivo de entrada em um WAV mono 16 kHz.
 * A duração vem do texto do arquivo de entrada ("SECONDS=12"; padrão 5 s). Se o texto tiver "NOAUDIO",
 * falha como o ffmpeg real faz com um arquivo sem faixa de áudio.
 */
const fs = require('node:fs');

const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const output = args[args.length - 1];

let text = '';
try { text = fs.readFileSync(input, 'utf8').slice(0, 200); } catch (_) {
  console.error(`${input}: No such file or directory`);
  process.exit(1);
}
if (text.includes('NOAUDIO')) {
  console.error('Output file does not contain any stream');
  process.exit(1);
}
if (text.includes('CORRUPT')) {
  console.error('Invalid data found when processing input');
  process.exit(1);
}

const seconds = Number((/SECONDS=(\d+)/.exec(text) || [])[1]) || 5;
const dataBytes = seconds * 16000 * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
fs.writeFileSync(output, Buffer.concat([header, Buffer.alloc(dataBytes)]));
