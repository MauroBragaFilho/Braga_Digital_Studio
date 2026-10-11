'use strict';

/**
 * "Exportar informações" do menu de um projeto: um resumo legível em Markdown (nome, cliente, datas, status,
 * observações, resumo das mídias, pastas, dispositivos, entrega e atividade recente). Só informações e nomes de
 * arquivo: nenhum caminho completo sai daqui.
 */

const path = require('node:path');

const fmtDate = (v) => (typeof v === 'string' && v ? v.slice(0, 10).split('-').reverse().join('/') : '—');
const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1).replace('.', ',')} ${units[i]}`;
};
const line = (label, value) => `- **${label}:** ${value === undefined || value === null || value === '' ? '—' : value}`;

/**
 * @param {object} projectService  ProjectService
 * @param {number} projectId
 * @returns {{ fileName: string, content: string }}
 */
function buildProjectInfo(projectService, projectId) {
  const p = projectService.getProjectById(projectId);
  if (!p) throw new Error('Projeto não encontrado');
  const summary = projectService.getProjectSummary(projectId);
  const bins = projectService.getProjectBins(projectId);
  const media = projectService.getProjectMedia(projectId);
  const devices = projectService.listDevices(projectId);
  const delivery = projectService.getDelivery(projectId);
  const activity = projectService.listActivity(projectId, 30);
  const binName = new Map(bins.map((b) => [b.id, b.name]));

  const out = [];
  out.push(`# ${p.name}`, '');
  out.push(line('Cliente', p.client), line('Tipo', p.type), line('Status', p.status), line('Data do projeto', fmtDate(p.start_date)),
    line('Entrega', fmtDate(p.deadline)), line('Criado em', fmtDate(p.created_at)), line('Última atividade', fmtDate(summary.last_activity_at)), '');
  if (p.description) out.push('## Observações', '', p.description, '');

  out.push('## Resumo', '',
    line('Vídeos', summary.videos), line('Áudios', summary.audios), line('Fotos', summary.photos), line('Espaço', fmtBytes(summary.total_size)),
    line('Mídias ausentes', summary.missing), line('Transcrições ao lado das mídias', summary.transcripts), '');

  out.push('## Arquivos', '');
  if (!media.length) out.push('_Nenhuma mídia referenciada._', '');
  else {
    const byBin = new Map();
    for (const m of media) {
      const key = m.bin_id ? (binName.get(m.bin_id) || 'Pasta') : 'Sem pasta';
      if (!byBin.has(key)) byBin.set(key, []);
      byBin.get(key).push(m);
    }
    for (const [name, list] of byBin) {
      out.push(`### ${name} (${list.length})`, '');
      for (const m of list.slice(0, 500)) out.push(`- ${m.custom_name || m.filename}${m.missing ? ' _(ausente)_' : ''}`);
      if (list.length > 500) out.push(`- … e mais ${list.length - 500}`);
      out.push('');
    }
  }

  out.push('## Dispositivos', '');
  if (!devices.length) out.push('_Nenhum dispositivo registrado._', '');
  else {
    const labels = { camera: 'Câmeras', audio: 'Áudio', other: 'Outros' };
    for (const cat of ['camera', 'audio', 'other']) {
      const list = devices.filter((d) => d.category === cat);
      if (list.length) out.push(`- **${labels[cat]}:** ${list.map((d) => d.name + (d.note ? ` (${d.note})` : '')).join(', ')}`);
    }
    out.push('');
  }

  out.push('## Entrega', '', line('Status', delivery.status), line('Prazo', fmtDate(delivery.deadline)));
  if (delivery.items.length) out.push(`- **Arquivos:** ${delivery.items.map((i) => `${i.done ? '☑' : '☐'} ${i.label}`).join('  ')}`);
  if (delivery.destinations.length) out.push(`- **Destino:** ${delivery.destinations.map((d) => `${d.checked ? '☑' : '☐'} ${d.label}`).join('  ')}`);
  if (delivery.notes) out.push(line('Observações', delivery.notes));
  out.push('');

  if (activity.length) {
    out.push('## Atividade recente', '');
    for (const a of activity) out.push(`- ${String(a.created_at || '').slice(0, 16).replace('T', ' ')} — ${a.message}`);
    out.push('');
  }

  const safeName = String(p.name).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'projeto';
  return { fileName: `${safeName} - informações.md`, content: out.join('\n') };
}

module.exports = { buildProjectInfo, defaultFileName: (name) => path.basename(name) };
