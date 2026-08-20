const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const logger = require('../../services/logService');

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

            const zip = new AdmZip();

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
            if (!fs.existsSync(bdsproPath)) {
                throw new Error(`Arquivo .bdspro não encontrado em: ${bdsproPath}`);
            }

            const zip = new AdmZip(bdsproPath);
            const projectEntry = zip.getEntry('project.json');
            if (!projectEntry) {
                throw new Error('Arquivo .bdspro inválido: project.json não encontrado dentro do pacote');
            }

            const projectJsonContent = projectEntry.getData().toString('utf8');
            const projectData = JSON.parse(projectJsonContent);

            const mediaList = projectData.media || [];
            const missingFiles = [];
            const availableFiles = [];

            for (const m of mediaList) {
                const targetPath = m.original_path || m.filepath;
                const exists = targetPath && fs.existsSync(targetPath);
                
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

        const scanRecursive = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanRecursive(fullPath);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (allowedExts.has(ext)) {
                            try {
                                const stats = fs.statSync(fullPath);
                                found.push({
                                    filename: entry.name,
                                    filepath: fullPath,
                                    filesize: stats.size,
                                    extension: ext.replace('.', '').toUpperCase()
                                });
                            } catch (e) {}
                        }
                    }
                }
            } catch (err) {
                logger.warn(`[BdsproPackage] Não foi possível ler pasta: ${dir}`);
            }
        };

        if (fs.existsSync(folderPath)) {
            scanRecursive(folderPath);
        }
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
            const zip = new AdmZip(bdsproPath);
            const projectEntry = zip.getEntry('project.json');
            if (!projectEntry) {
                throw new Error('Arquivo .bdspro inválido: project.json não encontrado');
            }

            const projectData = JSON.parse(projectEntry.getData().toString('utf8'));
            const metadata = projectData.metadata || {};

            // 1. Extrair capa se existir
            let finalCoverPath = null;
            if (metadata.cover_relative_path) {
                const coverEntry = zip.getEntry(metadata.cover_relative_path);
                if (coverEntry && coversDir) {
                    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
                    const ext = path.extname(metadata.cover_relative_path) || '.jpg';
                    const newCoverName = `cover_proj_${Date.now()}${ext}`;
                    finalCoverPath = path.join(coversDir, newCoverName);
                    fs.writeFileSync(finalCoverPath, coverEntry.getData());
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

            // 3. Criar projeto no SQLite
            const newProjectId = this.projectService.createProject({
                name: metadata.name ? `${metadata.name}` : 'Projeto Importado',
                description: metadata.description || '',
                status: metadata.status || 'Ativo',
                color: metadata.color || '#3b82f6',
                client: metadata.client || '',
                type: metadata.type || '',
                start_date: metadata.start_date || null,
                deadline: metadata.deadline || null,
                cover_path: finalCoverPath || metadata.cover_path || ''
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
            const seqData = projectData.sequence;
            if (seqData) {
                const newSeqId = this.projectService.createSequence(
                    newProjectId,
                    seqData.name || 'Sequência Principal',
                    seqData.timebase || 29.97,
                    seqData.width || 1920,
                    seqData.height || 1080
                );

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
                        this.projectService.addClip(newTrackId, {
                            project_media_id: mapped.projectMediaId || null,
                            media_id: mapped.mediaId || null,
                            name: clip.name,
                            start_time: clip.start_time,
                            end_time: clip.end_time,
                            in_point: clip.in_point,
                            out_point: clip.out_point,
                            color: clip.color
                        });
                    }
                }

                // Recria Audio Tracks
                const audioTracks = seqData.audio_tracks || [];
                for (let i = 0; i < audioTracks.length; i++) {
                    const at = audioTracks[i];
                    const newTrackId = this.projectService.createTrack(newSeqId, 'audio', at.track_index || (i + 1), at.name);
                    for (const clip of (at.clips || [])) {
                        const mapped = mediaIdMap.get(clip.media_id) || {};
                        this.projectService.addClip(newTrackId, {
                            project_media_id: mapped.projectMediaId || null,
                            media_id: mapped.mediaId || null,
                            name: clip.name,
                            start_time: clip.start_time,
                            end_time: clip.end_time,
                            in_point: clip.in_point,
                            out_point: clip.out_point,
                            color: clip.color
                        });
                    }
                }
            }

            // 7. Recriar Marcadores
            const markers = projectData.markers || [];
            for (const marker of markers) {
                this.projectService.addMarker({
                    project_id: newProjectId,
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
                    offset_seconds: item.offset_seconds || 0.0
                }));
                this.projectService.createSyncGroup(newProjectId, sg.name, masterMapped, itemsMapped);
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
