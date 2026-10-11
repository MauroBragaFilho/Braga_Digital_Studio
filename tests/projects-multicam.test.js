'use strict';

// Sincronização multicâmera (FFT sobre envelopes) e exportador xmeml no formato do Premiere/PluralEyes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fft, downsample, fftCrossCorrelate } = require('../src/core/projects/fft');
const MulticamSyncService = require('../src/core/projects/MulticamSyncService');
const XmemlExporter = require('../src/core/projects/XmemlExporter');
const { rateOf } = require('../src/core/projects/XmemlExporter');

/** Envelope sintético: ruído determinístico (LCG) com "eventos" para a correlação ter o que achar. */
function noise(n, seed) {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s / 4294967296); }
  return out;
}

test('fft: ida e volta recupera o sinal; downsample faz média por blocos', () => {
  const re = Float64Array.from([1, 2, 3, 4, 0, 0, 0, 0]); const im = new Float64Array(8);
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(re[i] - [1, 2, 3, 4, 0, 0, 0, 0][i]) < 1e-9);
  assert.deepEqual([...downsample(Float32Array.from([1, 1, 1, 3, 3, 3, 5]), 3)], [1, 3, 5]);
});

test('fftCrossCorrelate: encontra onde um trecho curto está dentro de uma gravação longa (inclusive antes do início)', () => {
  const master = noise(20000, 7); // 20000 amostras "de 100 ms" = 33 min
  for (const at of [0, 123, 9876, 19000]) {
    const target = master.subarray(at, at + 600);
    const r = fftCrossCorrelate(master, target);
    assert.equal(r.shift, at, `posição ${at}`);
    assert.ok(r.confidence > 0.9, `confiança alta em ${at}: ${r.confidence}`);
  }
  // clipe que começa 50 amostras ANTES do master (só 550 sobrepõem)
  const early = new Float32Array(600);
  early.set(noise(50, 99), 0); early.set(master.subarray(0, 550), 50);
  const r = fftCrossCorrelate(master, early);
  assert.equal(r.shift, -50);
  // trecho que não existe no master: confiança baixa
  assert.ok(fftCrossCorrelate(master, noise(600, 12345)).confidence < 0.35);
});

