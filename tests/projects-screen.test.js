'use strict';

// Tela Projetos (.docs/BDS_TELA_PROJETOS.md): 7 status com migração dos 3 antigos, colunas permitidas no update,
// duplicar, resumo, dispositivos, entrega, atividade, .bdspro 1.1.0 e a lista com busca/filtro/ordenação/menu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const core = require('../src/core/projects/projectStatus');
const dbManager = require('../src/core/database/database');
const { runMigrations } = require('../src/core/database/migrations');
const projects = require('../src/core/projects/ProjectService');
const { mountScreen, settle } = require('./helpers/renderer-harness');

let tmp;
test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-proj-'));
  await dbManager.init(tmp);
  assert.equal(runMigrations().ok, true);
});
test.after(() => { try { dbManager.close?.(); } catch (_) { /* já fechado */ } fs.rmSync(tmp, { recursive: true, force: true }); });

test('vocabulário: o renderer repete exatamente os status, tons, ícones e a migração do main', async () => {
  const ui = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'utils', 'projectStatus.js')).href);
  assert.deepEqual(ui.STATUSES.map((s) => [s.id, s.tone, s.icon]), core.STATUSES.map((s) => [s.id, s.tone, s.icon]));
  assert.deepEqual(ui.LEGACY_STATUS, core.LEGACY_STATUS);
  assert.deepEqual([...ui.DELIVERY_STATUSES], [...core.DELIVERY_STATUSES]);
  assert.deepEqual(ui.DEVICE_CATEGORIES.map((c) => c.id), core.DEVICE_CATEGORY_IDS);
  for (const v of ['Ativo', 'Pausado', 'Concluído', 'Problema', '', null, 'qualquer']) assert.equal(ui.normalizeStatus(v), core.normalizeStatus(v));
  assert.equal(core.normalizeStatus('Ativo'), 'Em produção');
  assert.equal(core.normalizeStatus('Pausado'), 'Aguardando cliente');
  assert.equal(core.normalizeStatus('inventado'), 'Planejamento');
  // os dois <select> de status (formulário e área interna) têm os 7 estados na mesma ordem
  for (const f of ['projects.html', 'project_workspace.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'screens', f), 'utf8');
    const id = f.startsWith('projects') ? 'projFormStatus' : 'wsProjectStatus';
    const block = html.match(new RegExp(`id="${id}"[\\s\\S]*?</select>`))[0];
    assert.deepEqual([...block.matchAll(/value="([^"]+)"/g)].map((m) => m[1]), [...core.STATUS_IDS], f);
  }
});

test('migração 14: status antigos viram os novos e as tabelas de dispositivos, atividade e entrega existem', () => {
  const db = dbManager.get();
  const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  assert.ok(cols.includes('updated_at') && cols.includes('last_activity_at'));
  for (const t of ['project_devices', 'project_activity', 'project_delivery']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  }
  // simula linhas gravadas antes da migração e roda o mapeamento de novo (idempotente)
  db.prepare("INSERT INTO projects (name, status) VALUES ('Antigo A', 'Ativo'), ('Antigo P', 'Pausado'), ('Antigo C', 'Concluído'), ('Antigo X', 'zzz')").run();
  const { MIGRATIONS } = require('../src/core/database/migrations');
  MIGRATIONS.find((m) => m.version === 14).up(db);
  const byName = Object.fromEntries(db.prepare("SELECT name, status FROM projects WHERE name LIKE 'Antigo %'").all().map((r) => [r.name, r.status]));
  assert.deepEqual(byName, { 'Antigo A': 'Em produção', 'Antigo P': 'Aguardando cliente', 'Antigo C': 'Concluído', 'Antigo X': 'Planejamento' });
});

