const fs = require('fs');
const path = require('path');
// [PERF] adm-zip só é carregado quando um pacote .bdspro é lido/gravado (não na abertura do app).
let _AdmZip = null;
const loadAdmZip = () => (_AdmZip || (_AdmZip = require('adm-zip')));
const logger = require('../../services/logService');

// Limites e validação de pacote (RK-053): o .bdspro vem de fora e não é confiável.
const MAX_BDSPRO_BYTES = 512 * 1024 * 1024;        // arquivo .bdspro
const MAX_PROJECT_JSON_BYTES = 50 * 1024 * 1024;   // project.json descompactado
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;          // qualquer outra entrada (capa, miniaturas)
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 50000;
const MAX_LIST_ITEMS = 100000;
const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COVER_NAME_RE = /^cover\.(?:jpe?g|png|webp|gif|bmp)$/i;
const DEFAULT_PROJECT_COLOR = '#3b82f6';

/** Caminho de rede UNC (duas barras iniciais): nunca tocado a partir de dados do pacote. */
function isUncPath(p) {
    return typeof p === 'string' && /^[\\/]{2}/.test(p.trim());
}

/** true se `target` está dentro de `baseDir` (ou é ele mesmo). */
function isInsideDir(baseDir, target) {
    const rel = path.relative(path.resolve(baseDir), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Abre o .bdspro com limites de tamanho/entradas e devolve { zip, projectData } já validado.
 * Recusa caminho UNC para o próprio pacote, arquivo grande demais, zip com entradas demais
 * ou declarando tamanhos descompactados absurdos, e project.json fora do schema.
 */
function readBdsproPackage(bdsproPath) {
    if (typeof bdsproPath !== 'string' || !bdsproPath) throw new Error('Caminho do arquivo .bdspro inválido.');
    if (isUncPath(bdsproPath)) throw new Error('Caminhos de rede (UNC) não são aceitos para pacotes .bdspro.');
    const st = fs.statSync(bdsproPath);
    if (!st.isFile()) throw new Error('Arquivo .bdspro inválido.');
    if (st.size > MAX_BDSPRO_BYTES) throw new Error('Arquivo .bdspro grande demais (máximo 512 MB).');

    const zip = new (loadAdmZip())(bdsproPath);
    const entries = zip.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) throw new Error('Arquivo .bdspro com entradas demais.');
    let total = 0;
    for (const entry of entries) {
        const declared = Number(entry.header && entry.header.size) || 0;
        const limit = entry.entryName === 'project.json' ? MAX_PROJECT_JSON_BYTES : MAX_ENTRY_BYTES;
        if (declared > limit) throw new Error(`Entrada '${entry.entryName}' grande demais no pacote .bdspro.`);
        total += declared;
        if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('Conteúdo descompactado do .bdspro grande demais.');
    }

    const projectEntry = zip.getEntry('project.json');
    if (!projectEntry) throw new Error('Arquivo .bdspro inválido: project.json não encontrado dentro do pacote');
    const raw = projectEntry.getData();
    if (raw.length > MAX_PROJECT_JSON_BYTES) throw new Error('project.json grande demais no pacote .bdspro.');
    const projectData = JSON.parse(raw.toString('utf8'));
    validateProjectData(projectData);
    return { zip, projectData };
}

/**
 * Valida (e sanitiza in loco) o project.json de um pacote: tipos das listas, limites, uuid por
 * regex, cor hexadecimal e nome de capa simples. Lança em caso de estrutura inválida.
 */
function validateProjectData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('project.json inválido: estrutura inesperada.');
    for (const key of ['media', 'folders', 'syncGroups', 'markers']) {
        if (data[key] === undefined || data[key] === null) continue;
        if (!Array.isArray(data[key])) throw new Error(`project.json inválido: '${key}' deve ser uma lista.`);
        if (data[key].length > MAX_LIST_ITEMS) throw new Error(`project.json inválido: '${key}' com itens demais.`);
    }
    if (data.metadata !== undefined && data.metadata !== null && (typeof data.metadata !== 'object' || Array.isArray(data.metadata))) {
        throw new Error('project.json inválido: metadata deve ser um objeto.');
    }
    const metadata = data.metadata || {};
    if (typeof metadata.color !== 'string' || !HEX_COLOR_RE.test(metadata.color)) metadata.color = DEFAULT_PROJECT_COLOR;
    if (metadata.cover_relative_path !== undefined && metadata.cover_relative_path !== null
        && !(typeof metadata.cover_relative_path === 'string' && COVER_NAME_RE.test(metadata.cover_relative_path))) {
        metadata.cover_relative_path = null; // só "cover.<ext de imagem>" na raiz do zip
    }
    data.metadata = metadata;
    for (const m of (data.media || [])) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('project.json inválido: item de mídia malformado.');
        // uuid vira nome de arquivo (miniaturas): só caracteres seguros; senão descarta e gera outro na importação
        if (m.uuid !== undefined && m.uuid !== null && !(typeof m.uuid === 'string' && UUID_RE.test(m.uuid))) m.uuid = null;
    }
}

