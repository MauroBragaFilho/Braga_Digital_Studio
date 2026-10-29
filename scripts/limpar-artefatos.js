#!/usr/bin/env node
'use strict';

/**
 * limpar-artefatos.js — apaga os artefatos de GitHub Actions de TODOS os repositórios da conta, para liberar a cota
 * de armazenamento (500 MB no plano gratuito). Os artefatos são só o que os jobs de build trocam entre si; as
 * Releases (instaladores publicados) não são tocadas.
 *
 *   node scripts/limpar-artefatos.js              apaga (pede confirmação)
 *   node scripts/limpar-artefatos.js --dry-run    só lista o que apagaria e o total
 *   node scripts/limpar-artefatos.js --yes        não pede confirmação
 *
 * Token: variável de ambiente GH_TOKEN (ou GITHUB_TOKEN). Sem ela, o script pede o token na hora, sem mostrar na
 * tela, e não o guarda em lugar nenhum. Crie um token em GitHub -> Settings -> Developer settings:
 *   - fine-grained: "All repositories" com Actions: Read and write (e Metadata: Read);
 *   - ou clássico: escopo "repo".
 * Lembrete do GitHub: a cota é recalculada a cada 6-12 horas depois de apagar.
 */

const https = require('node:https');
const readline = require('node:readline');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const yes = args.includes('--yes');
const API = 'api.github.com';

function request(method, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API, path, method,
      headers: {
        'User-Agent': 'bds-limpar-artefatos',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 204) return resolve({ status: 204, data: null, headers: res.headers });
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch (_) { data = body; }
        if (res.statusCode >= 400) {
          const msg = (data && data.message) || `HTTP ${res.statusCode}`;
          return reject(Object.assign(new Error(`${method} ${path}: ${msg}`), { status: res.statusCode }));
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lê o token sem ecoar na tela. */
function askToken() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const original = rl._writeToOutput;
    rl.question('Token do GitHub (não aparece ao digitar): ', (answer) => {
      rl._writeToOutput = original;
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    rl._writeToOutput = function (s) { if (/\r?\n$/.test(s)) original.call(rl, '\n'); else if (/Token do GitHub/.test(s)) original.call(rl, s); };
  });
}

function ask(question, fallback) {
  if (yes) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim() || fallback); }));
}

async function listAll(path, token, key) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const { data } = await request('GET', `${path}${sep}per_page=100&page=${page}`, token);
    const items = key ? (data && data[key]) || [] : data || [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const mb = (n) => (n / 1048576).toFixed(1);

const COMO_OBTER_O_TOKEN = `
Como criar o token (uma vez; ele vale pelo prazo que você escolher):
  1. No GitHub, clique na sua foto (canto superior direito) -> Settings.
  2. No fim do menu da esquerda: Developer settings -> Personal access tokens -> Fine-grained tokens.
  3. Generate new token. Dê um nome (ex.: "limpar artefatos"), escolha a validade
     e em "Repository access" marque "All repositories".
  4. Em "Permissions" -> "Repository permissions", coloque "Actions" como "Read and write"
     ("Metadata: Read" é marcado sozinho).
  5. Generate token e copie o código (começa com "github_pat_"). Ele só aparece uma vez.
  6. Cole aqui (botão direito do mouse ou Ctrl+V) e aperte Enter. O token não aparece ao digitar
     e não fica salvo em lugar nenhum.
`;

(async () => {
  const tokenArg = args.find((a, i) => args[i - 1] === '--token');
  let token = tokenArg || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) {
    console.log(COMO_OBTER_O_TOKEN);
    token = await askToken();
  }
  if (!token) { console.error('ERRO: sem token.'); process.exit(1); }

  const me = (await request('GET', '/user', token)).data;
  console.log(`Conta: ${me.login}${dryRun ? '   [simulação: nada será apagado]' : ''}`);

  // Repositórios dos quais a conta é dona (inclui privados, que são os que pesam na cota)
  const repos = await listAll('/user/repos?affiliation=owner&sort=pushed', token);
  console.log(`Repositórios: ${repos.length}\n`);

  const found = [];
  for (const repo of repos) {
    let artifacts = [];
    try {
      artifacts = await listAll(`/repos/${repo.full_name}/actions/artifacts`, token, 'artifacts');
    } catch (err) {
      if (err.status === 404 || err.status === 403) continue; // sem Actions ou sem permissão: ignora
      throw err;
    }
    const live = artifacts.filter((a) => !a.expired);
    if (!live.length) continue;
    const size = live.reduce((s, a) => s + (a.size_in_bytes || 0), 0);
    console.log(`${repo.full_name}: ${live.length} artefato(s), ${mb(size)} MB`);
    for (const a of live) found.push({ repo: repo.full_name, ...a });
  }

  const total = found.reduce((s, a) => s + (a.size_in_bytes || 0), 0);
  if (!found.length) { console.log('Nenhum artefato ativo. A cota deve voltar no próximo recálculo do GitHub (6-12 h).'); return; }
  console.log(`\nTotal: ${found.length} artefato(s), ${mb(total)} MB`);
  if (dryRun) { console.log('Simulação concluída: nada foi apagado.'); return; }

  const ok = await ask(`Apagar todos? (s/N): `, 'n');
  if (!/^s(im)?$/i.test(ok) && !yes) { console.log('Cancelado.'); return; }

  let deleted = 0; let freed = 0;
  for (const a of found) {
    try {
      await request('DELETE', `/repos/${a.repo}/actions/artifacts/${a.id}`, token);
      deleted++; freed += a.size_in_bytes || 0;
      console.log(`apagado: ${a.repo} / ${a.name} (${mb(a.size_in_bytes || 0)} MB)`);
    } catch (err) {
      console.log(`falhou: ${a.repo} / ${a.name}: ${err.message}`);
    }
  }
  console.log(`\n${deleted} artefato(s) apagados, ${mb(freed)} MB liberados. O GitHub recalcula a cota em 6-12 horas.`);
})().catch((err) => {
  console.error(`\nERRO: ${err.message}`);
  if (err.status === 401) console.error('Token inválido ou expirado.');
  if (err.status === 403) console.error('Token sem permissão: precisa de Actions: Read and write (fine-grained) ou escopo "repo" (clássico).');
  process.exit(1);
});
