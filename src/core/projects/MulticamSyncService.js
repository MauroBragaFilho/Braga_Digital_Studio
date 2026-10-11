'use strict';

const logger = require('../../services/logService');
const { downsample, fftCrossCorrelate } = require('./fft');

/**
 * Sincronização multicâmera "estilo PluralEyes" (aba Áudio do projeto).
 *
 * Fontes = pastas de primeiro nível do projeto (Câmera da TV, Câmera do Quadro, Gravação do PC, Gravador…).
 * Cada fonte é uma linha; os clipes de uma fonte são encadeados na ordem de gravação (câmeras que cortam a cada
 * 2 GB geram pedaços contínuos). Escolhida a fonte MESTRE (a que tem o melhor áudio contínuo), cada clipe das
 * outras fontes é procurado DENTRO da linha mestre inteira por correlação de envelopes (FFT, grossa a 100 ms)
 * e depois refinado localmente (20 ms). Clipes sem áudio útil (ex.: câmera do quadro) herdam o alinhamento da
 * própria fonte (âncora da linha = mediana dos clipes que sincronizaram) ou ficam para ajuste manual.
 *
 * O resultado é gravado como um grupo de sincronia (sync_groups/sync_group_items): offset_seconds = posição do
 * clipe na linha do tempo da fonte mestre. A aba Áudio e o exportador XML (XmemlExporter) leem daí.
 */

const FINE_WINDOW = 0.02;   // s por amostra do envelope do AudioSyncService
const COARSE_FACTOR = 5;    // 100 ms na busca global
const REFINE_SEARCH = 0.75; // ± s no refino local
const MIN_CONFIDENCE = 0.12;

const isVideo = (m) => (m.media_type ? m.media_type === 'video' : Boolean(m.video_codec));
const isAudio = (m) => (m.media_type ? m.media_type === 'audio' : (!m.video_codec && Boolean(m.audio_codec)));
const hasAudio = (m) => isAudio(m) || Boolean(m.audio_codec);
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

class MulticamSyncService {
  constructor({ projectService, audioSyncService }) {
    this.projectService = projectService;
    this.audioSyncService = audioSyncService;
  }

  /** Clipes de vídeo/áudio do projeto agrupados por pasta de primeiro nível, encadeados na ordem de gravação. */
  listSources(projectId) {
    const bins = this.projectService.getProjectBins(projectId);
    const media = this.projectService.getProjectMedia(projectId).filter((m) => isVideo(m) || isAudio(m));
    const parentOf = new Map(bins.map((b) => [b.id, b.parent_id]));
    const nameOf = new Map(bins.map((b) => [b.id, b.name]));
    const rootOf = (binId) => { let id = binId; let guard = 0; while (id && parentOf.get(id) && guard++ < 100) id = parentOf.get(id); return id || null; };
    const groups = new Map(); // rootBinId|0 -> clips
    for (const m of media) {
      const root = m.bin_id ? rootOf(m.bin_id) : 0;
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(m);
    }
    const sortKey = (m) => `${m.recorded_at || ''}|${(m.custom_name || m.filename || '').toLowerCase()}`;
    const sources = [];
    for (const [root, clips] of groups) {
      clips.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      let pos = 0;
      const items = clips.map((m) => {
        const item = {
          media_id: m.id, pm_id: m.pm_id, name: m.custom_name || m.filename, filename: m.filename, filepath: m.filepath,
          uuid: m.uuid, duration: Number(m.duration) || 0, fps: Number(m.fps) || 0, width: m.width, height: m.height,
          kind: isVideo(m) ? 'video' : 'audio', has_audio: hasAudio(m), missing: Boolean(m.missing), chain_pos: pos
        };
        pos += item.duration;
        return item;
      });
      sources.push({
        id: root || 0, name: root ? nameOf.get(root) : 'Sem pasta', items,
        total_duration: pos, has_audio: items.some((i) => i.has_audio), kind: items.every((i) => i.kind === 'audio') ? 'audio' : 'video'
      });
    }
    sources.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return sources;
  }

  /** Envelope (20 ms) da linha inteira de uma fonte: clipes encadeados pela posição; buracos ficam em zero. */
  async _laneEnvelope(source, onProgress) {
    const total = Math.ceil(source.total_duration / FINE_WINDOW) + 1;
    const lane = new Float32Array(total);
    for (const clip of source.items) {
      if (!clip.has_audio || clip.missing) continue;
      if (onProgress) onProgress({ stage: 'master', media_id: clip.media_id, name: clip.name });
      const env = await this.audioSyncService.extractEnvelope(clip.filepath);
      const start = Math.round(clip.chain_pos / FINE_WINDOW);
      for (let i = 0; i < env.length && start + i < lane.length; i++) lane[start + i] = env[i];
    }
    return lane;
  }