class BdsproPackageService {
    constructor(projectService) {
        this.projectService = projectService;
    }

    /**
     * Exporta um projeto completo para o formato .bdspro
     * @param {number} projectId 
     * @param {string} outputPath 
     * @param {string} thumbnailsDir 
     */
    async exportBdspro(projectId, outputPath, thumbnailsDir) {
        try {
            const projectModel = this.projectService.getProjectFullModel(projectId);
            if (!projectModel) throw new Error('Projeto não encontrado');

            const zip = new (loadAdmZip())();

            // 1. Processar capa do projeto se existir
            let coverRelativePath = null;
            if (projectModel.metadata.cover_path && fs.existsSync(projectModel.metadata.cover_path)) {
                const coverExt = path.extname(projectModel.metadata.cover_path) || '.jpg';
                coverRelativePath = `cover${coverExt}`;
                const coverBuffer = fs.readFileSync(projectModel.metadata.cover_path);
                zip.addFile(coverRelativePath, coverBuffer);
            }
            projectModel.metadata.cover_relative_path = coverRelativePath;

            // 2. Processar thumbnails das mídias
            if (thumbnailsDir && fs.existsSync(thumbnailsDir)) {
                for (const item of (projectModel.media || [])) {
                    if (item.thumbnail) {
                        const thumbPath = path.isAbsolute(item.thumbnail) 
                            ? item.thumbnail 
                            : path.join(thumbnailsDir, item.thumbnail);
                        
                        if (fs.existsSync(thumbPath)) {
                            const thumbBuffer = fs.readFileSync(thumbPath);
                            zip.addFile(`thumbnails/${path.basename(thumbPath)}`, thumbBuffer);
                        }
                    }
                }
            }

            // 3. Adicionar project.json
            const jsonString = JSON.stringify(projectModel, null, 2);
            zip.addFile('project.json', Buffer.from(jsonString, 'utf8'));

            // 4. Salvar arquivo .bdspro
            const finalOutputPath = outputPath.endsWith('.bdspro') ? outputPath : `${outputPath}.bdspro`;
            
            const outputDir = path.dirname(finalOutputPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            zip.writeZip(finalOutputPath);

            logger.info(`[BdsproPackage] Projeto ${projectId} exportado com sucesso para ${finalOutputPath}`);
            return {
                success: true,
                filePath: finalOutputPath,
                mediaCount: (projectModel.media || []).length,
                tracksCount: ((projectModel.sequence?.video_tracks || []).length + (projectModel.sequence?.audio_tracks || []).length),
                markersCount: (projectModel.markers || []).length
            };
        } catch (error) {
            logger.error(`[BdsproPackage] Erro ao exportar .bdspro:`, error);
            throw error;
        }
    }

    /**
     * Lê e inspeciona um arquivo .bdspro para validação e verificação de mídias ausentes
     * @param {string} bdsproPath 
     */
    async inspectBdspro(bdsproPath) {
        try {
            if (isUncPath(bdsproPath)) throw new Error('Caminhos de rede (UNC) não são aceitos para pacotes .bdspro.');
            if (!fs.existsSync(bdsproPath)) {
                throw new Error(`Arquivo .bdspro não encontrado em: ${bdsproPath}`);
            }

            const { projectData } = readBdsproPackage(bdsproPath);

            const mediaList = projectData.media || [];
            const missingFiles = [];
            const availableFiles = [];

            for (const m of mediaList) {
                const targetPath = m.original_path || m.filepath;
                // Caminho UNC vindo do pacote nunca é consultado (evita acesso SMB/NTLM a servidor remoto)
                const exists = targetPath && !isUncPath(targetPath) && fs.existsSync(targetPath);
                
                const mediaStatus = {
                    media_id: m.id || m.pm_id,
                    uuid: m.uuid,
                    filename: m.filename,
                    original_path: targetPath,
                    filesize: m.filesize,
                    duration: m.duration,
                    exists: !!exists
                };

                if (exists) {
                    availableFiles.push(mediaStatus);
                } else {
                    missingFiles.push(mediaStatus);
                }
            }

            return {
                valid: true,
                metadata: projectData.metadata,
                settings: projectData.settings,
                totalMedia: mediaList.length,
                availableMediaCount: availableFiles.length,
                missingMediaCount: missingFiles.length,
                missingFiles,
                availableFiles,
                foldersCount: (projectData.folders || []).length,
                syncGroupsCount: (projectData.syncGroups || []).length,
                markersCount: (projectData.markers || []).length,
                projectData
            };
        } catch (error) {
            logger.error(`[BdsproPackage] Erro ao inspecionar ${bdsproPath}:`, error);
            throw error;
        }
    }

    /**
     * Varre recursivamente um diretório para indexar arquivos disponíveis para reconexão
     * @param {string} folderPath 
     */
    async scanFolderForMedia(folderPath) {
        const found = [];
        const allowedExts = new Set([
            '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.wmv', '.webm',
            '.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.wma',
            '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp'
        ]);

        // Varredura assíncrona e iterativa (não bloqueia o processo principal), com teto de arquivos e de pastas
        // e cedendo o event loop entre pastas. Pastas ocultas e de sistema são ignoradas.
        const MAX_FILES = 20000;
        const MAX_DIRS = 20000;
        const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);
        const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
        const pending = [folderPath];
        let dirsVisited = 0;
        let truncated = false;

        while (pending.length > 0) {
            if (found.length >= MAX_FILES || dirsVisited >= MAX_DIRS) { truncated = true; break; }
            const dir = pending.pop();
            dirsVisited++;
            let entries;
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (err) {
                logger.warn(`[BdsproPackage] Não foi possível ler pasta: ${dir}`);
                continue;
            }
            const candidates = [];
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (allowedExts.has(ext)) candidates.push({ name: entry.name, fullPath, ext });
                }
            }
            const stats = await Promise.all(candidates.map((c) => fs.promises.stat(c.fullPath).catch(() => null)));
            candidates.forEach((c, i) => {
                if (!stats[i] || found.length >= MAX_FILES) return;
                found.push({
                    filename: c.name,
                    filepath: c.fullPath,
                    filesize: stats[i].size,
                    extension: c.ext.replace('.', '').toUpperCase()
                });
            });
            await yieldLoop();
        }
        if (truncated) logger.warn(`[BdsproPackage] Varredura de ${folderPath} limitada a ${found.length} arquivos / ${dirsVisited} pastas.`);
        return found;
    }

    /**
     * Calcula pontuação de correspondência para sugerir reconexão de mídias
     * @param {Array} missingList 
     * @param {Array} scannedFiles 
     */
    findMatchesForMissing(missingList, scannedFiles) {
        const results = [];

        for (const missing of missingList) {
            let bestMatch = null;
            let highestScore = 0;

            const missingName = (missing.filename || path.basename(missing.original_path || '')).toLowerCase();
            const missingExt = path.extname(missingName).toLowerCase();
            const missingBase = path.basename(missingName, missingExt);

            for (const file of scannedFiles) {
                let score = 0;
                const fileName = file.filename.toLowerCase();
                const fileExt = path.extname(fileName).toLowerCase();
                const fileBase = path.basename(fileName, fileExt);

                // 1. Correspondência exata de nome + extensão (50 pontos)
                if (fileName === missingName) {
                    score += 50;
                } else if (fileBase === missingBase) {
                    score += 35;
                }

                // 2. Extensão idêntica (15 pontos)
                if (fileExt === missingExt) {
                    score += 15;
                }

                // 3. Tamanho de arquivo (35 pontos se idêntico, 20 se próximo)
                if (missing.filesize && file.filesize) {
                    if (missing.filesize === file.filesize) {
                        score += 35;
                    } else {
                        const diffRatio = Math.abs(missing.filesize - file.filesize) / missing.filesize;
                        if (diffRatio < 0.05) {
                            score += 20;
                        }
                    }
                }

                if (score > highestScore && score >= 40) {
                    highestScore = score;
                    bestMatch = {
                        ...file,
                        confidenceScore: score
                    };
                }
            }

            results.push({
                missing,
                matched: bestMatch,
                resolved: highestScore >= 65,
                confidence: highestScore
            });
        }

        return results;
    }

    /**
     * Importa um arquivo .bdspro para o banco de dados BDS
     * @param {string} bdsproPath 
     * @param {Object} relinkMap { [missingOriginalPath]: newResolvedPath }
     * @param {string} thumbnailsDir 
     * @param {string} coversDir 
     */
    async importBdspro(bdsproPath, relinkMap = {}, thumbnailsDir = '', coversDir = '') {
        try {
            const { zip, projectData } = readBdsproPackage(bdsproPath);
            const metadata = projectData.metadata || {};

            // Caminhos de rede (UNC) do pacote são recusados, a menos que o usuário tenha religado a mídia
            for (const m of (projectData.media || [])) {
                const orig = m.original_path || m.filepath;
                if (isUncPath(orig) && !(relinkMap[orig] || relinkMap[m.filename])) {
                    throw new Error('O pacote referencia caminhos de rede (UNC), que não são aceitos na importação.');
                }
            }

            // 1. Extrair capa se existir
            let finalCoverPath = null;
            if (metadata.cover_relative_path) {
                const coverEntry = zip.getEntry(metadata.cover_relative_path);
                if (coverEntry && coversDir) {
                    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
                    const ext = path.extname(metadata.cover_relative_path) || '.jpg';
                    const newCoverName = `cover_proj_${Date.now()}${ext}`;
                    const candidate = path.join(coversDir, newCoverName);
                    if (isInsideDir(coversDir, candidate)) {
                        finalCoverPath = candidate;
                        fs.writeFileSync(finalCoverPath, coverEntry.getData());
                    }
                }
            }

            // 2. Extrair thumbnails
            if (thumbnailsDir) {
                if (!fs.existsSync(thumbnailsDir)) fs.mkdirSync(thumbnailsDir, { recursive: true });
                const entries = zip.getEntries();
                for (const entry of entries) {
                    if (entry.entryName.startsWith('thumbnails/') && !entry.isDirectory) {
                        const targetThumbPath = path.join(thumbnailsDir, path.basename(entry.entryName));
                        if (!fs.existsSync(targetThumbPath)) {
                            fs.writeFileSync(targetThumbPath, entry.getData());
                        }
                    }
                }
            }

            // 3-8. Tudo no SQLite numa única transação: falha no meio (ex.: uuid duplicado) não deixa projeto parcial (RK-084)
            this.projectService.db.exec('BEGIN TRANSACTION');
            let newProjectId;
            try {
            newProjectId = this.projectService.createProject({
                name: metadata.name ? `${metadata.name}` : 'Projeto Importado',
                description: metadata.description || '',
                status: metadata.status || 'Ativo',
                color: metadata.color || '#3b82f6',
                client: metadata.client || '',
                type: metadata.type || '',
                start_date: metadata.start_date || null,
                deadline: metadata.deadline || null,
                // Capa do pacote só vale se já estiver dentro da pasta de capas do app
                cover_path: finalCoverPath || (coversDir && typeof metadata.cover_path === 'string'
                    && !isUncPath(metadata.cover_path) && path.isAbsolute(metadata.cover_path)
                    && isInsideDir(coversDir, metadata.cover_path) ? metadata.cover_path : '')
            });

            // 4. Mapear e recriar Bins (Pastas)
            const binIdMap = new Map(); // oldBinId -> newBinId
            const folders = projectData.folders || [];
            
            // Cria pastas raiz primeiro
            const rootFolders = folders.filter(f => !f.parent_id);
            for (const rf of rootFolders) {
                const newId = this.projectService.createBin(newProjectId, null, rf.name);
                binIdMap.set(rf.id, newId);
            }
            // Cria subpastas
            const subFolders = folders.filter(f => f.parent_id);
            for (const sf of subFolders) {
                const parentNewId = binIdMap.get(sf.parent_id) || null;
                const newId = this.projectService.createBin(newProjectId, parentNewId, sf.name);
                binIdMap.set(sf.id, newId);
            }

            // 5. Mapear e recriar Mídias no SQLite
            const mediaIdMap = new Map(); // oldMediaId -> { newMediaId, newProjectMediaId }
            const mediaList = projectData.media || [];
            const db = this.projectService.db;

            for (const m of mediaList) {
                const origPath = m.original_path || m.filepath;
                const effectivePath = relinkMap[origPath] || relinkMap[m.filename] || origPath;

                // Verifica se mídia já existe no banco pelo filepath ou hash
                let existingMedia = db.prepare('SELECT id FROM media WHERE filepath = ?').get(effectivePath);
                // Mesma mídia por uuid (uuid é UNIQUE: inserir de novo abortaria a importação)
                if (!existingMedia && m.uuid) existingMedia = db.prepare('SELECT id FROM media WHERE uuid = ?').get(m.uuid);
                let mediaDbId = null;

                if (existingMedia) {
                    mediaDbId = existingMedia.id;
                } else {
                    // Insere nova mídia na tabela media
                    const insertStmt = db.prepare(`
                        INSERT INTO media (
                            uuid, filename, filepath, filesize, duration, width, height, fps,
                            video_codec, audio_codec, bitrate, thumbnail, status,
                            bdsm_camera, bdsm_profile, bdsm_lut, bdsm_metadata_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    const bdsm = m.bdsm_metadata || {};
                    const uuidVal = m.uuid || `import_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                    const res = insertStmt.run(
                        uuidVal,
                        m.filename || path.basename(effectivePath),
                        effectivePath,
                        m.filesize || 0,
                        m.duration || 0,
                        m.width || 0,
                        m.height || 0,
                        m.fps || 30.0,
                        m.video_codec || null,
                        m.audio_codec || null,
                        m.bitrate || 0,
                        m.thumbnail || null,
                        fs.existsSync(effectivePath) ? 'READY' : 'MISSING',
                        bdsm.camera || m.bdsm_camera || null,
                        bdsm.profile || m.bdsm_profile || null,
                        bdsm.lut || m.bdsm_lut || null,
                        bdsm ? JSON.stringify(bdsm) : null
                    );
                    mediaDbId = res.lastInsertRowid;
                }

                // Adiciona ao project_media
                const newBinId = m.bin_id ? binIdMap.get(m.bin_id) || null : null;
                const newPmId = this.projectService.addMediaToBin(newProjectId, newBinId, mediaDbId, m.custom_name || null);
                mediaIdMap.set(m.id || m.pm_id, { mediaId: mediaDbId, projectMediaId: newPmId });
            }

            // 6. Recriar Sequência, Tracks e Clipes
            const seqIdMap = new Map();  // oldSequenceId -> newSequenceId (marcadores, RK-084)
            const clipIdMap = new Map(); // oldClipId -> newClipId (marcadores, RK-084)
            const seqData = projectData.sequence;
            if (seqData) {
                const newSeqId = this.projectService.createSequence(
                    newProjectId,
                    seqData.name || 'Sequência Principal',
                    seqData.timebase || 29.97,
                    seqData.width || 1920,
                    seqData.height || 1080
                );

                if (seqData.id != null) seqIdMap.set(seqData.id, newSeqId);

                // Apaga tracks padrão criadas automaticamente para recriar as do projeto
                const currentTracks = this.projectService.getTracks(newSeqId);
                for (const t of currentTracks) {
                    this.projectService.deleteTrack(t.id);
                }

                // Recria Video Tracks
                const videoTracks = seqData.video_tracks || [];
                for (let i = 0; i < videoTracks.length; i++) {
                    const vt = videoTracks[i];
                    const newTrackId = this.projectService.createTrack(newSeqId, 'video', vt.track_index || (i + 1), vt.name);
                    for (const clip of (vt.clips || [])) {
                        const mapped = mediaIdMap.get(clip.media_id) || {};
                        const newClipId = this.projectService.addClip(newTrackId, {
                            project_media_id: mapped.projectMediaId || null,
                            media_id: mapped.mediaId || null,
                            name: clip.name,
                            start_time: clip.start_time,
                            end_time: clip.end_time,
                            in_point: clip.in_point,
                            out_point: clip.out_point,
                            color: clip.color
                        });
                        if (clip.id != null) clipIdMap.set(clip.id, newClipId);
                    }
                }

                // Recria Audio Tracks
                const audioTracks = seqData.audio_tracks || [];
                for (let i = 0; i < audioTracks.length; i++) {
                    const at = audioTracks[i];
                    const newTrackId = this.projectService.createTrack(newSeqId, 'audio', at.track_index || (i + 1), at.name);
                    for (const clip of (at.clips || [])) {
                        const mapped = mediaIdMap.get(clip.media_id) || {};
                        const newClipId = this.projectService.addClip(newTrackId, {
                            project_media_id: mapped.projectMediaId || null,
                            media_id: mapped.mediaId || null,
                            name: clip.name,
                            start_time: clip.start_time,
                            end_time: clip.end_time,
                            in_point: clip.in_point,
                            out_point: clip.out_point,
                            color: clip.color
                        });
                        if (clip.id != null) clipIdMap.set(clip.id, newClipId);
                    }
                }
            }

            // 7. Recriar Marcadores
            const markers = projectData.markers || [];
            for (const marker of markers) {
                this.projectService.addMarker({
                    project_id: newProjectId,
                    sequence_id: marker.sequence_id != null ? (seqIdMap.get(marker.sequence_id) || null) : null,
                    clip_id: marker.clip_id != null ? (clipIdMap.get(marker.clip_id) || null) : null,
                    time: marker.time || 0.0,
                    type: marker.type || 'highlight',
                    color: marker.color || '#f59e0b',
                    label: marker.label || '',
                    comment: marker.comment || '',
                    target: marker.target || 'timeline'
                });
            }

            // 8. Recriar Sync Groups
            const syncGroups = projectData.syncGroups || [];
            for (const sg of syncGroups) {
                const masterMapped = mediaIdMap.get(sg.master_media_id)?.mediaId || null;
                const itemsMapped = (sg.items || []).map(item => ({
                    media_id: mediaIdMap.get(item.media_id)?.mediaId || item.media_id,
                    offset_seconds: item.offset_seconds || 0.0,
                    confidence: item.confidence || 0,
                    drift_rate_ppm: item.drift_rate_ppm || 0
                }));
                this.projectService.createSyncGroup(newProjectId, sg.name, masterMapped, itemsMapped);
            }

            this.projectService.db.exec('COMMIT');
            } catch (txErr) {
                try { this.projectService.db.exec('ROLLBACK'); } catch (_) { /* já revertida */ }
                if (finalCoverPath) { try { fs.unlinkSync(finalCoverPath); } catch (_) { /* capa órfã: melhor esforço */ } }
                throw txErr;
            }

            logger.info(`[BdsproPackage] Projeto importado com sucesso. Novo ID: ${newProjectId}`);
            return {
                success: true,
                projectId: newProjectId,
                projectName: metadata.name || 'Projeto Importado'
            };
        } catch (error) {
            logger.error(`[BdsproPackage] Erro ao importar .bdspro:`, error);
            throw error;
        }
    }
}

module.exports = BdsproPackageService;

module.exports.readBdsproPackage = readBdsproPackage;
module.exports.validateProjectData = validateProjectData;
module.exports.isUncPath = isUncPath;