test('updateProject: só colunas permitidas (nada de nome de coluna vindo da tela) e status normalizado com atividade', () => {
  const id = projects.createProject({ name: 'Casamento João', client: 'João Silva', status: 'Ativo' });
  const p = projects.getProjectById(id);
  assert.equal(p.status, 'Em produção');
  assert.ok(p.last_activity_at, 'última atividade preenchida ao criar');
  assert.equal(projects.updateProject(id, { 'status = ?; DROP TABLE projects; --': 1 }), false, 'chave estranha é ignorada, nada é atualizado');
  assert.equal(projects.updateProject(id, { id: 999, name: 'Casamento João & Maria', created_at: '1999-01-01' }), true);
  const after = projects.getProjectById(id);
  assert.equal(after.name, 'Casamento João & Maria');
  assert.equal(after.id, id);
  assert.notEqual(String(after.created_at).slice(0, 4), '1999', 'created_at não é editável');
  projects.updateProject(id, { status: 'Pausado' });
  assert.equal(projects.getProjectById(id).status, 'Aguardando cliente');
  const kinds = projects.listActivity(id).map((a) => a.kind);
  assert.ok(kinds.includes('status') && kinds.includes('criado'));
  assert.equal(projects.archiveProject(id), true);
  assert.equal(projects.getProjectById(id).status, 'Arquivado');
  projects.deleteProject(id);
});

test('dispositivos, entrega, resumo e duplicar', () => {
  const db = dbManager.get();
  const id = projects.createProject({ name: 'Evento Cultural', client: 'Circuito' });
  projects.createBin(id, null, 'BRUTOS');
  const sub = projects.createBin(id, projects.getProjectBins(id)[0].id, 'SONY A');
  const m1 = db.prepare("INSERT INTO media (uuid, filename, filepath, filesize, media_type, status) VALUES ('u1', 'a.mp4', 'D:/x/a.mp4', 1000, 'video', 'READY')").run().lastInsertRowid;
  const m2 = db.prepare("INSERT INTO media (uuid, filename, filepath, filesize, media_type, status) VALUES ('u2', 'b.wav', 'D:/x/b.wav', 500, 'audio', 'READY')").run().lastInsertRowid;
  projects.addMediaBulkToProject(id, sub, [m1, m2]);

  const devId = projects.addDevice(id, { category: 'camera', name: '  Sony A6300  ', note: 'cartão A' });
  projects.addDevice(id, { category: 'inexistente', name: 'Tascam DR-40' });
  assert.throws(() => projects.addDevice(id, { category: 'audio', name: '   ' }), /nome/i);
  const devices = projects.listDevices(id);
  assert.deepEqual(devices.map((d) => [d.category, d.name]), [['camera', 'Sony A6300'], ['other', 'Tascam DR-40']]);

  const d0 = projects.getDelivery(id);
  assert.equal(d0.saved, false);
  assert.deepEqual(d0.items.map((i) => i.label), [...core.DEFAULT_DELIVERY_ITEMS]);
  const d1 = projects.setDelivery(id, { status: 'Em preparação', deadline: '2026-10-18', items: [{ label: 'Vídeo principal', done: true }, { label: '', done: true }], destinations: [{ label: 'SSD', checked: true }], notes: 'x'.repeat(5000) });
  assert.equal(d1.status, 'Em preparação');
  assert.deepEqual(d1.items, [{ label: 'Vídeo principal', done: true }], 'item sem rótulo é descartado');
  assert.equal(d1.notes.length, core.LIMITS.textMax);
  assert.equal(projects.setDelivery(id, { status: 'inválido' }).status, 'Em preparação', 'status desconhecido mantém o atual');

  const s = projects.getProjectSummary(id);
  assert.deepEqual([s.videos, s.audios, s.photos, s.total, s.total_size, s.bins, s.devices], [1, 1, 0, 2, 1500, 2, 2]);
  assert.deepEqual([s.delivery.status, s.delivery.done, s.delivery.items], ['Em preparação', 1, 1]);

  const copyId = projects.duplicateProject(id);
  const copy = projects.getProjectById(copyId);
  assert.equal(copy.name, 'Evento Cultural (cópia)');
  assert.equal(copy.status, 'Planejamento');
  assert.equal(copy.media_count, 2);
  const copyBins = projects.getProjectBins(copyId);
  assert.equal(copyBins.length, 2);
  const copySub = copyBins.find((b) => b.name === 'SONY A');
  assert.equal(copySub.parent_id, copyBins.find((b) => b.name === 'BRUTOS').id, 'hierarquia das pastas preservada');
  assert.equal(projects.listDevices(copyId).length, 2);
  assert.equal(projects.getDelivery(copyId).status, 'Não iniciada', 'a cópia começa com a entrega zerada');
  assert.ok(projects.listActivity(copyId).some((a) => a.kind === 'duplicado'));

  assert.equal(projects.removeDevice(devId), true);
  assert.equal(projects.listDevices(id).length, 1);
  const full = projects.getProjectFullModel(id);
  assert.equal(full.version, '1.1.0');
  assert.equal(full.devices.length, 1);
  assert.equal(full.delivery.status, 'Em preparação');
  assert.ok(Array.isArray(full.activity) && full.activity.length > 0);
  projects.deleteProject(copyId);
  projects.deleteProject(id);
});

