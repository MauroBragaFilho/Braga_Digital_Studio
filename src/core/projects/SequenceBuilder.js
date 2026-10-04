/**
 * SequenceBuilder — Fase F do plano de refatoração da Project Workspace.
 *
 * Constrói um modelo de sequência EFÊMERO (não persistido em `timeline_tracks`/
 * `timeline_clips`) a partir dos Sync Groups de um projeto. A "sequência" é
 * apenas uma estrutura de dados calculada sob demanda — usada para exportação
 * (Premiere XML, Fase G) ou para qualquer visualização que precise das mídias
 * já posicionadas no tempo.
 *
 * Regras:
 * - Cada mídia de vídeo dentro de um Sync Group vira UMA track de vídeo própria
 *   ("1 track de vídeo por câmera").
 * - Cada mídia de áudio dentro de um Sync Group vira UMA track de áudio própria
 *   ("1 track de áudio por gravador externo").
 * - A posição (start) de cada clipe é o `offset_seconds` calculado pela
 *   sincronização por áudio.
 * - Mídias do projeto que não pertencem a nenhum Sync Group também entram,
 *   cada uma em sua própria track, começando em 0s (sem offset conhecido).
 */
class SequenceBuilder {
    constructor(projectService) {
        this.projectService = projectService;
    }

    /** 'video' | 'audio' | null (foto/RAW não entram na sequência). Prefere media_type; cai no codec (RK-038). */
    _kind(mediaRow) {
        if (!mediaRow) return null;
        const t = mediaRow.media_type;
        if (t === 'photo' || t === 'raw') return null;
        if (t === 'video') return 'video';
        if (t === 'audio') return 'audio';
        return mediaRow.video_codec ? 'video' : 'audio';
    }

    _isVideo(mediaRow) {
        return this._kind(mediaRow) === 'video';
    }

    _addTrackWithClip(tracks, prefix, media, startSeconds, sourceLabel) {
        const index = tracks.length + 1;
        tracks.push({
            index,
            name: `${prefix}${index}`,
            clips: [{
                media_id: media.id,
                pm_id: media.pm_id,
                filename: media.custom_name || media.filename,
                filepath: media.filepath,
                start: startSeconds || 0, // pode ser negativo: buildSequenceModel normaliza a linha do tempo
                duration: media.duration || 0,
                in: 0,
                out: media.duration || 0,
                fps: media.fps || 29.97,
                width: media.width,
                height: media.height,
                syncGroupName: sourceLabel || null
            }]
        });
    }

    /**
     * @param {number} projectId
     * @returns {{
     *   projectId: number, projectName: string, fps: number, width: number,
     *   height: number, duration: number,
     *   videoTracks: Array<{index:number,name:string,clips:Array}>,
     *   audioTracks: Array<{index:number,name:string,clips:Array}>
     * }}
     */
    buildSequenceModel(projectId) {
        const project = this.projectService.getProjectById(projectId);
        if (!project) throw new Error(`Projeto ${projectId} não encontrado`);

        const allMedia = this.projectService.getProjectMedia(projectId);
        const mediaById = new Map(allMedia.map(m => [m.id, m]));

        const syncGroups = this.projectService.getSyncGroups(projectId);
        const groupedMediaIds = new Set();
        syncGroups.forEach(g => (g.items || []).forEach(it => groupedMediaIds.add(it.media_id)));

        const videoTracks = [];
        const audioTracks = [];

        // 1. Mídias organizadas em Sync Groups — posicionadas pelo offset calculado
        syncGroups.forEach(group => {
            (group.items || []).forEach(item => {
                const media = mediaById.get(item.media_id);
                if (!media) return; // mídia foi removida do projeto após a sincronização
                const kind = this._kind(media);
                if (!kind) return;
                if (kind === 'video') {
                    this._addTrackWithClip(videoTracks, 'V', media, item.offset_seconds, group.name);
                } else {
                    this._addTrackWithClip(audioTracks, 'A', media, item.offset_seconds, group.name);
                }
            });
        });

        // 2. Mídias fora de qualquer Sync Group — cada uma em sua própria track, começando em 0s
        allMedia.filter(m => !groupedMediaIds.has(m.id) && this._kind(m)).forEach(media => {
            if (this._isVideo(media)) {
                this._addTrackWithClip(videoTracks, 'V', media, 0, null);
            } else {
                this._addTrackWithClip(audioTracks, 'A', media, 0, null);
            }
        });

        // Offsets negativos (clipe que começa ANTES do master): desloca toda a linha do tempo por -mínimo,
        // em vez de truncar em 0 e perder o alinhamento (RK-033).
        const minStart = [...videoTracks, ...audioTracks].reduce((min, t) => t.clips.reduce((m2, c) => Math.min(m2, c.start), min), 0);
        const offsetShift = minStart < 0 ? -minStart : 0;
        if (offsetShift > 0) {
            [...videoTracks, ...audioTracks].forEach(t => t.clips.forEach(c => { c.start += offsetShift; }));
        }

        const allTracks = [...videoTracks, ...audioTracks];
        const duration = allTracks.reduce((max, t) => {
            return t.clips.reduce((m2, c) => Math.max(m2, c.start + c.duration), max);
        }, 0);

        const firstVideoClip = videoTracks[0]?.clips[0];

        return {
            projectId,
            projectName: project.name,
            fps: firstVideoClip?.fps || 29.97,
            width: firstVideoClip?.width || 1920,
            height: firstVideoClip?.height || 1080,
            duration,
            offsetShift,
            videoTracks,
            audioTracks
        };
    }
}

module.exports = SequenceBuilder;
