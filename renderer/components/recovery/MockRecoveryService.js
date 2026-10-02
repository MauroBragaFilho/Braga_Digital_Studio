/**
 * MockRecoveryService — implementação SIMULADA do RecoveryService.
 *
 * ATENÇÃO: nesta versão NADA é lido, restaurado, copiado ou excluído do disco. Todos os
 * dados abaixo são fictícios e vivem só na memória. Os motores reais substituem esta
 * classe via setRecoveryService() (ver RecoveryService.js).
 *
 * Os "cenários" existem só para demonstrar os estados da interface (vazio, atenção, erro).
 */

import { RecoveryStatus, RecoveryRisk, RecoverySource, SystemStatus } from './recoveryTypes.js';

const PROJECT_NAME = 'Projeto Exemplo';
const LATENCY_MS = 350;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Conteúdo restaurável fictício (categorias exibidas no painel de detalhes). */
function contents({ library = 128, montage = 42, settings = 1, metadata = 18, sidecars = 42, project = 1, partial = [] } = {}) {
  const make = (id, label, icon, items) => ({ id, label, icon, items, restorable: !partial.includes(id) });
  return [
    make('library', 'Biblioteca', 'video_library', library),
    make('montage', 'Montagem', 'movie_filter', montage),
    make('settings', 'Configurações', 'settings', settings),
    make('metadata', 'Metadados', 'label', metadata),
    make('sidecars', 'XML / sidecars', 'code', sidecars),
    make('project', 'Estado do projeto', 'folder_special', project)
  ];
}

function buildScenario(name) {
  if (name === 'empty' || name === 'error') return { items: [], project: null };

  const items = [
    {
      id: 'rec-001', timestamp: '2026-10-02T01:10:00', source: RecoverySource.AUTOSAVE,
      status: RecoveryStatus.VALID, risk: RecoveryRisk.LOW, sizeBytes: 18_400_000, fileCount: 42,
      session: 'Sessão de 02/10/2026', lastChange: '2026-10-02T01:09:12', integrity: 100,
      files: ['montagem/abertura.mp4', 'montagem/principal_01.mp4', 'montagem/principal_02.mp4', 'metadados/projeto.json', 'sidecars/principal_01.xml', 'sidecars/principal_02.xml'],
      contents: contents(),
      comparison: [
        ['Montagem', '42 arquivos', '42 arquivos', 'same'], ['Metadados', '18', '18', 'same'],
        ['XML', '42', '42', 'same'], ['Configurações', 'OK', 'OK', 'same']
      ],
      issues: []
    },
    {
      id: 'rec-002', timestamp: '2026-10-02T00:45:00', source: RecoverySource.BACKUP,
      status: RecoveryStatus.VALID, risk: RecoveryRisk.LOW, sizeBytes: 17_900_000, fileCount: 38,
      session: 'Sessão de 01/10/2026', lastChange: '2026-10-02T00:44:30', integrity: 100,
      files: ['montagem/abertura.mp4', 'montagem/principal_01.mp4', 'metadados/projeto.json', 'sidecars/principal_01.xml'],
      contents: contents({ montage: 38, sidecars: 40 }),
      comparison: [
        ['Montagem', '42 arquivos', '38 arquivos', 'less'], ['Metadados', '18', '18', 'same'],
        ['XML', '42', '40', 'less'], ['Configurações', 'OK', 'OK', 'same']
      ],
      issues: []
    },
    {
      id: 'rec-003', timestamp: '2026-10-01T23:20:00', source: RecoverySource.PREVIOUS_SESSION,
      status: RecoveryStatus.PARTIAL, risk: RecoveryRisk.MEDIUM, sizeBytes: 12_100_000, fileCount: 31,
      session: 'Sessão de 01/10/2026 (encerrada de forma inesperada)', lastChange: '2026-10-01T23:19:40', integrity: 82,
      files: ['montagem/abertura.mp4', 'montagem/principal_01.mp4', 'metadados/projeto.json'],
      contents: contents({ montage: 31, metadata: 14, sidecars: 29, partial: ['sidecars'] }),
      comparison: [
        ['Montagem', '42 arquivos', '31 arquivos', 'less'], ['Metadados', '18', '14', 'less'],
        ['XML', '42', '29', 'less'], ['Configurações', 'OK', 'OK', 'same']
      ],
      issues: ['2 sidecars XML incompletos', '4 metadados sem correspondência na biblioteca']
    }
  ];

  if (name === 'attention') {
    items.unshift({
      id: 'rec-000', timestamp: '2026-10-02T01:12:00', source: RecoverySource.AUTOSAVE,
      status: RecoveryStatus.CORRUPTED, risk: RecoveryRisk.HIGH, sizeBytes: 3_200_000, fileCount: 9,
      session: 'Sessão de 02/10/2026 (interrompida)', lastChange: '2026-10-02T01:11:58', integrity: 41,
      files: ['montagem/principal_03.mp4', 'metadados/projeto.json'],
      contents: contents({ library: 12, montage: 9, metadata: 3, sidecars: 2, partial: ['montage', 'metadata', 'sidecars', 'project'] }),
      comparison: [
        ['Montagem', '42 arquivos', '9 arquivos', 'less'], ['Metadados', '18', '3', 'less'],
        ['XML', '42', '2', 'less'], ['Configurações', 'OK', 'OK', 'same']
      ],
      issues: ['Registro de montagem truncado', 'Arquivo de projeto com assinatura inválida', '7 sidecars ausentes']
    });
  }

  const newest = items.find((i) => i.status === RecoveryStatus.VALID) || null;
  return {
    items,
    project: {
      name: PROJECT_NAME,
      lastSession: items[0].timestamp,
      lastModified: items[0].lastChange,
      lastValidState: newest ? newest.timestamp : null
    }
  };
}

