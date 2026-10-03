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

// Fotos "de biblioteca": é o que a Biblioteca sempre considerou foto (além dos RAW, que têm tipo próprio).
const PHOTO_LIBRARY_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic'];

/**
 * Tipo gravado em media.media_type: 'video' | 'audio' | 'photo' | 'raw' | null (extensão fora dessas listas).
 * RAW tem tipo próprio ('raw'); as consultas contam RAW também como foto (media_type IN ('photo','raw')).
 */
function libraryTypeOf(p) {
    const e = extOf(p);
    if (RAW_EXTENSIONS.has(e)) return 'raw';
    if (VIDEO_EXTENSIONS.has(e)) return 'video';
    if (AUDIO_EXTENSIONS.has(e)) return 'audio';
    if (PHOTO_LIBRARY_EXTENSIONS.includes(e)) return 'photo';
    return null;
}

/** Expressão SQL equivalente a libraryTypeOf(), para backfill/triggers (col = coluna ou NEW.filename). */
function mediaTypeCaseSql(col) {
    const like = (set) => '(' + [...set].map((e) => `${col} LIKE '%${e}'`).join(' OR ') + ')';
    return `CASE WHEN ${like(RAW_EXTENSIONS)} THEN 'raw' WHEN ${like(VIDEO_EXTENSIONS)} THEN 'video' `
        + `WHEN ${like(AUDIO_EXTENSIONS)} THEN 'audio' WHEN ${like(PHOTO_LIBRARY_EXTENSIONS)} THEN 'photo' ELSE NULL END`;
}

// Cache de listagem por diretório: em importações em lote evita um readdirSync por arquivo.
const DIR_CACHE_TTL_MS = 8000;
const DIR_CACHE_MAX = 200;
const dirCache = new Map(); // dir -> { at, names }

/** Descarta a listagem em cache de um diretório (ou todas, sem argumento). */
function invalidateDirCache(dir) {
    if (dir === undefined) dirCache.clear();
    else dirCache.delete(dir);
}

function listDirCached(dir) {
    const now = Date.now();
    const hit = dirCache.get(dir);
    if (hit && now - hit.at < DIR_CACHE_TTL_MS) return hit.names;
    const names = fs.readdirSync(dir); // lança se o diretório não existe: o chamador trata
    if (dirCache.size >= DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value);
    dirCache.set(dir, { at: now, names });
    return names;
}

/**
 * Procura o JPG/JPEG "irmão" (mesmo nome base) de um arquivo, em qualquer caixa.
 * Usa a listagem do diretório em cache (TTL curto). Retorna o caminho completo ou null.
 */
function findSiblingJpg(filePath) {
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name.toLowerCase();
    let names;
    try { names = listDirCached(dir); } catch (_) { return null; }
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

/** Procura o RAW irmão (mesmo nome base) de um JPG. Retorna caminho ou null. Usa listagem em cache. */
function findSiblingRaw(filePath) {
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name.toLowerCase();
    let names;
    try { names = listDirCached(dir); } catch (_) { return null; }
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
    invalidateDirCache, libraryTypeOf, mediaTypeCaseSql, PHOTO_LIBRARY_EXTENSIONS, JPEG_EXTENSIONS,
};