test('MulticamSyncService: fontes por pasta, clipes encadeados, mestre fixa a linha do tempo e os demais são achados nela', async () => {
  // envelopes de 20 ms: 3 "arquivos" da câmera (contínuos) e 1 gravação do PC que começa 30 s depois da câmera
  const camEnv = noise(3 * 60 * 50, 42); // 3 minutos
  const envs = {
    'cam1.MTS': camEnv.subarray(0, 3000), 'cam2.MTS': camEnv.subarray(3000, 6000), 'cam3.MTS': camEnv.subarray(6000, 9000),
    'pc.mkv': camEnv.subarray(1500, 1500 + 5000), // começa em 30 s, dura 100 s
    'quadro.MTS': new Float32Array(2000)
  };
  const media = [
    { id: 1, pm_id: 1, bin_id: 10, filename: 'cam1.MTS', filepath: 'C:/x/cam1.MTS', duration: 60, fps: 59.94, media_type: 'video', audio_codec: 'ac3', recorded_at: '2026-10-02 10:00:00' },
    { id: 2, pm_id: 2, bin_id: 10, filename: 'cam2.MTS', filepath: 'C:/x/cam2.MTS', duration: 60, fps: 59.94, media_type: 'video', audio_codec: 'ac3', recorded_at: '2026-10-02 10:01:00' },
    { id: 3, pm_id: 3, bin_id: 10, filename: 'cam3.MTS', filepath: 'C:/x/cam3.MTS', duration: 60, fps: 59.94, media_type: 'video', audio_codec: 'ac3', recorded_at: '2026-10-02 10:02:00' },
    { id: 4, pm_id: 4, bin_id: 20, filename: 'pc.mkv', filepath: 'C:/x/pc.mkv', duration: 100, fps: 30, media_type: 'video', audio_codec: 'aac' },
    { id: 5, pm_id: 5, bin_id: 30, filename: 'quadro.MTS', filepath: 'C:/x/quadro.MTS', duration: 40, fps: 59.94, media_type: 'video', audio_codec: null },
    { id: 6, pm_id: 6, bin_id: 10, filename: 'foto.jpg', filepath: 'C:/x/foto.jpg', media_type: 'photo' }
  ];
  const groups = [];
  const projectService = {
    getProjectBins: () => [{ id: 10, name: 'Câmera da TV', parent_id: null }, { id: 20, name: 'Gravação do PC', parent_id: null }, { id: 30, name: 'Câmera do Quadro', parent_id: null }],
    getProjectMedia: () => media,
    createSyncGroup: (pid, name, master, items) => { groups.push({ id: 77, project_id: pid, name, master_media_id: master, items: items.map((it, i) => ({ id: 100 + i, ...it })) }); return 77; },
    getSyncGroups: () => groups,
    logActivity: () => {}
  };
  const audioSyncService = {
    extractEnvelope: async (fp) => envs[path.basename(fp)],
    _localOffsetAt: () => null // sem refino: o grosso (100 ms) já é exato neste sintético
  };
  const svc = new MulticamSyncService({ projectService, audioSyncService });
  const sources = svc.listSources(1);
  assert.deepEqual(sources.map((s) => [s.name, s.items.length, s.has_audio]), [['Câmera da TV', 3, true], ['Câmera do Quadro', 1, false], ['Gravação do PC', 1, true]]);
  assert.deepEqual(sources[0].items.map((c) => c.chain_pos), [0, 60, 120], 'clipes da câmera encadeados');

  const progress = [];
  const r = await svc.sync({ projectId: 1, masterSourceId: 10, onProgress: (p) => progress.push(p.stage) });
  assert.equal(r.groupId, 77);
  const pc = r.lanes.find((l) => l.name === 'Gravação do PC').clips[0];
  assert.ok(Math.abs(pc.offset - 30) < 0.11, `PC posicionado em 30 s (veio ${pc.offset})`);
  assert.ok(pc.confidence > 0.8);
  const cam = r.lanes.find((l) => l.name === 'Câmera da TV');
  assert.ok(cam.is_master);
  assert.deepEqual(cam.clips.map((c) => c.offset), [0, 60, 120]);
  const quadro = r.lanes.find((l) => l.name === 'Câmera do Quadro').clips[0];
  assert.equal(quadro.placed, false, 'sem áudio e sem nenhum clipe da fonte sincronizado: fica para ajuste manual');
  assert.ok(progress.includes('master') && progress.includes('correlate') && progress.includes('done'));
  assert.ok(Math.abs(r.duration - 180) < 0.2);
});

