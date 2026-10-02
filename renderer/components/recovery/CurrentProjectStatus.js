/**
 * CurrentProjectStatus — card com o estado atual do projeto.
 * @param {{ project: import('./recoveryTypes.js').ProjectStatus|null }} props
 */

import { SYSTEM_STATUS_INFO } from './recoveryTypes.js';
import { h, icon, formatDateTime } from './recoveryUtils.js';

function field(label, value, extraClass = '') {
  return h('div', { class: `rc-field ${extraClass}`.trim() }, [
    h('span', { class: 'rc-field-label', text: label }),
    h('span', { class: 'rc-field-value', text: value })
  ]);
}

export function CurrentProjectStatus({ project }) {
  if (!project) {
    return h('section', { class: 'rc-card rc-status-card', 'aria-label': 'Estado atual do projeto' }, [
      h('div', { class: 'rc-card-head' }, [h('span', { class: 'rc-card-title', text: 'ESTADO ATUAL' })]),
      h('p', { class: 'rc-muted', text: 'Informações do projeto indisponíveis.' })
    ]);
  }
  const tone = project.systemStatus || 'safe';
  return h('section', { class: `rc-card rc-status-card rc-tone-${tone}`, 'aria-label': 'Estado atual do projeto' }, [
    h('div', { class: 'rc-card-head' }, [
      h('span', { class: 'rc-card-title', text: 'ESTADO ATUAL' }),
      h('span', { class: 'rc-chip' }, [icon((SYSTEM_STATUS_INFO[tone] || {}).icon || 'info'), project.currentState])
    ]),
    h('div', { class: 'rc-project-name' }, [icon('folder_special'), h('strong', { text: project.name })]),
    h('div', { class: 'rc-field-grid' }, [
      field('Última sessão', formatDateTime(project.lastSession)),
      field('Última alteração', formatDateTime(project.lastModified)),
      field('Último estado válido', project.lastValidState ? formatDateTime(project.lastValidState) : 'Nenhum conhecido'),
      field('Estados recuperáveis', String(project.recoverableCount), 'rc-field-accent')
    ])
  ]);
}