test('lembretes de prazo ignoram projetos concluídos e arquivados', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'infrastructure', 'desktop', 'DeadlineNotifier.js'), 'utf8');
  assert.match(src, /p\.status !== 'Concluído' && p\.status !== 'Arquivado'/);
});

// ---------------------------------------------------------------- lista (renderer)

const PROJECTS = [
  { id: 1, name: 'Casamento João', client: 'João Silva', status: 'Em produção', deadline: '2099-10-18', created_at: '2026-10-01 10:00:00', last_activity_at: '2026-10-05 22:41:00', media_count: 3, total_size: 1024, color: '#3b82f6' },
  { id: 2, name: 'Evento Cultural', client: 'Circuito Cultural', status: 'Concluído', deadline: '2026-10-02', created_at: '2026-09-01 10:00:00', last_activity_at: '2026-09-20 10:00:00', media_count: 0, color: 'red' },
  { id: 3, name: 'Antigo', client: '', status: 'Arquivado', deadline: null, created_at: '2025-01-01 10:00:00', description: 'cerimônia e recepção', media_count: 1 },
  { id: 4, name: 'Legado', client: 'X', status: 'Pausado', deadline: null, created_at: '2026-05-01 10:00:00', media_count: 1 }
];

async function mountProjects(extra = {}) {
  const calls = [];
  const h = await mountScreen('projects', {
    bds: {
      listProjects: async () => PROJECTS.map((p) => ({ ...p })),
      updateProject: async (id, data) => { calls.push(['update', id, data]); return true; },
      duplicateProject: async (id) => { calls.push(['duplicate', id]); return 99; },
      deleteProject: async (id) => { calls.push(['delete', id]); return true; },
      exportProjectInfo: async (id) => { calls.push(['info', id]); return { filePath: 'x.md' }; },
      createProject: async (data) => { calls.push(['create', data]); return 5; },
      ...extra
    }
  });
  await settle(40);
  return { h, calls };
}
const cardNames = (h) => [...h.document.querySelectorAll('.proj-card[data-id]')].map((c) => c.querySelector('.proj-card-title').textContent);

