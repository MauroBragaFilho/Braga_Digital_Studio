#!/usr/bin/env node
'use strict';

/**
 * release-tag.js — publica uma release do BDS em um passo: sobe a versão do package.json, faz o commit
 * "chore(release): vX.Y.Z", cria a tag anotada vX.Y.Z e envia commit e tag ao remoto. O envio da tag dispara
 * o workflow "Release BDS (Windows + Linux)" (.github/workflows/release-bds.yml), que gera e publica os instaladores.
 *
 *   node scripts/release-tag.js              pergunta a versão (sugere o próximo patch) e confirma
 *   node scripts/release-tag.js 1.0.8        usa a versão informada (ainda confirma)
 *   node scripts/release-tag.js --dry-run    mostra o que faria, sem alterar nada
 *   node scripts/release-tag.js --yes        não pede confirmação (uso em automação)
 *
 * Recusa quando: há alterações não commitadas, a tag já existe (local ou remoto), a versão não é X.Y.Z
 * ou o remoto está à frente da branch atual.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const yes = args.includes('--yes');
const requested = args.find((a) => !a.startsWith('--')) || '';

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function run(cmd, a) {
  console.log(`> ${cmd} ${a.join(' ')}`);
  if (dryRun) return '';
  return execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' && cmd === 'npm' });
}
function fail(msg) {
  console.error(`\nERRO: ${msg}`);
  process.exit(1);
}
function ask(question, fallback) {
  if (yes) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim() || fallback); }));
}
function nextPatch(version) {
  const [a, b, c] = version.split('.').map((n) => parseInt(n, 10) || 0);
  return `${a}.${b}.${c + 1}`;
}
const VERSION_RE = /^\d+\.\d+\.\d+$/;

(async () => {
  const pkgPath = path.join(ROOT, 'package.json');
  const current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  console.log(`Versão atual no package.json: ${current}${dryRun ? '   [simulação: nada será alterado]' : ''}`);

  // 1. Árvore limpa (a release precisa sair exatamente do que está commitado)
  const dirty = git('status', '--porcelain');
  if (dirty) fail(`há alterações não commitadas. Faça o commit (ou guarde-as) antes de publicar:\n${dirty}`);

  // 2. Branch e remoto
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  // A release só é assinada e publicada a partir da main (o release-bds.yml confere isso).
  if (branch !== 'main') fail(`a release sai da branch main, e você está em "${branch}". Integre as mudanças na main e rode de novo a partir dela.`);
  let upstream = '';
  try { upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'); } catch (_) { upstream = ''; }
  const remote = upstream ? upstream.split('/')[0] : 'origin';
  const remoteBranch = upstream ? upstream.slice(remote.length + 1) : branch;
  console.log(`Branch ${branch} -> ${remote}/${remoteBranch}`);
  console.log('Consultando o remoto...');
  git('fetch', '--quiet', '--tags', remote);
  try {
    git('merge-base', '--is-ancestor', `${remote}/${remoteBranch}`, 'HEAD');
  } catch (_) {
    fail(`o remoto ${remote}/${remoteBranch} tem commits que não estão nesta branch. Integre-os antes (git pull) e tente de novo.`);
  }

  // 3. Versão
  const suggested = nextPatch(current);
  const version = requested || await ask(`Nova versão [${suggested}]: `, suggested);
  if (!VERSION_RE.test(version)) fail(`versão "${version}" fora do formato X.Y.Z.`);
  const tag = `v${version}`;
  const localTags = git('tag', '-l', tag);
  if (localTags) fail(`a tag ${tag} já existe neste repositório.`);
  const remoteTags = git('ls-remote', '--tags', remote, `refs/tags/${tag}`);
  if (remoteTags) fail(`a tag ${tag} já existe em ${remote}.`);

  console.log(`\nSerá feito:\n  1. package.json e package-lock.json -> ${version}\n  2. commit "chore(release): ${tag}"\n  3. tag anotada ${tag}\n  4. push de ${branch} para ${remote}/${remoteBranch} e da tag ${tag}\n`);
  const ok = await ask(`Criar e enviar a release ${tag} agora? (s/N): `, 'n');
  if (!/^s(im)?$/i.test(ok) && !yes) { console.log('Cancelado. Nada foi alterado.'); return; }

  // 4. Executa
  if (version !== current) {
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
    run('git', ['add', 'package.json', 'package-lock.json']);
    run('git', ['commit', '-q', '-m', `chore(release): ${tag}`]);
  } else {
    console.log('A versão já é a do package.json: sem commit de versão.');
  }
  run('git', ['tag', '-a', tag, '-m', `BDS ${tag}`]);
  run('git', ['push', remote, `HEAD:${remoteBranch}`]);
  run('git', ['push', remote, tag]);

  if (dryRun) { console.log('\nSimulação concluída: nada foi alterado.'); return; }
  let origin = '';
  try { origin = git('remote', 'get-url', remote).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/'); } catch (_) { /* sem URL */ }
  console.log(`\nTag ${tag} enviada. O workflow de release foi disparado.`);
  if (origin) console.log(`Acompanhe em: ${origin}/actions`);
  console.log('Os instaladores são publicados em: https://github.com/MauroBragaFilho/Braga_Digital_Studio/releases');
})().catch((err) => fail(err && err.message ? err.message : String(err)));