test('XmemlExporter: pastas com master clips e sequência multicâmera no formato de referência (rate por clipitem, links, importoptions)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-xmeml-'));
  try {
    const media = [
      { id: 1, pm_id: 1, bin_id: 10, filename: 'cam1.MTS', custom_name: null, filepath: 'D:/Brutos/Câmera da TV/cam1.MTS', duration: 60, fps: 59.94, width: 1920, height: 1080, media_type: 'video', video_codec: 'h264', audio_codec: 'ac3' },
      { id: 4, pm_id: 4, bin_id: 20, filename: 'pc.mkv', filepath: 'D:/Brutos/PC/pc.mkv', duration: 100, fps: 30, width: 1920, height: 1080, media_type: 'video', video_codec: 'h264', audio_codec: 'aac' },
      { id: 7, pm_id: 7, bin_id: 20, filename: 'lapela.wav', filepath: 'D:/Brutos/PC/lapela.wav', duration: 100, fps: 0, media_type: 'audio', video_codec: null, audio_codec: 'pcm' }
    ];
    const projectService = {
      getProjectById: () => ({ id: 1, name: 'Aula & Teste' }),
      getProjectBins: () => [{ id: 10, name: 'Câmera da TV', parent_id: null }, { id: 20, name: 'Gravação do PC', parent_id: null }, { id: 21, name: 'Extras', parent_id: 20 }],
      getProjectMedia: () => media,
      getMarkers: () => [{ sequence_id: null, time: 15, label: 'Abertura', comment: 'boas-vindas' }]
    };
    const ex = new XmemlExporter(projectService);
    assert.deepEqual([rateOf(29.97).ntsc, rateOf(29.97).tb, rateOf(59.94).tb, rateOf(25).ntsc, rateOf(25).tb], ['TRUE', 30, 60, 'FALSE', 25]);

    const bins = ex.exportBins(1, path.join(dir, 'pastas.xml'));
    const x1 = fs.readFileSync(bins.filePath, 'utf8');
    assert.match(x1, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><project><name>Aula &amp; Teste<\/name>/);
    assert.match(x1, /<bin><name>Gravação do PC<\/name><children><bin><name>Extras<\/name><children><\/children><\/bin><clip explodedTracks="TRUE"/);
    assert.match(x1, /<ismasterclip>TRUE<\/ismasterclip>/);
    assert.match(x1, /<pathurl>file:\/\/localhost\/D:\/Brutos\/C%C3%A2mera%20da%20TV\/cam1.MTS<\/pathurl>/);
    assert.match(x1, /<importoptions><createnewproject>FALSE<\/createnewproject><targetprojectname>Aula &amp; Teste<\/targetprojectname><defsequencepresetname>useFirstClipSettings<\/defsequencepresetname>/);
    assert.doesNotMatch(x1, /<sequence/);
    // áudio puro: master clip só com trilhas de áudio
    assert.match(x1, /<clip explodedTracks="TRUE" id="[^"]+"><name>lapela.wav<\/name><duration>3000<\/duration><rate><ntsc>FALSE<\/ntsc><timebase>30<\/timebase><\/rate><masterclipid>[^<]+<\/masterclipid><ismasterclip>TRUE<\/ismasterclip><media><audio>/);
    assert.match(x1, /<name>pc.mkv<\/name><duration>3000<\/duration><rate><ntsc>FALSE<\/ntsc><timebase>30<\/timebase>/, '30 fps exatos não viram 29,97');

    const model = {
      start: -2, lanes: [
        { id: 10, name: 'Câmera da TV', is_master: true, clips: [{ media_id: 1, kind: 'video', fps: 59.94, width: 1920, height: 1080, duration: 60, offset: 0, placed: true }] },
        { id: 20, name: 'Gravação do PC', is_master: false, clips: [{ media_id: 4, kind: 'video', fps: 30, duration: 100, offset: -2, placed: true }, { media_id: 7, kind: 'audio', duration: 100, offset: -2, placed: true }] }
      ]
    };
    const mc = ex.exportMulticam(1, model, path.join(dir, 'multicam.xml'), { sequenceName: 'MULTICAM' });
    const x2 = fs.readFileSync(mc.filePath, 'utf8');
    assert.equal(mc.videoTracks, 2, 'uma camada de vídeo por fonte');
    assert.equal(mc.audioTracks, 4, 'um par estéreo por fonte');
    assert.match(x2, /<sequence id="[^"]+"><name>MULTICAM<\/name><duration>\d+<\/duration><rate><ntsc>TRUE<\/ntsc><timebase>60<\/timebase><\/rate><marker><name>Abertura<\/name><comment>boas-vindas<\/comment><in>\d+<\/in><out>-1<\/out><\/marker>/);
    // clipe antes do mestre: linha deslocada 2 s → PC começa em 0 e a câmera em 2 s (120 frames a 59,94)
    const starts = [...x2.matchAll(/<start>(\d+)<\/start>/g)].map((m) => Number(m[1]));
    assert.ok(starts.includes(0) && starts.includes(120), `starts: ${[...new Set(starts)].join(',')}`);
    assert.match(x2, /premiereChannelType="stereo"/);
    assert.match(x2, /<track TL.SQTrackExpanded="0" currentExplodedTrackIndex="1" premiereTrackType="Stereo" totalExplodedTrackCount="2">/);
    assert.match(x2, /<sourcetrack><mediatype>audio<\/mediatype><trackindex>2<\/trackindex><\/sourcetrack>/);
    assert.match(x2, /<link><mediatype>video<\/mediatype><trackindex>2<\/trackindex><clipindex>1<\/clipindex><groupindex>1<\/groupindex><linkclipref>/);
    assert.match(x2, /<uuid>[0-9a-f-]{36}<\/uuid><\/sequence>/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