test('lista: abas com contagem (abre em "Em andamento"), próximo passo no cartão, "Todos" sem arquivados; busca e ordenação', async () => {
  const { h } = await mountProjects();
  try {
    const d = h.document;
    const tab = (f) => d.querySelector(`.proj-tab[data-filter="${f}"]`);
    const count = (f) => d.querySelector(`.proj-tab-count[data-count="${f}"]`).textContent;
    assert.deepEqual(cardNames(h), ['Casamento João'], 'padrão: só em andamento (Aguardando cliente, Concluído e Arquivado ficam fora)');
    assert.equal(tab('active').classList.contains('active'), true);
    assert.deepEqual([count('active'), count('waiting'), count('done'), count('archived')], ['1', '1', '1', '1']);
    assert.equal(d.getElementById('projDueBanner').classList.contains('hidden'), true, 'sem entrega nos próximos 7 dias: sem aviso');
    assert.equal(d.getElementById('projRecentSection').classList.contains('hidden'), true, 'poucos projetos: sem "Continuar de onde parou"');
    assert.ok(d.querySelector('.proj-card-new'), 'cartão "Novo projeto" no fim da grade');
    assert.match(d.querySelector('.proj-card[data-id="1"] .proj-card-next').textContent, /Próximo: Preparar a lista de entrega/);
    assert.equal(d.getElementById('projSummary'), null, 'a faixa de resumo saiu (as abas mostram as contagens)');
    assert.equal(d.querySelector('.proj-rail'), null, 'a coluna lateral saiu');

    // modo lista
    d.getElementById('projViewList').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(d.getElementById('projectsTable').classList.contains('hidden'), false);
    assert.equal(d.querySelectorAll('#projectsTableBody tr').length, 1);
    d.getElementById('projViewGrid').dispatchEvent(new h.window.Event('click', { bubbles: true }));

    const sort = d.getElementById('projSort');
    tab('all').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    sort.value = 'recent'; sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Casamento João', 'Evento Cultural', 'Legado'], 'Todos: mais recentes primeiro, sem o arquivado');
    const first = d.querySelector('.proj-card[data-id]');
    assert.match(first.textContent, /João Silva/);
    assert.match(first.textContent, /Em produção/);
    assert.match(first.textContent, /Entrega/);
    assert.match(d.querySelector('.proj-card[data-id="4"]').textContent, /Aguardando cliente/, 'status antigo "Pausado" aparece já migrado');

    const search = d.getElementById('projSearch');
    search.value = 'recepção'; search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Antigo'], 'busca pelas observações encontra até arquivados');
    assert.match(d.getElementById('projCount').textContent, /1 projeto encontrado/);
    search.value = 'circuito'; search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Evento Cultural']);
    search.value = ''; search.dispatchEvent(new h.window.Event('input', { bubbles: true }));

    tab('archived').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Antigo']);
    tab('done').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Evento Cultural']);
    tab('all').dispatchEvent(new h.window.Event('click', { bubbles: true }));

    sort.value = 'name'; sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.deepEqual(cardNames(h), ['Casamento João', 'Evento Cultural', 'Legado']);
    sort.value = 'deadline'; sort.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.deepEqual(cardNames(h)[0], 'Evento Cultural', 'prazo mais próximo primeiro; sem prazo por último');
  } finally { await h.cleanup(); }
});

test('lista: "Continuar de onde parou" com os 3 mais recentes, aviso de entrega próxima e novo projeto com pastas padrão', async () => {
  const day = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const many = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: `Projeto ${i}`, client: 'C', status: 'Em produção', deadline: i === 5 ? day(1) : null, created_at: '2026-10-01 10:00:00', last_activity_at: `2026-10-0${i} 10:00:00`, media_count: i === 2 ? 0 : 2, delivery_total: i === 3 ? 4 : 0, delivery_done: i === 3 ? 1 : 0 }));
  const bins = [];
  const { h, calls } = await mountProjects({ listProjects: async () => many.map((p) => ({ ...p })), createProjectDefaultBins: async (id) => { bins.push(id); return ['BRUTOS']; } });
  try {
    const d = h.document;
    assert.equal(d.getElementById('projRecentSection').classList.contains('hidden'), false);
    const recent = [...d.querySelectorAll('#projRecent .proj-card .proj-card-title')].map((n) => n.textContent);
    assert.deepEqual(recent, ['Projeto 5', 'Projeto 4', 'Projeto 3'], 'os 3 com atividade mais recente');
    const rest = [...d.querySelectorAll('#projectsGrid .proj-card[data-id] .proj-card-title')].map((n) => n.textContent);
    assert.deepEqual(rest.sort(), ['Projeto 1', 'Projeto 2'], 'a lista abaixo não repete os recentes');
    assert.match(d.querySelector('#projRecent .proj-card[data-id="3"]').textContent, /Entrega: 1 de 4 itens prontos/);
    assert.match(d.querySelector('.proj-card[data-id="2"]').textContent, /Próximo: Adicionar o material/);
    const banner = d.getElementById('projDueBanner');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.match(banner.textContent, /1 entrega nos próximos 7 dias · Projeto 5 amanhã/);

    // novo projeto: só o essencial à vista, pastas padrão marcadas
    d.getElementById('btnNewProject').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(d.getElementById('projFormMore').open, false, '"Mais detalhes" começa fechado');
    assert.equal(d.getElementById('projFormDefaultBins').checked, true);
    d.getElementById('projFormName').value = 'Novo trabalho';
    d.getElementById('btnSaveProjForm').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(40);
    assert.equal(calls.find((c) => c[0] === 'create')[1].name, 'Novo trabalho');
    assert.deepEqual(bins, [5], 'as pastas padrão foram criadas no projeto novo');
  } finally { await h.cleanup(); }
});

