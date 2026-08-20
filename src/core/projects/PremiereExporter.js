const fs = require('fs');
const path = require('path');

class PremiereExporter {
    constructor(projectService, sequenceBuilder) {
        this.projectService = projectService;
        this.sequenceBuilder = sequenceBuilder;
    }

    _generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    _escapeXml(unsafe) {
        if (!unsafe) return '';
        return unsafe.toString().replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    _buildBinXml(bin, allBins, allMedia) {
        // Find children bins
        const childrenBins = allBins.filter(b => b.parent_id === bin.id);
        // Find media in this bin
        const binMedia = allMedia.filter(m => m.bin_id === bin.id);

        let xml = `
            <bin>
                <name>${this._escapeXml(bin.name)}</name>
                <children>
`;
        
        // Render sub-bins
        for (const childBin of childrenBins) {
            xml += this._buildBinXml(childBin, allBins, allMedia);
        }

        // Render media clips
        for (const item of binMedia) {
            const clipId = `clip-${item.pm_id}`;
            const fileId = `file-${item.pm_id}`;
            // Convert to absolute file:// URL (FCP 7 XML spec)
            const filePathUrl = 'file://localhost/' + item.filepath.replace(/\\/g, '/').replace(/ /g, '%20');
            const itemName = item.custom_name || item.filename;

            xml += `
                <clip id="${clipId}">
                    <name>${this._escapeXml(itemName)}</name>
                    <duration>${Math.round((item.duration || 0) * (item.fps || 30))}</duration>
                    <rate>
                        <timebase>${Math.round(item.fps || 30)}</timebase>
                        <ntsc>${(item.fps || 30) % 1 !== 0 ? 'TRUE' : 'FALSE'}</ntsc>
                    </rate>
                    <media>
                        <video>
                            <track>
                                <clipitem id="${clipId}-video">
                                    <name>${this._escapeXml(itemName)}</name>
                                    <file id="${fileId}">
                                        <name>${this._escapeXml(itemName)}</name>
                                        <pathurl>${this._escapeXml(filePathUrl)}</pathurl>
                                    </file>
                                </clipitem>
                            </track>
                        </video>
                    </media>
                </clip>
`;
        }

        xml += `
                </children>
            </bin>
`;
        return xml;
    }

    exportToPremiereXml(projectId, outputPath) {
        const project = this.projectService.getProjectById(projectId);
        if (!project) throw new Error('Projeto não encontrado');

        const allBins = this.projectService.getProjectBins(projectId);
        const allMedia = this.projectService.getProjectMedia(projectId);

        // Root bins (no parent)
        const rootBins = allBins.filter(b => !b.parent_id);
        const rootMedia = allMedia.filter(m => !m.bin_id);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <project>
    <name>${this._escapeXml(project.name)}</name>
    <children>
`;

        for (const rootBin of rootBins) {
            xml += this._buildBinXml(rootBin, allBins, allMedia);
        }

        for (const item of rootMedia) {
            const clipId = `clip-${item.pm_id}`;
            const fileId = `file-${item.pm_id}`;
            const filePathUrl = 'file://localhost/' + item.filepath.replace(/\\/g, '/').replace(/ /g, '%20');
            const itemName = item.custom_name || item.filename;

            xml += `
                <clip id="${clipId}">
                    <name>${this._escapeXml(itemName)}</name>
                    <file id="${fileId}">
                        <name>${this._escapeXml(itemName)}</name>
                        <pathurl>${this._escapeXml(filePathUrl)}</pathurl>
                    </file>
                </clip>
`;
        }

        xml += `
    </children>
  </project>
</xmeml>
`;

        fs.writeFileSync(outputPath, xml, 'utf8');
        return outputPath;
    }

    // ==========================================================================
    // FASE G — Exportação de SEQUÊNCIA (com tracks/offsets) para Premiere
    // ==========================================================================
    //
    // IMPORTANTE (ver plano — Fase G): a estrutura de <sequence>/<clipitem> abaixo
    // segue o formato padrão FCP7 XML (xmeml v4/v5), mas NÃO foi validada
    // importando de volta num Premiere real. Antes de confiar neste XML em
    // produção, siga a estratégia recomendada: criar uma sequência simples no
    // Premiere, exportar como XML, comparar contra a saída deste método e
    // ajustar timebase/drop-frame/estrutura conforme necessário.

    _framesFromSeconds(seconds, fps) {
        return Math.max(0, Math.round((seconds || 0) * fps));
    }

    _buildClipItemXml(clip, fps, ntsc, clipIndex) {
        const clipId = `clipitem-${clip.media_id}-${clipIndex}`;
        const fileId = `file-${clip.media_id}`;
        const itemName = clip.filename;
        const filePathUrl = 'file://localhost/' + (clip.filepath || '').replace(/\\/g, '/').replace(/ /g, '%20');

        const startFrames = this._framesFromSeconds(clip.start, fps);
        const durationFrames = this._framesFromSeconds(clip.duration, fps);
        const inFrames = this._framesFromSeconds(clip.in, fps);
        const outFrames = inFrames + durationFrames;
        const endFrames = startFrames + durationFrames;

        return `
                <clipitem id="${clipId}">
                    <name>${this._escapeXml(itemName)}</name>
                    <duration>${durationFrames}</duration>
                    <rate>
                        <timebase>${Math.round(fps)}</timebase>
                        <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>
                    </rate>
                    <start>${startFrames}</start>
                    <end>${endFrames}</end>
                    <in>${inFrames}</in>
                    <out>${outFrames}</out>
                    <file id="${fileId}">
                        <name>${this._escapeXml(itemName)}</name>
                        <pathurl>${this._escapeXml(filePathUrl)}</pathurl>
                        <rate>
                            <timebase>${Math.round(fps)}</timebase>
                            <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>
                        </rate>
                        <duration>${durationFrames}</duration>
                    </file>
                </clipitem>
`;
    }

    _buildTrackXml(track, fps, ntsc) {
        const clipsXml = track.clips.map((clip, i) => this._buildClipItemXml(clip, fps, ntsc, `${track.index}-${i}`)).join('');
        return `
                <track>
${clipsXml}
                </track>
`;
    }

    /**
     * Gera um XML de SEQUÊNCIA (tracks de vídeo/áudio já posicionadas pelos offsets
     * dos Sync Groups), a partir do modelo efêmero produzido pelo SequenceBuilder.
     * Não depende de timeline_clips persistidos — a sequência é derivada na hora.
     */
    exportSequenceXml(projectId, outputPath) {
        if (!this.sequenceBuilder) throw new Error('SequenceBuilder não configurado no PremiereExporter');

        const model = this.sequenceBuilder.buildSequenceModel(projectId);
        const fps = model.fps || 29.97;
        const ntsc = Math.abs(fps - Math.round(fps)) > 0.001; // 29.97/23.976/59.94 etc = drop-frame NTSC
        const durationFrames = this._framesFromSeconds(model.duration, fps);

        const videoTracksXml = model.videoTracks.map(t => this._buildTrackXml(t, fps, ntsc)).join('');
        const audioTracksXml = model.audioTracks.map(t => this._buildTrackXml(t, fps, ntsc)).join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${this._escapeXml(model.projectName)}</name>
    <duration>${durationFrames}</duration>
    <rate>
      <timebase>${Math.round(fps)}</timebase>
      <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${model.width}</width>
            <height>${model.height}</height>
            <rate>
              <timebase>${Math.round(fps)}</timebase>
              <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>
            </rate>
          </samplecharacteristics>
        </format>
${videoTracksXml}
      </video>
      <audio>
${audioTracksXml}
      </audio>
    </media>
  </sequence>
</xmeml>
`;

        fs.writeFileSync(outputPath, xml, 'utf8');
        return outputPath;
    }
}

module.exports = PremiereExporter;
