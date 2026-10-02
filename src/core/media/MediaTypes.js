'use strict';

const fs = require('fs');
const path = require('path');

/** Fonte única das extensões de mídia suportadas pelo BDS (24 extensões). */
const RAW_EXTENSIONS = new Set(['.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.rw2', '.orf']);
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.flac', '.wav', '.ogg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.svg', '.heic']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

const SUPPORTED_EXTENSIONS = new Set([
    ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...RAW_EXTENSIONS,
]);

// Extensões de áudio extras só reconhecidas para decidir "não gerar miniatura" (não são importáveis).
const AUDIO_LIKE_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, '.aac']);

const extOf = (p) => path.extname(String(p || '')).toLowerCase();

const isSupported = (p) => SUPPORTED_EXTENSIONS.has(extOf(p));
const isRaw = (p) => RAW_EXTENSIONS.has(extOf(p));
const isAudio = (p) => AUDIO_LIKE_EXTENSIONS.has(extOf(p));
const isImage = (p) => IMAGE_EXTENSIONS.has(extOf(p));
const isJpeg = (p) => JPEG_EXTENSIONS.has(extOf(p));
const isVideo = (p) => VIDEO_EXTENSIONS.has(extOf(p));

/** @returns {'raw'|'audio'|'image'|'video'|'unknown'} */
function mediaTypeOf(p) {
    if (isRaw(p)) return 'raw';
    if (isAudio(p)) return 'audio';
    if (isImage(p)) return 'image';
    if (isVideo(p)) return 'video';
    return 'unknown';
}

/**
 * Procura o JPG/JPEG "irmão" (mesmo nome base) de um arquivo, em qualquer caixa.
 * Lê o diretório UMA vez. Retorna o caminho completo ou null.
 */
function findSiblingJpg(filePath) {
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name.toLowerCase();
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    // Prefere .jpg a .jpeg
    let jpeg = null;
    for (const n of names) {
        const parsed = path.parse(n);
        if (parsed.name.toLowerCase() !== base) continue;
        const e = parsed.ext.toLowerCase();
        if (e === '.jpg') return path.join(dir, n);
        if (e === '.jpeg' && !jpeg) jpeg = path.join(dir, n);
    }
    return jpeg;
}

/** Procura o RAW irmão (mesmo nome base) de um JPG. Retorna caminho ou null. Lê o diretório uma vez. */
function findSiblingRaw(filePath) {
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name.toLowerCase();
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    for (const n of names) {
        const parsed = path.parse(n);
        if (parsed.name.toLowerCase() === base && RAW_EXTENSIONS.has(parsed.ext.toLowerCase())) {
            return path.join(dir, n);
        }
    }
    return null;
}

module.exports = {
    SUPPORTED_EXTENSIONS, RAW_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS,
    isSupported, isRaw, isAudio, isImage, isJpeg, isVideo, mediaTypeOf, findSiblingJpg, findSiblingRaw,
};