test('menu ⋮: alterar status, duplicar, exportar informações, arquivar (confirma) e excluir (confirma)', async () => {
  const { h, calls } = await mountProjects();
  try {
    const d = h.document;
    const card = d.querySelector('.proj-card[data-id="1"]');
    assert.ok(card, 'projeto em andamento está na lista padrão');
    card.querySelector('.proj-card-menu').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    const menu = d.getElementById('projMenu');
    assert.equal(menu.classList.contains('hidden'), false);
    const labels = [...menu.querySelectorAll('button, summary')].map((b) => b.textContent.trim());
    for (const l of ['Abrir projeto', 'Renomear / editar', 'Alterar capa', 'Alterar status', 'Duplicar', 'Exportar informações', 'Arquivar', 'Excluir']) {
      assert.ok(labels.some((x) => x.includes(l)), l);
    }
    const byLabel = (txt) => [...menu.querySelectorAll('button')].find((b) => b.textContent.includes(txt));
    byLabel('Concluído').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.deepEqual(calls.at(-1), ['update', 1, { status: 'Concluído' }]);

    card.querySelector('.proj-card-menu').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    byLabel('Duplicar').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.ok(calls.some((c) => c[0] === 'duplicate' && c[1] === 1));

    card.querySelector('.proj-card-menu').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    byLabel('Exportar informações').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.ok(calls.some((c) => c[0] === 'info' && c[1] === 1));

    card.querySelector('.proj-card-menu').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    byLabel('Arquivar').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.ok(h.dialogs.confirms.length >= 1, 'arquivar pede confirmação');
    assert.deepEqual(calls.at(-1), ['update', 1, { status: 'Arquivado' }]);

    card.querySelector('.proj-card-menu').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    byLabel('Excluir').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(20);
    assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === 1));
  } finally { await h.cleanup(); }
});

test('formulário: Observações e capa entram no projeto; nome vazio não salva', async () => {
  const { h, calls } = await mountProjects({ selectFile: async () => ['D:/capas/cover.jpg'] });
  try {
    const d = h.document;
    d.getElementById('btnNewProject').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.ok(d.getElementById('modalProjectForm').classList.contains('open'));
    assert.equal(d.getElementById('projFormStatus').value, 'Planejamento');
    d.getElementById('btnSaveProjForm').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(10);
    assert.ok(h.dialogs.alerts.some((a) => /nome/i.test(a)), 'nome obrigatório');
    assert.equal(calls.filter((c) => c[0] === 'create').length, 0);

    d.getElementById('projFormName').value = 'Casamento João & Maria';
    d.getElementById('projFormClient').value = 'João Silva';
    d.getElementById('projFormNotes').value = 'Cerimônia + recepção. Entrega final em 4K.';
    d.getElementById('btnProjFormCover').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(10);
    d.getElementById('btnSaveProjForm').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle(30);
    const create = calls.find((c) => c[0] === 'create');
    assert.ok(create);
    assert.equal(create[1].name, 'Casamento João & Maria');
    assert.equal(create[1].description, 'Cerimônia + recepção. Entrega final em 4K.');
    assert.equal(create[1].cover_path, 'D:/capas/cover.jpg');
    assert.equal(create[1].status, 'Planejamento');
  } finally { await h.cleanup(); }
});