export class MockRecoveryService {
  constructor() {
    /** Permite à tela exibir os controles de simulação. Motores reais não definem isto. */
    this.isMock = true;
    this.scenario = 'available';
    this.failNextRestore = false;
    this._data = buildScenario(this.scenario);
    this._restoredTimestamp = null;
    this._restoredWasValid = false;
  }

  // ---- Controles de simulação (exclusivos do mock) ---------------------------------------

  /** @param {'available'|'attention'|'empty'|'error'} name */
  setScenario(name) {
    this.scenario = name;
    this._data = buildScenario(name);
    this._restoredTimestamp = null;
    this._restoredWasValid = false;
  }

  // ---- Contrato RecoveryService ----------------------------------------------------------

  async getProjectStatus() {
    await sleep(LATENCY_MS / 2);
    if (this.scenario === 'error') throw new Error('Não foi possível ler os estados de recuperação do projeto.');
    const { items, project } = this._data;
    if (!project) {
      return {
        name: PROJECT_NAME, lastSession: '2026-10-02T01:10:00', lastModified: '2026-10-02T01:09:12',
        currentState: 'Sem recuperação disponível', lastValidState: null, recoverableCount: 0,
        systemStatus: SystemStatus.SAFE
      };
    }
    const hasHighRisk = items.some((i) => i.risk === RecoveryRisk.HIGH);
    const restored = this._restoredTimestamp;
    let systemStatus = hasHighRisk ? SystemStatus.ATTENTION : SystemStatus.RECOVERY_AVAILABLE;
    let currentState = hasHighRisk ? 'Atenção necessária' : 'Recuperação disponível';
    if (restored) { systemStatus = SystemStatus.SAFE; currentState = 'Estado restaurado (simulado)'; }
    return {
      name: PROJECT_NAME,
      lastSession: restored || project.lastSession,
      lastModified: restored || project.lastModified,
      currentState,
      // só um estado válido passa a ser o "último estado válido conhecido"
      lastValidState: restored && this._restoredWasValid ? restored : project.lastValidState,
      recoverableCount: items.length,
      systemStatus
    };
  }

  async getAvailableRecoveries() {
    await sleep(LATENCY_MS);
    if (this.scenario === 'error') throw new Error('Falha ao consultar os estados disponíveis (erro simulado).');
    return this._data.items.map(({ id, timestamp, source, status, risk, sizeBytes, fileCount }) =>
      ({ id, timestamp, source, status, risk, sizeBytes, fileCount }));
  }

  async getRecoveryDetails(id) {
    await sleep(LATENCY_MS / 2);
    const item = this._find(id);
    return {
      id: item.id, timestamp: item.timestamp, source: item.source, status: item.status, risk: item.risk,
      sizeBytes: item.sizeBytes, fileCount: item.fileCount,
      project: PROJECT_NAME, session: item.session, lastChange: item.lastChange,
      integrity: item.integrity, files: [...item.files], contents: item.contents.map((c) => ({ ...c }))
    };
  }

  async compareRecovery(id) {
    await sleep(LATENCY_MS / 2);
    const item = this._find(id);
    return {
      currentLabel: 'Estado atual',
      recoverableLabel: 'Estado recuperável',
      rows: item.comparison.map(([category, current, recoverable, diff]) => ({ category, current, recoverable, diff }))
    };
  }

  async validateRecovery(id) {
    await sleep(LATENCY_MS / 2);
    const item = this._find(id);
    return { risk: item.risk, issues: [...item.issues] };
  }

  /** SIMULAÇÃO: só reporta progresso; não restaura nada. */
  async restoreRecovery(id, options = {}, onProgress = () => {}) {
    const item = this._find(id);
    const steps = [
      { percent: 10, step: 'Preparando a restauração…' },
      ...(options.createBackup ? [{ percent: 30, step: 'Criando cópia do estado atual…' }] : []),
      { percent: 60, step: 'Restaurando conteúdo selecionado…' },
      { percent: 85, step: 'Verificando consistência…' },
      { percent: 100, step: 'Concluindo…' }
    ];
    for (const s of steps) {
      await sleep(550);
      if (this.failNextRestore && s.percent >= 60) {
        this.failNextRestore = false;
        throw new Error('A restauração foi interrompida (falha simulada). Nenhum dado foi alterado.');
      }
      onProgress(s);
    }
    this._restoredTimestamp = item.timestamp;
    this._restoredWasValid = item.status === RecoveryStatus.VALID;
    return {
      ok: true, restoredId: id, backupCreated: !!options.createBackup, simulated: true,
      message: 'Estado restaurado com sucesso.'
    };
  }

  /** SIMULAÇÃO: remove só da lista em memória. */
  async deleteRecovery(id) {
    await sleep(LATENCY_MS);
    this._find(id);
    this._data.items = this._data.items.filter((i) => i.id !== id);
    if (!this._data.items.length) this._data.project = null;
  }

  // ---- interno -----------------------------------------------------------------------------

  _find(id) {
    const item = this._data.items.find((i) => i.id === id);
    if (!item) throw new Error('Estado de recuperação não encontrado.');
    return item;
  }
}
