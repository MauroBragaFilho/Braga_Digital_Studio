'use strict';

/**
 * BdsmProtocol — Contrato REAL do servidor do celular (BDS Mobile, Ktor).
 *
 * Fonte da verdade: core-network/.../LinkModule.kt, auth/LinkAuthManager.kt, sharing/MediaLibraryService.kt
 * e sharing/LutLibraryService.kt do app móvel (a documentação do app diverge em pontos secundários).
 * Resumo em .docs/BDSM_PROTOCOLO_E_CONEXAO.md.
 *
 *  - Tudo sob /api exige `Authorization: Bearer <token>`, exceto /api/pair/* e /api/discovery/info.
 *  - /api/discovery/info sem token devolve só { deviceName, deviceModel, appVersion, authRequired: true };
 *    com token válido devolve também bateria e armazenamento.
 *  - Não existe download de LUT: só listar, enviar (multipart) e apagar.
 */
const BdsmProtocol = {
  DEFAULT_PORT: 8080,
  SERVICE_TYPE: 'bdsm', // mDNS: _bdsm._tcp (o celular não publica registros TXT)

  /** Duração de um pedido de pareamento (o servidor devolve expiresInSec = 90). */
  PAIR_TTL_SEC: 90,

  // Endpoints REST (relativos a /api)
  ENDPOINTS: {
    DISCOVERY_INFO: '/discovery/info',
    PAIR_REQUEST: '/pair/request',
    PAIR_STATUS: (requestId) => `/pair/status/${encodeURIComponent(requestId)}`,
    MEDIA_LIST: '/media',
    MEDIA_DOWNLOAD: (id) => `/media/${encodeURIComponent(id)}/download`,
    MEDIA_THUMBNAIL: (id) => `/media/${encodeURIComponent(id)}/thumbnail`,
    MEDIA_DELETE: (id) => `/media/${encodeURIComponent(id)}`,
    LUTS_LIST: '/luts',
    LUTS_UPLOAD: '/luts/upload',
    // O caminho relativo vai em SEGMENTOS separados (rota Ktor "/luts/{path...}"): cada um codificado, unidos por "/".
    LUTS_DELETE: (relativePath) => `/luts/${String(relativePath).split('/').map(encodeURIComponent).join('/')}`
  },

  /** Códigos de erro estáveis (BdsmError.code) e o texto mostrado ao usuário. */
  ERRORS: {
    PAIRING_REQUIRED: 'O celular pede pareamento. Confirme o código no aparelho para continuar.',
    DEVICE_UNREACHABLE: 'Sem conexão com o celular. Confira o cabo ou o Wi-Fi e se o BDS Mobile está aberto.',
    DEVICE_BUSY: 'O celular ainda tem um pedido de pareamento aberto. Aguarde alguns segundos e tente de novo.',
    PAIRING_DENIED: 'O pareamento foi recusado no celular.',
    PAIRING_EXPIRED: 'O tempo para aprovar no celular acabou.',
    FORBIDDEN: 'O celular não deu permissão para esta ação.',
    NOT_FOUND: 'O celular não encontrou este item. Atualize a lista e tente de novo.',
    CONFLICT: 'Já existe no celular um arquivo com o mesmo nome e conteúdo diferente.',
    TOO_LARGE: 'O arquivo é grande demais para o celular aceitar.',
    BAD_REQUEST: 'O celular recusou o pedido (dados inválidos).',
    DEVICE_ERROR: 'O celular não conseguiu concluir a operação. Tente de novo.'
  },

  /** Cabeçalhos de toda requisição (não existe mecanismo X-BDSM-*: a identificação é o token de pareamento). */
  buildHeaders(customHeaders = {}) {
    return { Accept: 'application/json', ...customHeaders };
  },

  /** Valida se a resposta de descoberta atende ao contrato (nome ou modelo do aparelho). */
  validateDiscoveryInfo(info) {
    if (!info || typeof info !== 'object') return false;
    return !!(info.deviceName || info.deviceModel);
  },

  /**
   * Chave estável do aparelho, igual por USB e Wi-Fi: "deviceName|deviceModel".
   * O servidor não publica um identificador único; nome + modelo é o que existe nas duas formas de resposta.
   */
  deviceKey(info) {
    if (!info || typeof info !== 'object') return '';
    const name = String(info.deviceName || '').trim();
    const model = String(info.deviceModel || '').trim();
    return name || model ? `${name}|${model}` : '';
  },

  /** A resposta de /discovery/info veio completa (token aceito)? A versão mínima não tem bateria nem armazenamento. */
  isFullInfo(info) {
    return !!info && typeof info === 'object' && info.batteryLevel !== undefined && info.authRequired !== true;
  },

  /**
   * Item de /api/media (MediaItemDto: id, filename, filesize, duration em SEGUNDOS, width, height, fps, codec,
   * createdAt ISO) no formato usado pelo app: { id, name, size, duration, ... }.
   */
  normalizeMediaItem(m) {
    if (!m || typeof m !== 'object' || m.id == null) return null;
    const name = m.filename || m.name;
    if (!name) return null;
    const size = Number(m.filesize ?? m.size);
    const duration = Number(m.duration);
    return {
      id: String(m.id),
      name: String(name),
      size: Number.isFinite(size) && size > 0 ? size : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      fps: Number(m.fps) || 0,
      codec: typeof m.codec === 'string' ? m.codec : '',
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : ''
    };
  }
};

module.exports = BdsmProtocol;