  /**
   * Sincroniza as fontes contra a mestre. Devolve { groupId, lanes } e grava o grupo de sincronia.
   * @param {{ projectId:number, masterSourceId:number, sourceIds?:number[], name?:string, onProgress?:Function }} opts
   */
  async sync({ projectId, masterSourceId, sourceIds = null, name = null, onProgress = null }) {
    const sources = this.listSources(projectId);
    const master = sources.find((s) => s.id === masterSourceId);
    if (!master) throw new Error('Escolha a fonte mestre (a que tem o melhor áudio).');
    if (!master.has_audio) throw new Error('A fonte mestre precisa ter áudio.');
    const others = sources.filter((s) => s.id !== master.id && (!sourceIds || sourceIds.includes(s.id)));

    const masterFine = await this._laneEnvelope(master, onProgress);
    const masterCoarse = downsample(masterFine, COARSE_FACTOR);
    const items = [];
    for (const clip of master.items) {
      items.push({ media_id: clip.media_id, offset_seconds: clip.chain_pos, confidence: 1, drift_rate_ppm: 0, source_id: master.id, method: 'master' });
    }

    for (const source of others) {
      const synced = [];
      for (const clip of source.items) {
        if (!clip.has_audio || clip.missing) { items.push({ media_id: clip.media_id, offset_seconds: null, confidence: 0, drift_rate_ppm: 0, source_id: source.id, method: 'pending' }); continue; }
        try {
          if (onProgress) onProgress({ stage: 'extract', media_id: clip.media_id, name: clip.name, source: source.name });
          const fine = await this.audioSyncService.extractEnvelope(clip.filepath);
          if (onProgress) onProgress({ stage: 'correlate', media_id: clip.media_id, name: clip.name, source: source.name });
          const coarse = fftCrossCorrelate(masterCoarse, downsample(fine, COARSE_FACTOR));
          let offset = coarse.shift * FINE_WINDOW * COARSE_FACTOR;
          let confidence = coarse.confidence;
          if (confidence >= MIN_CONFIDENCE) {
            // refino local (20 ms) em três pontos do clipe; mediana
            const refined = [];
            const span = clip.duration;
            for (const frac of [0.25, 0.5, 0.75]) {
              const centerT = span * frac;
              const r = this.audioSyncService._localOffsetAt(masterFine, fine, offset, centerT, 8, REFINE_SEARCH);
              if (r && r.confidence > 0) refined.push(r.offsetSeconds);
            }
            if (refined.length) offset = median(refined);
          }
          const ok = confidence >= MIN_CONFIDENCE;
          items.push({ media_id: clip.media_id, offset_seconds: ok ? Number(offset.toFixed(3)) : null, confidence: Number(confidence.toFixed(4)), drift_rate_ppm: 0, source_id: source.id, method: ok ? 'audio' : 'pending' });
          if (ok) synced.push({ clip, offset });
          if (onProgress) onProgress({ stage: 'done', media_id: clip.media_id, name: clip.name, source: source.name, confidence });
        } catch (e) {
          logger.error(`[MulticamSync] clipe ${clip.media_id}: ${e.message}`);
          items.push({ media_id: clip.media_id, offset_seconds: null, confidence: 0, drift_rate_ppm: 0, source_id: source.id, method: 'error', error: e.message });
        }
      }
      // Âncora da linha: clipes sem áudio (ou que falharam) seguem a cadeia a partir dos que sincronizaram
      const anchor = median(synced.map(({ clip, offset }) => offset - clip.chain_pos));
      if (anchor !== null) {
        for (const it of items) {
          if (it.source_id !== source.id || it.offset_seconds !== null) continue;
          const clip = source.items.find((c) => c.media_id === it.media_id);
          it.offset_seconds = Number((anchor + clip.chain_pos).toFixed(3));
          it.method = 'chain';
        }
      }
    }

    const persisted = items.filter((it) => it.offset_seconds !== null);
    const groupName = name || `Multicam ${new Date().toLocaleString('pt-BR')}`;
    const groupId = this.projectService.createSyncGroup(projectId, groupName, master.items[0] ? master.items[0].media_id : null,
      persisted.map((it) => ({ media_id: it.media_id, offset_seconds: it.offset_seconds, confidence: it.confidence, drift_rate_ppm: 0 })));
    try { this.projectService.logActivity(projectId, 'sincronizado', `Sincronização multicâmera: ${persisted.length} de ${items.length} clipes`); } catch (_) { /* opcional */ }
    return { groupId, ...this.getModel(projectId, groupId) };
  }

  /** Linhas (fontes) com a posição de cada clipe num grupo de sincronia; clipes sem posição ficam marcados. */
  getModel(projectId, groupId) {
    const sources = this.listSources(projectId);
    const group = this.projectService.getSyncGroups(projectId).find((g) => g.id === groupId);
    if (!group) throw new Error('Grupo de sincronia não encontrado');
    const byMedia = new Map((group.items || []).map((it) => [it.media_id, it]));
    let min = Infinity; let max = 0;
    const lanes = sources.map((s) => {
      const clips = s.items.map((c) => {
        const it = byMedia.get(c.media_id);
        const offset = it ? Number(it.offset_seconds) : null;
        if (offset !== null) { min = Math.min(min, offset); max = Math.max(max, offset + c.duration); }
        return { ...c, item_id: it ? it.id : null, offset, confidence: it ? Number(it.confidence) || 0 : 0, placed: offset !== null };
      });
      return { id: s.id, name: s.name, kind: s.kind, has_audio: s.has_audio, is_master: clips.some((c) => c.media_id === group.master_media_id), clips };
    });
    if (!Number.isFinite(min)) min = 0;
    return { group: { id: group.id, name: group.name, master_media_id: group.master_media_id }, lanes, start: min, end: max, duration: Math.max(0, max - min) };
  }
}

module.exports = MulticamSyncService;
