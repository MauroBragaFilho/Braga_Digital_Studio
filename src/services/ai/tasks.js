'use strict';

/**
 * tasks.js — Registro de tarefas de IA do BDS (pontos de extensão).
 *
 * Cada tarefa é uma função assíncrona que recebe (payload, ctx) e devolve um resultado.
 * `ctx` expõe o que a tarefa precisa sem conhecer o provedor:
 *   ctx.chat({ messages, system })  → { text, usage }   (usa o provedor configurado)
 *
 * As tarefas abaixo estão declaradas mas ainda NÃO implementadas: servem como contrato
 * para as próximas etapas. Para implementar uma, troque `run` (ou use register()).
 */

const notImplemented = (name) => async () => {
  throw new Error(`A tarefa "${name}" ainda não foi implementada.`);
};

const TASKS = new Map([
  ['transcribe', {
    label: 'Transcrição e legendas',
    description: 'Transforma áudio/vídeo em texto e gera legendas (SRT/VTT).',
    implemented: false,
    // payload esperado: { filePath: string, language?: string, format?: 'srt'|'vtt'|'txt' }
    run: notImplemented('transcribe')
  }],
  ['suggestTags', {
    label: 'Organização da biblioteca',
    description: 'Sugere título, descrição e tags para itens da biblioteca.',
    implemented: false,
    // payload esperado: { mediaIds: number[] }
    run: notImplemented('suggestTags')
  }]
]);

/** Registra (ou substitui) uma tarefa. Use para plugar implementações novas. */
function register(name, { label, description, run }) {
  if (typeof name !== 'string' || !/^[a-zA-Z][\w-]{0,40}$/.test(name)) throw new Error('Nome de tarefa inválido.');
  if (typeof run !== 'function') throw new Error('A tarefa precisa de uma função run().');
  TASKS.set(name, { label: label || name, description: description || '', implemented: true, run });
}

function list() {
  return [...TASKS.entries()].map(([id, t]) => ({
    id, label: t.label, description: t.description, implemented: !!t.implemented
  }));
}

function get(name) { return TASKS.get(name) || null; }

module.exports = { register, list, get };
