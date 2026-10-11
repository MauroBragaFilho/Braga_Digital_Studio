'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * XML xmeml v4 no MESMO formato que o Premiere/PluralEyes exportam (referência: gerar_xml.py e os XMLs em
 * .docs/referencias): <project> com bins de master clips (1 trilha de vídeo + 2 de áudio, clipitems ligados),
 * <sequence> com clipitems ligados vídeo↔áudio estéreo, `rate` explícito em cada clipitem (fontes de taxas
 * diferentes na mesma sequência), marcadores, <uuid> e <importoptions> (useFirstClipSettings).
 *
 * Dois usos:
 *  - exportBins: só a estrutura de pastas (bins aninhados) com master clips, sem sequência.
 *  - exportMulticam: pastas + uma sequência com UMA camada de vídeo por fonte e um par de trilhas de áudio
 *    estéreo por fonte, cada clipe na posição vinda da sincronização (MulticamSyncService / sync_groups).
 */

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const uid = () => crypto.randomUUID().toUpperCase();

/** pathurl: file://localhost/ + cada segmento codificado, mantendo o ':' da unidade; UNC vira file://localhost//servidor/... */
function pathUrl(filepath) {
  const p = String(filepath || '').replace(/\\/g, '/');
  const enc = (seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (p.startsWith('//')) return 'file://localhost//' + p.slice(2).split('/').map(enc).join('/');
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  if (drive) return 'file://localhost/' + drive[1] + (drive[2] || '/').split('/').map(enc).join('/');
  return 'file://localhost' + (p.startsWith('/') ? '' : '/') + p.split('/').map(enc).join('/');
}

/** Taxa no formato FCP: NTSC (29.97/59.94/23.976) vira timebase inteiro + ntsc TRUE. */
function rateOf(fps) {
  const f = Number(fps) || 30;
  const near = (v) => Math.abs(f - v) < 0.01; // 29.97 x 30 diferem por 0,03: não confundir
  if (near(29.97)) return { ntsc: 'TRUE', tb: 30, real: 30000 / 1001 };
  if (near(59.94)) return { ntsc: 'TRUE', tb: 60, real: 60000 / 1001 };
  if (near(23.976)) return { ntsc: 'TRUE', tb: 24, real: 24000 / 1001 };
  if (near(47.952)) return { ntsc: 'TRUE', tb: 48, real: 48000 / 1001 };
  const tb = Math.max(1, Math.round(f));
  return { ntsc: 'FALSE', tb, real: tb };
}
const rateXml = (r) => `<rate><ntsc>${r.ntsc}</ntsc><timebase>${r.tb}</timebase></rate>`;

class XmemlExporter {
  constructor(projectService) {
    this.projectService = projectService;
  }

  /** Fonte (arquivo) com ids de master clip, file e clipitems do master clip. */
  _source(m) {
    const rate = rateOf(m.fps || 30);
    const duration = Number(m.duration) || 0;
    return {
      media_id: m.id, name: m.custom_name || m.filename, path: m.filepath, rate, duration,
      frames: Math.round(duration * rate.real), width: m.width || 1920, height: m.height || 1080,
      hasVideo: m.media_type ? m.media_type === 'video' : Boolean(m.video_codec),
      hasAudio: m.media_type === 'audio' || Boolean(m.audio_codec) || !m.video_codec,
      fid: uid(), master: uid(), midV: uid(), midA1: uid(), midA2: uid()
    };
  }

  _fileXml(s) {
    const video = s.hasVideo
      ? `<video><samplecharacteristics><width>${s.width}</width><height>${s.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio></samplecharacteristics><duration>${s.frames}</duration></video>`
      : '';
    const audio = s.hasAudio
      ? '<audio><channelcount>2</channelcount><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><layout>stereo</layout><audiochannel><sourcechannel>1</sourcechannel></audiochannel></audio>'
      : '';
    return `<file id="${s.fid}"><name>${esc(s.name)}</name>${rateXml(s.rate)}<duration>${s.frames}</duration><media>${video}${audio}</media><pathurl>${esc(pathUrl(s.path))}</pathurl></file>`;
  }

  _link(mt, ti, ci, ref) {
    return `<link><mediatype>${mt}</mediatype><trackindex>${ti}</trackindex><clipindex>${ci}</clipindex><groupindex>1</groupindex><linkclipref>${ref}</linkclipref></link>`;
  }

  /** <clip> do bin: master clip com 1 trilha de vídeo (se houver) e 2 de áudio (se houver), como no exemplo. */
  _masterClipXml(s) {
    const links = (s.hasVideo ? this._link('video', 1, 1, s.midV) : '') + (s.hasAudio ? this._link('audio', 1, 1, s.midA1) + this._link('audio', 2, 1, s.midA2) : '');
    const ci = (id) => `<clipitem id="${id}"><masterclipid>${s.master}</masterclipid>${this._fileXml(s)}${links}</clipitem>`;
    const video = s.hasVideo ? `<video><track>${ci(s.midV)}<enabled>TRUE</enabled><locked>FALSE</locked></track></video>` : '';
    const audio = s.hasAudio ? `<audio><track>${ci(s.midA1)}<enabled>TRUE</enabled><locked>FALSE</locked></track><track>${ci(s.midA2)}<enabled>TRUE</enabled><locked>FALSE</locked></track></audio>` : '';
    return `<clip explodedTracks="TRUE" id="${s.master}"><name>${esc(s.name)}</name><duration>${s.frames}</duration>${rateXml(s.rate)}<masterclipid>${s.master}</masterclipid><ismasterclip>TRUE</ismasterclip><media>${video}${audio}</media></clip>`;
  }

  /** Bins aninhados do projeto com os master clips; `sources` = Map media_id → fonte. */
  _binsXml(projectId, sources) {
    const bins = this.projectService.getProjectBins(projectId);
    const media = this.projectService.getProjectMedia(projectId);
    const render = (parentId) => {
      let out = '';
      for (const b of bins.filter((x) => (x.parent_id || null) === parentId)) {
        const clips = media.filter((m) => m.bin_id === b.id && sources.has(m.id)).map((m) => this._masterClipXml(sources.get(m.id))).join('');
        out += `<bin><name>${esc(b.name)}</name><children>${render(b.id)}${clips}</children></bin>`;
      }
      return out;
    };
    const loose = media.filter((m) => !m.bin_id && sources.has(m.id)).map((m) => this._masterClipXml(sources.get(m.id))).join('');
    return render(null) + loose;
  }

  _projectXml(name, children) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><project><name>${esc(name)}</name><children>${children}</children></project>`
      + `<importoptions><createnewproject>FALSE</createnewproject><targetprojectname>${esc(name)}</targetprojectname><defsequencepresetname>useFirstClipSettings</defsequencepresetname>`
      + '<displaynonfatalerrors>TRUE</displaynonfatalerrors><filterreconnectmediafiles>TRUE</filterreconnectmediafiles><filterincludemarkers>TRUE</filterincludemarkers>'
      + '<filterincludeeffects>TRUE</filterincludeeffects><filterincludesequencesettings>FALSE</filterincludesequencesettings></importoptions></xmeml>';
  }

  /** Só as pastas (bins) com os master clips: para organizar o projeto do Premiere sem sequência. */
  exportBins(projectId, outputPath) {
    const project = this.projectService.getProjectById(projectId);
    if (!project) throw new Error('Projeto não encontrado');
    const media = this.projectService.getProjectMedia(projectId).filter((m) => m.media_type !== 'photo' && m.media_type !== 'raw');
    const sources = new Map(media.map((m) => [m.id, this._source(m)]));
    const xml = this._projectXml(project.name, this._binsXml(projectId, sources));
    fs.writeFileSync(outputPath, xml, 'utf8');
    return { filePath: outputPath, clips: sources.size };
  }

  /**
   * Pastas + sequência multicâmera: uma camada de vídeo por fonte (V1 = mestre) e um par de trilhas de áudio
   * estéreo por fonte, clipes posicionados pela sincronização. `lanes` vem de MulticamSyncService.getModel.
   */
  exportMulticam(projectId, model, outputPath, { sequenceName = null, fps = null } = {}) {
    const project = this.projectService.getProjectById(projectId);
    if (!project) throw new Error('Projeto não encontrado');
    const media = this.projectService.getProjectMedia(projectId);
    const sources = new Map(media.filter((m) => m.media_type !== 'photo' && m.media_type !== 'raw').map((m) => [m.id, this._source(m)]));

    const lanes = (model.lanes || []).filter((l) => l.clips.some((c) => c.placed));
    const masterLane = lanes.find((l) => l.is_master) || lanes[0];
    const seqRate = rateOf(fps || (masterLane && masterLane.clips.find((c) => c.kind === 'video' && c.fps) || {}).fps || 30);
    const F = (sec) => Math.max(0, Math.round(sec * seqRate.real));
    const shift = Math.min(0, model.start || 0); // clipes antes do mestre: desloca a linha inteira
    const ordered = [masterLane, ...lanes.filter((l) => l !== masterLane)].filter(Boolean);

    // Itens por trilha
    const videoTracks = []; // [{ items: [...] }]
    const audioPairs = [];
    const items = [];
    ordered.forEach((lane, laneIndex) => {
      const vt = { items: [] }; const at = { items: [] };
      for (const c of lane.clips) {
        if (!c.placed) continue;
        const s = sources.get(c.media_id);
        if (!s) continue;
        const start = F(c.offset - shift);
        const end = start + Math.round(c.duration * seqRate.real);
        const base = { src: s, start, end, srcIn: 0, label: s.name, laneIndex };
        const v = s.hasVideo ? { ...base, kind: 'video', id: uid(), trackIndex: videoTracks.length + 1, partner: null } : null;
        const a = s.hasAudio ? { ...base, kind: 'audio', ids: [uid(), uid()], pairIndex: audioPairs.length + 1, partner: null } : null;
        if (v && a) { v.partner = a; a.partner = v; }
        if (v) { vt.items.push(v); items.push(v); }
        if (a) { at.items.push(a); items.push(a); }
      }
      if (vt.items.length) { vt.items.forEach((i) => { i.trackIndex = videoTracks.length + 1; }); videoTracks.push(vt); }
      if (at.items.length) { at.items.forEach((i) => { i.pairIndex = audioPairs.length + 1; }); audioPairs.push(at); }
    });
    for (const t of [...videoTracks, ...audioPairs]) { t.items.sort((a, b) => a.start - b.start); t.items.forEach((it, i) => { it.ci = i + 1; }); }

    const clipItemXml = (it, ch) => {
      const s = it.src;
      const cid = ch == null ? it.id : it.ids[ch - 1];
      const dur = Math.round(s.duration * seqRate.real);
      let x = `<clipitem id="${cid}"${ch != null ? ' premiereChannelType="stereo"' : ''}><name>${esc(it.label)}</name><duration>${dur}</duration>${rateXml(seqRate)}`
        + `<in>${it.srcIn}</in><out>${it.srcIn + (it.end - it.start)}</out><start>${it.start}</start><end>${it.end}</end><masterclipid>${s.master}</masterclipid>${this._fileXml(s)}`;
      x += ch == null ? '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>' : `<sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>`;
      const v = it.kind === 'video' ? it : it.partner;
      const a = it.kind === 'audio' ? it : it.partner;
      if (v) x += this._link('video', v.trackIndex, v.ci, v.id);
      if (a) x += this._link('audio', a.pairIndex * 2 - 1, a.ci, a.ids[0]) + this._link('audio', a.pairIndex * 2, a.ci, a.ids[1]);
      return x + '</clipitem>';
    };
    const videoXml = videoTracks.map((t) => `<track>${t.items.map((it) => clipItemXml(it)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`).join('');
    const audioXml = audioPairs.map((t) => [1, 2].map((ch) =>
      `<track TL.SQTrackExpanded="0" currentExplodedTrackIndex="${ch - 1}" premiereTrackType="Stereo" totalExplodedTrackCount="2">${t.items.map((it) => clipItemXml(it, ch)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`).join('')).join('');

    const markers = (this.projectService.getMarkers ? this.projectService.getMarkers(projectId) : [])
      .filter((m) => m.sequence_id == null)
      .map((m) => `<marker><name>${esc(m.label || '')}</name><comment>${esc(m.comment || '')}</comment><in>${F((Number(m.time) || 0) - shift)}</in><out>-1</out></marker>`).join('');
    const end = items.reduce((max, it) => Math.max(max, it.end), 0);
    const first = masterLane && masterLane.clips.find((c) => c.kind === 'video');
    const width = (first && first.width) || 1920; const height = (first && first.height) || 1080;
    const sid = crypto.randomUUID();
    const name = sequenceName || `${project.name} - Multicam`;
    const sequence = `<sequence id="${sid}"><name>${esc(name)}</name><duration>${end}</duration>${rateXml(seqRate)}${markers}`
      + `<media><video>${videoXml}<format><samplecharacteristics><width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio>${rateXml(seqRate)}</samplecharacteristics></format></video>`
      + `<audio>${audioXml}</audio></media><uuid>${sid}</uuid></sequence>`;

    const xml = this._projectXml(project.name, this._binsXml(projectId, sources) + sequence);
    fs.writeFileSync(outputPath, xml, 'utf8');
    return { filePath: outputPath, videoTracks: videoTracks.length, audioTracks: audioPairs.length * 2, clips: items.length, durationSeconds: end / seqRate.real };
  }
}

module.exports = XmemlExporter;
module.exports.rateOf = rateOf;
module.exports.pathUrl = pathUrl;
