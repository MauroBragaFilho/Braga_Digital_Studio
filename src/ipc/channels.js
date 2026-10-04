'use strict';

/**
 * channels.js — TABELA ÚNICA de canais IPC (fonte da verdade).
 *
 * Cada canal `ipcMain.handle` do app tem uma entrada aqui, com:
 *   domain   agrupamento (arquivo src/ipc/<domínio>Handlers.js)
 *   args     esquema dos argumentos (ver schema.js) — o registrador (channelRegistry.js) valida ANTES do handler
 *   returns  resumo do retorno (documentação)
 *   error    estratégia de erro do domínio para falhas de remetente/argumentos:
 *              'throw'   rejeita a promessa (padrão da maioria dos domínios)
 *              'wrap'    { ok:false, error, code }  (ai:*, modules:*; sucesso vira { ok:true, data })
 *              'success' { success:false, error }
 *              'null' / 'empty'  devolve null / [] (canais de leitura tolerantes)
 *   api      como o preload expõe o canal em `window.bds` (nome com ponto = namespace). Uma string usa os
 *            nomes dos argumentos; { name, params, call } personaliza a assinatura e a chamada.
 *            Sem `api` = canal interno/legado, sem exposição no preload.
 *
 * `EVENTS` lista os eventos main → renderer que o preload assina (`window.bds.onXxx`).
 * O preload.js é GERADO desta tabela por scripts/generate-preload.js (npm run generate:preload).
 */

const { t } = require('./schema');

const ID = (name, o) => t.id({ name, ...o });
const STR = (name, max, o) => t.string({ name, max, ...o });
const OBJ = (name, shape, o) => t.object(shape || {}, { name, ...o });
const ABS = (name, label) => t.absPath({ name, label });
const PATHS = (name, max = 5000, o) => t.array(t.string({ max: 4096 }), { name, max, ...o });
const FLEX_ID = (name, o) => t.oneOf([t.string({ max: 200 }), t.number()], { name, ...o });

// Segmentos de pasta/itens de dispositivos (MTP/USB): lista de nomes curtos.
const SEGMENTS = (name) => t.array(t.string({ max: 512 }), { name, max: 64, optional: true });
const ITEM_NAMES = (name) => t.array(t.string({ max: 512 }), { name, max: 5000 });

const CHANNELS = {};

function define(domain, error, entries) {
  for (const [channel, def] of Object.entries(entries)) {
    if (CHANNELS[channel]) throw new Error(`Canal duplicado na tabela: ${channel}`);
    CHANNELS[channel] = {
      domain,
      error: def.error || error,
      args: def.args || [],
      returns: def.returns || 'void',
      api: def.api || []
    };
  }
}

// --- Configurações, app e atualizações ---------------------------------------------------------
define('settings', 'throw', {
  'settings:get': { returns: 'Configurações do usuário (segredos mascarados)', api: ['getSettings'] },
  'settings:getDefaultFolders': { returns: 'Pastas padrão de áudio, vídeo e Conversor', api: ['getDefaultFolders'] },
  'settings:save': {
    args: [OBJ('settings', {}, { label: 'Configurações', maxKeys: 1000 })],
    returns: 'Configurações salvas (segredos mascarados)',
    api: ['saveSettings']
  },
  'system:getConverterOutputDir': { returns: 'Pasta padrão do Conversor (criada se faltar)', api: ['getDefaultOutputDir'] }
});

define('app', 'throw', {
  'app:getVersion': { returns: 'string da versão', api: ['getVersion'] },
  'app:checkForUpdate': { returns: 'Resultado da checagem de atualização do app', api: ['checkForAppUpdate'] }
});

define('updates', 'throw', {
  'updates:checkSystem': { returns: 'Estado das dependências', api: ['checkUpdates'] },
  'updates:check': { returns: 'Legado: igual a updates:checkSystem' },
  'updates:checkLegacy': { returns: 'Legado: updateService.checkAll()' },
  'updates:updateTool': {
    args: [STR('tool', 100, { nonBlank: true, label: 'Ferramenta' }), OBJ('opts', { allowUnverified: t.boolean({ optional: true }) }, { optional: true, label: 'Opções' })],
    returns: 'Resultado da atualização do componente',
    api: ['updateTool']
  },
  'updates:rollbackTool': {
    args: [STR('tool', 100, { nonBlank: true, label: 'Ferramenta' })],
    returns: 'Resultado da reversão do componente',
    api: ['rollbackTool']
  },
  'updates:updateAll': { returns: 'Resultado da atualização das dependências', api: ['installUpdates', 'updateAllDependencies'] },
  'updates:checkAll': { returns: 'Estado de app + dependências', api: ['checkEverything'] },
  'updates:updateEverything': { returns: 'Resultado da atualização completa', api: ['updateEverything'] },
  'updates:downloadAppUpdate': { returns: 'Resultado do download (verificado) do instalador', api: ['downloadAppUpdate'] },
  'updates:installAppUpdate': {
    // O serviço ignora o caminho do renderer: só instala o instalador baixado e verificado.
    args: [STR('installerPath', 4096, { optional: true, label: 'Instalador' })],
    returns: '{ success, exitCode, error? }',
    api: ['installAppUpdate']
  },
  'updates:relaunchApp': { returns: 'void (reinicia o app)', api: ['relaunchApp'] }
});

define('telemetry', 'throw', {
  'telemetry:reportError': {
    args: [
      t.any('ErrorReporter aceita e normaliza qualquer valor (Error, texto ou objeto) e redige dados sensíveis', { name: 'error' }),
      t.any('contexto livre (texto/objeto) que o ErrorReporter normaliza e limita', { name: 'context' })
    ],
    returns: 'Relatório gravado ou null',
    api: ['reportError']
  },
  'telemetry:getDeveloperEmail': { returns: 'string', api: ['getDeveloperEmail'] },
  'telemetry:getCrashReports': { returns: 'Relatórios locais', api: ['getCrashReports'] },
  'telemetry:clearCrashReports': { returns: 'Quantidade apagada', api: ['clearCrashReports'] },
  'telemetry:sendReports': { returns: 'Resultado do envio dos relatórios', api: ['sendCrashReports'] },
  'telemetry:getMailtoLink': {
    args: [
      t.any('ErrorReporter aceita e normaliza qualquer valor (Error, texto ou objeto)', { name: 'error' }),
      t.any('contexto livre (texto/objeto) que o ErrorReporter normaliza e limita', { name: 'context' })
    ],
    returns: 'URL mailto: ou null',
    api: [{ name: 'getMailtoErrorLink' }]
  },
  'telemetry:generateManualMailto': {
    args: [STR('description', 20000, { optional: true, label: 'Descrição' })],
    returns: 'URL mailto:',
    api: ['generateManualMailto']
  }
});

// --- Janela e diálogos -------------------------------------------------------------------------
define('window', 'throw', {
  'window:minimize': { api: ['minimizeWindow'] },
  'window:maximize': { api: ['maximizeWindow'] },
  'window:fullscreen': {
    args: [STR('mode', 10, { enum: ['exit'], optional: true, label: 'Modo' })],
    api: [{ name: 'fullscreenWindow', params: 'mode', call: "mode === 'exit' ? 'exit' : undefined" }]
  },
  'window:close': { api: ['closeWindow'] }
});

define('dialog', 'throw', {
  'dialog:selectFolder': {
    args: [STR('fallbackPath', 4096, { optional: true, label: 'Pasta inicial' })],
    returns: 'Caminho escolhido ou null',
    api: ['selectFolder']
  },
  'dialog:selectFiles': {
    args: [OBJ('options', {}, { optional: true, label: 'Opções do diálogo' })],
    returns: 'Lista de caminhos ([] se cancelou)',
    api: [{ name: 'selectFiles', params: '', call: '' }, 'selectFile']
  }
});

// --- Ferramentas de mídia em fila --------------------------------------------------------------
define('montage', 'throw', {
  'montage:probe': { args: [ABS('filePath', 'Arquivo de mídia')], returns: 'Informações do arquivo', api: ['probeMontageFile'] },
  'montage:enqueue': { args: [OBJ('config', {}, { label: 'Configuração da montagem', maxKeys: 100 })], returns: '{ ok, jobId... }', api: ['enqueueMontage'] },
  'montage:cancelJob': { args: [t.oneOf([t.string({ max: 1000 }), t.number()], { name: 'id', label: 'Tarefa' })], returns: 'Resultado do cancelamento', api: ['cancelMontageJob'] },
  'montage:removeJob': { args: [t.oneOf([t.string({ max: 1000 }), t.number()], { name: 'id', label: 'Tarefa' })], returns: 'Resultado da remoção', api: ['removeMontageJob'] },
  'montage:clearQueue': { returns: 'Resultado', api: ['clearMontageQueue'] },
  'montage:getQueue': { returns: 'Fila de montagens', api: ['getMontageQueue'] }
});

define('silence', 'throw', {
  'silence:probe': { args: [ABS('filePath', 'Arquivo de mídia')], returns: 'Informações do arquivo', api: ['probeSilenceFile'] },
  'silence:analyze': {
    args: [OBJ('config', { filePath: t.absPath({ label: 'Arquivo de mídia' }) }, { label: 'Configuração da análise' })],
    returns: 'Trechos de silêncio',
    api: ['analyzeSilence']
  },
  'silence:process': { args: [OBJ('config', {}, { label: 'Configuração do processamento', maxKeys: 100 })], returns: 'Resultado do processamento', api: ['processSilence'] },
  'silence:cancel': { returns: 'Resultado', api: ['cancelSilence'] }
});

define('metadata', 'throw', {
  'metadata:probe': { args: [ABS('filePath', 'Arquivo de mídia')], returns: 'Metadados do arquivo', api: ['probeMetadataFile'] },
  'metadata:extractThumb': { args: [ABS('filePath', 'Arquivo de mídia')], returns: 'Caminho da miniatura ou null', api: ['extractMetadataThumb'] },
  'metadata:save': { args: [OBJ('config', {}, { label: 'Configuração dos metadados', maxKeys: 100 })], returns: 'Resultado da gravação', api: ['saveMetadata'] },
  'metadata:cancel': { returns: 'Resultado', api: ['cancelMetadata'] }
});

define('converter', 'throw', {
  'converter:addFiles': {
    args: [t.array(t.oneOf([t.absPath(), t.object({ path: t.absPath({ label: 'Arquivo' }) })]), { name: 'files', max: 5000, label: 'Arquivos' })],
    returns: '{ ok, count, items }',
    api: ['converterAddFiles']
  },
  'converter:start': { args: [OBJ('config', {}, { optional: true, label: 'Configuração da conversão', maxKeys: 100 })], returns: 'Resultado da conversão', api: ['converterStart'] },
  'converter:cancel': { returns: 'Resultado', api: ['converterCancel'] },
  'converter:clearQueue': { returns: 'Resultado', api: ['converterClearQueue'] },
  'converter:removeFile': { args: [t.oneOf([t.int(), t.string({ max: 64 })], { name: 'index', label: 'Item' })], returns: 'Resultado', api: ['converterRemoveFile'] },
  'converter:listQueue': { returns: 'Legado: fila do conversor' }
});

// --- Downloads e YouTube -----------------------------------------------------------------------
define('downloads', 'throw', {
  'media:metadata': { args: [STR('url', 2048, { nonBlank: true, label: 'URL' })], returns: 'Metadados do vídeo', api: ['getMetadata'] },
  'media:inspectPlaylist': { args: [STR('url', 2048, { nonBlank: true, label: 'URL' })], returns: 'Resumo da playlist', api: ['inspectPlaylist'] },
  'media:expandPlaylist': { args: [STR('url', 2048, { nonBlank: true, label: 'URL' })], returns: 'Itens da playlist', api: ['expandPlaylist'] },
  'download:start': { args: [OBJ('request', {}, { label: 'Pedido de download', maxKeys: 50 })], returns: 'Legado: inicia download direto' },
  'downloads:add': { args: [OBJ('request', {}, { label: 'Pedido de download', maxKeys: 50 })], returns: 'Item adicionado à fila', api: ['downloads.add'] },
  'downloads:start': { returns: 'Resultado', api: ['downloads.start'] },
  'downloads:pause': { returns: 'Resultado', api: ['downloads.pause'] },
  'downloads:cancel': { args: [FLEX_ID('id', { label: 'ID do download' })], returns: '{ ok }', api: ['downloads.cancel'] },
  'downloads:retry': { args: [FLEX_ID('id', { label: 'ID do download' })], returns: '{ ok }', api: ['downloads.retry'] },
  'downloads:remove': {
    args: [FLEX_ID('id', { label: 'ID do download' })],
    returns: '{ ok }',
    api: ['downloads.remove', { name: 'downloadRemoveJob', params: 'id', call: 'id' }]
  },
  'downloads:reorder': {
    args: [FLEX_ID('id', { label: 'ID do download' }), STR('direction', 8, { enum: ['up', 'down'], label: 'Direção' })],
    returns: '{ ok }',
    api: ['downloads.reorder']
  },
  'downloads:clearCompleted': { returns: '{ ok }', api: ['downloads.clearCompleted', { name: 'downloadClearQueue', params: '', call: '' }] },
  'downloads:clearAll': { returns: '{ ok }', api: ['downloads.clearAll'] },
  'downloads:toggleFormat': {
    args: [FLEX_ID('id', { label: 'ID do download' }), STR('format', 20, { optional: true, label: 'Formato' })],
    returns: '{ ok }',
    api: ['downloads.toggleFormat']
  },
  'downloads:updateQuality': {
    args: [FLEX_ID('id', { label: 'ID do download' }), STR('quality', 40, { label: 'Qualidade' })],
    returns: '{ ok }',
    api: ['downloads.updateQuality']
  },
  'downloads:getQueue': { returns: 'Fila de downloads', api: ['downloads.getQueue', { name: 'downloadGetQueue', params: '', call: '' }] },
  'downloads:skipWait': { returns: 'Resultado', api: ['downloads.skipWait'] },
  'downloads:waitState': { returns: 'Estado da espera entre downloads', api: ['downloads.getWaitState'] },
  'downloads:cookiesStatus': { returns: 'Estado dos cookies', api: ['downloads.cookiesStatus'] },
  'download:cancel': { returns: 'Legado: pausa a fila' },
  'download:getQueue': { returns: 'Legado: fila de downloads' },
  'download:clearQueue': { returns: 'Legado: limpa concluídos' },
  'download:removeJob': { args: [FLEX_ID('id', { label: 'ID do download' })], returns: 'Legado: remove da fila' }
});

define('youtube', 'throw', {
  'youtube:get-accounts': { returns: '[] (contas YouTube)', api: ['getYoutubeAccounts'] },
  'youtube:exportCookies': { error: 'success', returns: '{ success, path? , error? }', api: ['exportYoutubeCookies'] },
  'youtube:login': { returns: 'true ao fechar a janela de login', api: ['youtubeLogin'] }
});

define('history', 'throw', {
  'history:list': { returns: 'Histórico de downloads', api: ['listHistory'] },
  'history:clear': { returns: 'Resultado', api: ['clearHistory'] },
  'conversions:list': { returns: 'Histórico de conversões', api: ['listConversions'] },
  'conversions:clear': { returns: 'Resultado', api: ['clearConversions'] }
});

// --- Dispositivos ------------------------------------------------------------------------------
define('devices', 'throw', {
  'devices:get-all': {
    args: [t.any('sinalizador truthy ("forçar nova varredura"); o handler converte com !!force', { name: 'force', optional: true })],
    returns: 'Lista unificada MTP/USB/BDSM/Sony',
    api: [{ name: 'getAllDevices', params: 'force = false', call: 'force' }]
  },
  'usb:list-folder': { args: [ABS('basePath', 'Dispositivo USB'), SEGMENTS('pathArray')], returns: 'Itens da pasta', api: ['listUsbFolder'] },
  'usb:import-items': {
    args: [ABS('basePath', 'Dispositivo USB'), SEGMENTS('pathArray'), ITEM_NAMES('itemNames'), ABS('destFolder', 'Pasta de destino')],
    returns: 'Resultado da importação',
    api: ['importUsbItems']
  },
  'mtp:list-folder': { args: [STR('deviceName', 512, { nonBlank: true, label: 'Dispositivo' }), SEGMENTS('pathArray')], returns: 'Itens da pasta', api: ['listMtpFolder'] },
  'mtp:import-items': {
    args: [STR('deviceName', 512, { nonBlank: true, label: 'Dispositivo' }), SEGMENTS('pathArray'), ITEM_NAMES('itemNames'), ABS('destFolder', 'Pasta de destino')],
    returns: 'Resultado da importação',
    api: ['importMtpItems']
  }
});

define('sony', 'throw', {
  'sony:list': { args: [STR('cameraId', 200, { label: 'Câmera' }), OBJ('options', {}, { optional: true, label: 'Opções' })], returns: 'Itens da câmera', api: ['sonyList'] },
  'sony:browse': { args: [STR('cameraId', 200, { label: 'Câmera' }), STR('uri', 2048, { optional: true, label: 'Endereço' })], returns: 'Itens da pasta', api: ['sonyBrowse'] },
  'sony:get-status': { args: [STR('cameraId', 200, { label: 'Câmera' })], returns: 'Estado da câmera ou null', api: ['sonyGetStatus'] },
  'sony:import-items': {
    args: [OBJ('payload', { cameraId: t.string({ max: 200, label: 'Câmera' }), items: t.array(t.any('itens da câmera têm formato do provedor; o handler valida cada um'), { max: 5000, optional: true }), destFolder: t.string({ max: 4096, optional: true }) }, { label: 'Importação' })],
    returns: '{ imported, failed }',
    api: [{ name: 'sonyImportItems', params: 'cameraId, items, destFolder', call: '{ cameraId, items, destFolder }' }]
  }
});

const BDSM_IP = STR('ip', 64, { label: 'IP' });
const BDSM_PORT = t.oneOf([t.int({ min: 0 }), t.string({ max: 8 })], { name: 'port', optional: true, label: 'Porta' });

define('bdsm', 'throw', {
  'bdsm:getMedia': { args: [STR('ip', 64, { label: 'IP' }), t.oneOf([t.int({ min: 0 }), t.string({ max: 8 })], { name: 'port', optional: true, label: 'Porta' })], returns: 'Mídias do dispositivo', api: ['getBdsmMedia'] },
  'bdsm:getImportHistory': { args: [t.oneOf([t.string({ max: 200 }), t.number()], { name: 'deviceId', label: 'Dispositivo' })], returns: 'Nomes já importados', api: ['getBdsmImportHistory'] },
  'bdsm:importMedia': {
    args: [OBJ('data', {
      ip: t.string({ max: 64, label: 'IP' }),
      port: t.oneOf([t.int({ min: 0 }), t.string({ max: 8 })], { optional: true }),
      deviceId: t.oneOf([t.string({ max: 200 }), t.number()], { label: 'Dispositivo' }),
      items: t.array(t.any('itens do dispositivo BDSM têm formato do servidor; o handler valida cada um'), { max: 5000, optional: true }),
      destFolder: t.string({ max: 4096, label: 'Diretório de destino' }),
      projectId: t.oneOf([t.id(), t.string({ max: 100 })], { optional: true })
    }, { label: 'Importação' })],
    returns: 'Quantidade importada',
    api: ['importBdsmMedia']
  },
  'bdsm:analyzeLutSync': { args: [STR('ip', 64, { label: 'IP' }), t.oneOf([t.int({ min: 0 }), t.string({ max: 8 })], { name: 'port', optional: true, label: 'Porta' })], returns: 'Plano de sincronização de LUTs', api: ['analyzeBdsmLutSync'] },
  'bdsm:executeLutSync': {
    args: [OBJ('data', {
      ip: t.string({ max: 64, label: 'IP' }),
      port: t.oneOf([t.int({ min: 0 }), t.string({ max: 8 })], { optional: true }),
      plan: t.object({}, { label: 'Plano de sincronização', maxKeys: 50 })
    }, { label: 'Sincronização' })],
    returns: '{ completed, failed, skipped, total }',
    api: ['executeBdsmLutSync']
  },
  // Pareamento com o celular (o token fica só no processo principal)
  'bdsm:pairingStatus': { args: [BDSM_IP, BDSM_PORT], returns: '{ deviceName, deviceModel, paired, authRequired, tokenRejected }', api: ['getBdsmPairingStatus'] },
  'bdsm:pairStart': { args: [BDSM_IP, BDSM_PORT], returns: '{ state, code?, secondsLeft?, alreadyPaired? } (andamento no evento bdsm:pairing)', api: ['startBdsmPairing'] },
  'bdsm:pairCancel': { args: [BDSM_IP, BDSM_PORT], returns: 'true se havia pedido em andamento', api: ['cancelBdsmPairing'] },
  'bdsm:pairForget': { args: [BDSM_IP, BDSM_PORT], returns: 'true', api: ['forgetBdsmPairing'] },
  'bdsm:getThumbnail': { args: [BDSM_IP, BDSM_PORT, STR('id', 128, { nonBlank: true, label: 'Mídia' })], returns: 'Miniatura como data URL', api: ['getBdsmThumbnail'] }
});

// --- Recuperação e logs ------------------------------------------------------------------------
const RECOVERY_INPUT = (label) => OBJ('payload', {
  corruptPath: t.absPath({ label: 'Arquivo corrompido' }),
  referencePath: t.string({ max: 4096, optional: true, allowEmpty: true, label: 'Arquivo de referência' }),
  outputDir: t.string({ max: 4096, optional: true, allowEmpty: true, label: 'Pasta de saída' }),
  preferredLevel: t.string({ max: 100, optional: true, label: 'Nível de recuperação' })
}, { label });

define('recovery', 'throw', {
  'recovery:diagnose': {
    args: [RECOVERY_INPUT('Parâmetros do diagnóstico')],
    returns: 'Diagnóstico do vídeo',
    api: [{ name: 'recovery.diagnose', params: 'corruptPath, referencePath', call: '{ corruptPath, referencePath }' }]
  },
  'recovery:start': { args: [RECOVERY_INPUT('Opções de recuperação')], returns: 'Resultado da recuperação', api: [{ name: 'recovery.start', params: 'options' }] },
  'recovery:cancel': { returns: '{ success }', api: ['recovery.cancel'] },
  'recovery:raw:diagnose': {
    args: [RECOVERY_INPUT('Parâmetros do diagnóstico')],
    returns: 'Diagnóstico do RAW',
    api: [{ name: 'recovery.raw.diagnose', params: 'corruptPath, referencePath', call: '{ corruptPath, referencePath }' }]
  },
  'recovery:raw:start': { args: [RECOVERY_INPUT('Opções de recuperação')], returns: 'Resultado da recuperação', api: [{ name: 'recovery.raw.start', params: 'options' }] },
  'recovery:raw:cancel': { returns: '{ success }', api: ['recovery.raw.cancel'] },
  'logs:export': { error: 'success', returns: '{ success, exportPath?, copied?, failed?, cancelled?, error? }', api: ['exportDiagnosticLogs'] }
});

// --- LUTs --------------------------------------------------------------------------------------
define('luts', 'throw', {
  'luts:get': { returns: 'Lista de LUTs', api: ['getLuts'] },
  'luts:import': {
    args: [t.array(t.any('lista de caminhos soltos no app; o LutManager valida cada item e conta os inválidos'), { name: 'paths', max: 5000, optional: true, label: 'Arquivos' })],
    returns: 'false (cancelou) ou { imported, renamed, duplicates, invalid }',
    api: ['importLut']
  },
  'luts:reveal': { args: [t.cube({ name: 'filePath' })], returns: 'true', api: ['revealLut'] },
  'luts:getReferenceImage': { error: 'null', args: [STR('filePath', 4096, { optional: true })], returns: 'Data URL da imagem ou null', api: ['getLutReferenceImage'] },
  'luts:delete': { args: [ABS('filePath', 'LUT')], returns: 'Resultado da exclusão (Lixeira)', api: ['deleteLut'] },
  'luts:rename': { args: [ABS('oldPath', 'LUT'), STR('newName', 255, { nonBlank: true, label: 'Novo nome' })], returns: 'Resultado da renomeação', api: ['renameLut'] },
  'luts:parse': { args: [t.cube({ name: 'filePath' })], returns: 'LUT interpretada', api: ['parseLutCube'] },
  'luts:getHeader': { args: [t.cube({ name: 'filePath' })], returns: 'Cabeçalho do .cube', api: ['getLutHeader'] },
  'luts:load': { args: [t.cube({ name: 'filePath' })], returns: '{ rawContent, truncated, totalBytes }', api: ['getLutRaw'] }
});

// --- IA e módulos opcionais (padrão { ok, data }) ----------------------------------------------
define('ai', 'wrap', {
  // Provedores de IA: a configuração tem uma LISTA de provedores (cada um com a sua chave, nunca devolvida: só hasKey), a ordem de prioridade e o interruptor de fallback.
  // ai:saveConfig aceita alterações por provedor (addProvider, removeProvider, provider {id,...}, order) e o atalho antigo de um servidor só (baseUrl, model, apiKey...).
  'ai:getConfig': { returns: 'Configuração pública da IA (provedores sem chave)', api: ['aiGetConfig'] },
  'ai:saveConfig': { args: [OBJ('patch', {}, { optional: true, label: 'Configuração', maxKeys: 100 })], returns: 'Configuração pública', api: ['aiSaveConfig'] },
  'ai:testConnection': { args: [STR('providerId', 100, { optional: true, label: 'Provedor' })], returns: 'Resultado do teste (do provedor indicado ou do principal)', api: ['aiTestConnection'] },
  'ai:listModels': { args: [STR('providerId', 100, { optional: true, label: 'Provedor' })], returns: 'Modelos disponíveis (do provedor indicado ou do principal)', api: ['aiListModels'] },
  // Assistente flutuante: a resposta chega por eventos (ai:chatDelta / ai:chatDone / ai:chatError, mais ai:chatStatus: linha de status das ferramentas, e ai:navigate: abrir uma tela). Não há canal para executar ferramentas nem confirmar: isso é só do main. TRAVADOS no main
  // (AI_DISABLED com o build não liberado, o módulo ou o interruptor desligados; AI_NOT_CONFIGURED sem servidor; AI_REMOTE_CONSENT sem o aviso de privacidade aceito). O histórico mora no main.
  // `context` (opcional) = contexto da tela { screen, selectedIds (até 50 ids numéricos), projectId }: o main revalida
  // tudo (src/services/ai/context.js) e só o usa como dado não confiável no prompt.
  'ai:chatStart': {
    args: [OBJ('payload', {
      text: t.string({ min: 1, max: 20000, label: 'Mensagem' }),
      context: t.object({
        screen: t.string({ max: 30, label: 'Tela' }),
        selectedIds: t.array(t.int({ min: 1, max: 2147483647 }), { max: 50, optional: true, label: 'Seleção' }),
        projectId: t.int({ min: 1, max: 2147483647, optional: true, label: 'Projeto' })
      }, { optional: true, strict: true, maxKeys: 3, label: 'Contexto da tela' })
    }, { label: 'Conversa' })],
    returns: 'Id da resposta em andamento',
    api: [{ name: 'aiChatStart', params: 'text, context', call: '{ text, context }' }]
  },
  'ai:chatCancel': { args: [STR('id', 100, { optional: true, label: 'Id da resposta' })], returns: 'true se havia resposta para cancelar', api: ['aiChatCancel'] },
  'ai:historyGet': { returns: 'Histórico guardado { messages, busy }', api: ['aiHistoryGet'] },
  'ai:historyClear': { returns: 'true (apaga o histórico guardado)', api: ['aiHistoryClear'] },
  'ai:analyzeTranscript': {
    args: [OBJ('payload', { path: t.string({ min: 1, max: 500, label: 'Arquivo da transcrição' }) }, { label: 'Análise' })],
    returns: 'Resultado da análise',
    api: [{ name: 'aiAnalyzeTranscript', params: 'path', call: '{ path }' }]
  },
  'ai:cancelAnalysis': { returns: 'true', api: ['aiCancelAnalysis'] }
});

define('modules', 'wrap', {
  'modules:getStatus': { returns: 'Estado dos módulos (motor, modelos, CUDA)', api: ['modulesGetStatus'] },
  'modules:installEngine': { args: [OBJ('payload', { zipPath: t.string({ max: 500, optional: true, label: 'Arquivo' }) }, { optional: true, label: 'Opções' })], returns: 'Resultado da instalação', api: ['modulesInstallEngine'] },
  'modules:uninstallEngine': { returns: 'Resultado', api: ['modulesUninstallEngine'] },
  'modules:installModel': { args: [STR('id', 500, { min: 1, label: 'Modelo' })], returns: 'Resultado', api: ['modulesInstallModel'] },
  'modules:removeModel': { args: [STR('id', 500, { min: 1, label: 'Modelo' })], returns: 'Resultado', api: ['modulesRemoveModel'] },
  'modules:setActiveModel': { args: [STR('id', 500, { min: 1, label: 'Modelo' })], returns: 'Resultado', api: ['modulesSetActiveModel'] },
  'modules:installCuda': { args: [OBJ('payload', { acceptLicense: t.boolean({ optional: true }) }, { optional: true, label: 'Opções' })], returns: 'Resultado', api: ['modulesInstallCuda'] },
  'modules:removeCuda': { returns: 'Resultado', api: ['modulesRemoveCuda'] },
  'modules:cancel': { returns: 'Resultado', api: ['modulesCancel'] },
  'modules:transcribe': {
    args: [OBJ('options', {
      files: t.array(t.string({ max: 500, min: 1, label: 'Arquivo' }), { max: 5000, optional: true, label: 'Arquivos' }),
      outDir: t.string({ max: 500, optional: true, label: 'Pasta de saída' })
    }, { optional: true, label: 'Opções de transcrição', maxKeys: 50 })],
    returns: 'Resultado da transcrição',
    api: ['modulesTranscribe']
  },
  'modules:reveal': { args: [STR('p', 500, { min: 1, label: 'Caminho' })], returns: 'true', api: ['modulesReveal'] },
  'modules:list': { returns: 'Módulos (ligados/desligados, instalados)', api: ['modulesList'] },
  'modules:setEnabled': {
    args: [STR('id', 100, { min: 1, label: 'Módulo' }), t.boolean({ name: 'enabled', label: 'Valor' })],
    returns: 'Módulos ligados',
    api: ['modulesSetEnabled']
  }
});

// --- Biblioteca de mídia -----------------------------------------------------------------------
const IDS = (name = 'ids', max = 50000) => t.array(t.id(), { name, max, label: 'Mídias' });
const SOURCE_ID = t.id({ label: 'ID da fonte' });

define('library', 'throw', {
  'library:getStats': { returns: 'Estatísticas da biblioteca', api: ['getLibraryStats'] },
  'library:getThumbDir': { returns: 'Pasta de miniaturas', api: ['getThumbDir'] },
  'library:search': { args: [OBJ('options', {}, { optional: true, label: 'Consulta', maxKeys: 100 })], returns: 'Página de mídias', api: ['searchLibrary'] },
  'library:getRecent': { args: [t.int({ name: 'limit', optional: true, min: 1, max: 100000, label: 'Limite' })], returns: 'Mídias recentes', api: ['getRecentMedia'] },
  'library:getFilterOptions': { returns: 'Opções de filtro', api: ['getLibraryFilterOptions'] },
  'library:addCustomSource': {
    args: [OBJ('config', {
      name: t.string({ min: 1, max: 120, nonBlank: true, label: 'Nome da fonte' }),
      folderPath: t.dir({ label: 'Caminho da pasta' })
    }, { label: 'Fonte' })],
    returns: '{ ok, sourceName, origin }',
    api: ['addCustomSource']
  },
  'library:getCustomSources': { returns: 'Fontes personalizadas', api: ['getCustomSources'] },
  'library:getMediaProjectLinks': { args: [IDS()], returns: '{ links, projects, text }', api: ['getMediaProjectLinks'] },
  'library:updateCustomSourcePath': {
    args: [OBJ('config', { id: SOURCE_ID, name: t.string({ max: 300, optional: true }), newFolderPath: t.dir({ label: 'Caminho da pasta' }) }, { label: 'Fonte' })],
    returns: '{ ok }',
    api: ['updateCustomSourcePath']
  },
  'library:removeCustomSource': {
    args: [OBJ('config', { id: SOURCE_ID, name: t.string({ max: 300, optional: true }) }, { label: 'Fonte' })],
    returns: '{ ok }',
    api: ['removeCustomSource']
  },
  'library:renameMedia': {
    args: [ID('id', { label: 'ID da mídia' }), STR('newName', 255, { nonBlank: true, label: 'Nome do arquivo' })],
    returns: 'true',
    api: ['renameMedia']
  },
  'library:toggleFavorite': { args: [ID('id', { label: 'ID da mídia' }), t.boolean({ name: 'isFav', label: 'Favorito' })], returns: 'true', api: ['toggleFavorite'] },
  'library:getMediaTags': { args: [ID('id', { label: 'ID da mídia' })], returns: 'Tags da mídia', api: ['getMediaTags'] },
  'library:addMediaTag': { args: [ID('id', { label: 'ID da mídia' }), STR('tagName', 200, { nonBlank: true, label: 'Nome da tag' })], returns: 'true', api: ['addMediaTag'] },
  'library:removeMediaTag': { args: [ID('mediaId', { label: 'ID da mídia' }), ID('tagId', { label: 'ID da tag' })], returns: 'true', api: ['removeMediaTag'] },
  'library:deleteMediaBulk': { args: [IDS()], returns: '{ ok, deleted, failed }', api: ['deleteMediaBulk'] },
  'library:moveMediaBulk': { args: [IDS(), STR('newDir', 4096, { optional: true, label: 'Diretório de destino' })], returns: 'true ou { ok, moved, failed }', api: ['moveMediaBulk'] },
  'library:setProjectBulk': { args: [IDS(), ID('projectId', { optional: true, label: 'ID do projeto' })], returns: 'true', api: ['setProjectBulk'] },
  'library:renameMediaBulk': { args: [IDS(), STR('baseName', 255, { optional: true, label: 'Nome base' })], returns: 'true ou { ok, renamed, failed }', api: ['renameMediaBulk'] },
  'library:addMediaTagBulk': { args: [IDS(), STR('tagName', 200, { optional: true, label: 'Nome da tag' })], returns: 'true', api: ['addMediaTagBulk'] },
  'library:toggleFavoriteBulk': { args: [IDS(), t.boolean({ name: 'isFav', label: 'Favorito' })], returns: 'true', api: ['toggleFavoriteBulk'] },
  'library:clearDatabase': { returns: '{ ok, details } (confirmação nativa + backup)', api: ['clearLibraryDatabase'] },
  'library:rescanAll': { returns: 'true', api: ['rescanAllLibrary'] },
  'library:regenerateMissingThumbnails': {
    args: [OBJ('opts', { batchSize: t.int({ min: 1, max: 64, optional: true, label: 'Tamanho do lote' }) }, { label: 'Opções' })],
    returns: 'Resultado da regeneração',
    api: [{ name: 'regenerateMissingThumbnails', params: 'opts', call: 'opts || {}' }]
  },
  'library:getAll': { returns: 'Bibliotecas cadastradas', api: ['getAllLibraries'] },
  'library:getFolderFiles': { error: 'empty', args: [STR('folderPath', 4096, { optional: true })], returns: 'Arquivos de mídia da pasta ([] em falha)', api: ['getLibraryFolderFiles'] }
});

// --- Sistema -----------------------------------------------------------------------------------
define('system', 'throw', {
  'system:getVideosPath': { returns: 'Pasta Vídeos', api: ['getVideosPath'] },
  'system:getDownloadsPath': { returns: 'Pasta Downloads', api: ['getDownloadsPath'] },
  'system:getToolsPath': { returns: 'Pasta de ferramentas/dados', api: ['getToolsPath'] },
  'system:isPackaged': { returns: 'boolean', api: ['isPackaged'] },
  'system:getHardwareInfo': { returns: 'GPU, encoders e FFmpeg', api: ['getHardwareInfo'] },
  'system:checkEncoders': { returns: 'Lista de encoders do FFmpeg', api: ['checkEncoders'] },
  'system:getStorageInfo': { returns: 'Armazenamento do PC e de dispositivos', api: ['getStorageInfo'] },
  'system:getCacheInfo': { returns: 'Uso do cache por categoria', api: ['getCacheInfo'] },
  'system:clearCache': { args: [STR('categoryKey', 100, { optional: true, label: 'Categoria de cache' })], returns: 'Resultado da limpeza', api: ['clearCache'] },
  'system:openPath': { error: 'success', args: [STR('itemPath', 4096, { label: 'Caminho' })], returns: '{ success, error? }', api: ['openLocalPath'] },
  'system:exportCookies': {
    args: [STR('domain', 253, { pattern: /^\.?[a-z0-9.-]{1,253}$/i, label: 'Domínio' }), STR('outputPath', 4096, { label: 'Arquivo de saída' })],
    returns: 'true se gravou',
    api: ['exportCookies']
  },
  'shell:openExternal': { args: [STR('url', 4096, { label: 'URL' })], returns: 'true', api: ['openExternal'] }
});

define('licenses', 'throw', {
  'licenses:getList': { returns: 'Lista de componentes de terceiros (incluídos e baixados)', api: ['getLicenses'] },
  'licenses:getText': { args: [STR('id', 200, { pattern: /^[\w.-]{1,200}$/, label: 'Componente' })], returns: 'Texto da licença (somente leitura)', api: ['getLicenseText'] }
});

define('upload', 'throw', {
  'upload:scanDirectory': { args: [STR('customDir', 4096, { optional: true, allowEmpty: true, label: 'Pasta de uploads' })], returns: 'Vídeos da pasta', api: ['uploadScanDirectory'] },
  'upload:selectFolder': { returns: 'Vídeos da pasta escolhida ou null', api: ['uploadSelectFolder'] },
  'upload:selectFiles': { returns: 'Vídeos escolhidos', api: ['uploadSelectFiles'] }
});

// --- Prévia de fotos ---------------------------------------------------------------------------
define('photo', 'throw', {
  'photo:getMetadata': { args: [ABS('filePath', 'Caminho do arquivo')], returns: 'Metadados da foto', api: ['photoGetMetadata'] },
  'photo:getRenderablePath': { args: [ABS('filePath', 'Caminho do arquivo'), OBJ('options', {}, { optional: true, label: 'Opções' })], returns: 'Caminho renderizável', api: ['photoGetRenderablePath'] }
});

// --- Projetos ----------------------------------------------------------------------------------
const PROJECT_ID = (name = 'projectId') => ID(name, { label: 'ID do projeto' });
const OPT_ID = (name, label) => ID(name, { optional: true, label });
const UUID = t.string({ pattern: /^[A-Za-z0-9_-]{1,100}$/, max: 100, label: 'Identificador de mídia' });
const STREAM_INDEX = (optional = true) => t.int({ name: 'streamIndex', min: 0, max: 64, optional, label: 'Índice de stream' });
const DATA = (name, label) => OBJ(name, {}, { label, maxKeys: 100 });
const OUTPUT_SPEC = () => t.oneOf([t.string({ max: 4096 }), t.object({}, { maxKeys: 10 })], { name: 'outputPath', label: 'Arquivo de saída' });

define('projects', 'throw', {
  'projects:list': { returns: 'Projetos', api: ['listProjects'] },
  'projects:get': { args: [PROJECT_ID('id')], returns: 'Projeto', api: ['getProject'] },
  'projects:create': { args: [OBJ('data', { name: t.string({ max: 500, optional: true, label: 'Nome do projeto' }) }, { label: 'Dados do projeto', maxKeys: 100 })], returns: 'Projeto criado', api: ['createProject'] },
  'projects:update': { args: [PROJECT_ID('id'), DATA('data', 'Dados do projeto')], returns: 'Projeto atualizado', api: ['updateProject'] },
  'projects:delete': { args: [PROJECT_ID('id')], returns: 'Resultado', api: ['deleteProject'] },
  'projects:getBins': { args: [PROJECT_ID()], returns: 'Pastas do projeto', api: ['getProjectBins'] },
  'projects:createBin': { args: [PROJECT_ID(), OPT_ID('parentId', 'ID da pasta'), STR('name', 500, { nonBlank: true, label: 'Nome da pasta' })], returns: 'ID da pasta criada', api: ['createProjectBin'] },
  'projects:updateBin': { args: [ID('id', { label: 'ID da pasta' }), STR('name', 500, { optional: true, label: 'Nome da pasta' }), OPT_ID('parentId', 'ID da pasta')], returns: 'Resultado', api: ['updateProjectBin'] },
  'projects:deleteBin': { args: [ID('id', { label: 'ID da pasta' })], returns: 'Resultado', api: ['deleteProjectBin'] },
  'projects:getMedia': { args: [PROJECT_ID()], returns: 'Mídias do projeto', api: ['getProjectMedia'] },
  'projects:getMediaById': { args: [ID('pmId', { label: 'ID da mídia no projeto' })], returns: 'Mídia do projeto', api: ['getProjectMediaById'] },
  'projects:addMedia': {
    args: [PROJECT_ID(), OPT_ID('binId', 'ID da pasta'), ID('mediaId', { label: 'ID da mídia' }), STR('customName', 500, { optional: true, label: 'Nome' })],
    returns: 'Resultado',
    api: ['addProjectMedia']
  },
  'projects:addMediaBulk': { args: [PROJECT_ID(), OPT_ID('binId', 'ID da pasta'), IDS('mediaIds')], returns: 'Resultado', api: ['addProjectMediaBulk'] },
  'projects:importFilesToBin': {
    args: [OBJ('payload', { projectId: PROJECT_ID('projectId'), binId: OPT_ID('binId', 'ID da pasta') }, { label: 'Importação' })],
    returns: '{ imported, skipped, failed?, total? }',
    api: [{ name: 'importFilesToProjectBin', params: 'projectId, binId', call: '{ projectId, binId }' }]
  },
  'projects:importDroppedFilesToBin': {
    args: [OBJ('payload', { projectId: PROJECT_ID('projectId'), binId: OPT_ID('binId', 'ID da pasta'), filePaths: PATHS('filePaths') }, { label: 'Importação' })],
    returns: '{ imported, skipped, failed?, total? }',
    api: [{ name: 'importDroppedFilesToProjectBin', params: 'projectId, binId, filePaths', call: '{ projectId, binId, filePaths }' }]
  },
  'projects:removeMedia': { args: [ID('pmId', { label: 'ID da mídia no projeto' })], returns: 'Resultado', api: ['removeProjectMedia'] },
  'projects:moveMedia': { args: [ID('pmId', { label: 'ID da mídia no projeto' }), OPT_ID('newBinId', 'ID da pasta')], returns: 'Resultado', api: ['moveProjectMedia'] },
  'projects:getFullModel': { args: [PROJECT_ID()], returns: 'Modelo completo do projeto', api: ['getProjectFullModel'] },
  'projects:getSequences': { args: [PROJECT_ID()], returns: 'Sequências', api: ['getProjectSequences'] },
  'projects:getOrCreateDefaultSequence': { args: [PROJECT_ID()], returns: 'Sequência padrão', api: ['getOrCreateDefaultSequence'] },
  'projects:createSequence': {
    args: [PROJECT_ID(), STR('name', 500, { optional: true, label: 'Nome da sequência' }), t.number({ name: 'timebase', optional: true, min: 0, label: 'Timebase' }), t.number({ name: 'width', optional: true, min: 0, label: 'Largura' }), t.number({ name: 'height', optional: true, min: 0, label: 'Altura' })],
    returns: 'Sequência criada',
    api: ['createProjectSequence']
  },
  'projects:updateSequence': { args: [ID('id', { label: 'ID da sequência' }), DATA('data', 'Dados da sequência')], returns: 'Resultado', api: ['updateProjectSequence'] },
  'projects:deleteSequence': { args: [ID('id', { label: 'ID da sequência' })], returns: 'Resultado', api: ['deleteProjectSequence'] },
  'projects:getTracks': { args: [ID('sequenceId', { label: 'ID da sequência' })], returns: 'Trilhas', api: ['getProjectTracks'] },
  'projects:createTrack': {
    args: [ID('sequenceId', { label: 'ID da sequência' }), STR('trackType', 40, { label: 'Tipo de trilha' }), t.int({ name: 'trackIndex', min: 0, max: 10000, label: 'Índice da trilha' }), STR('name', 500, { optional: true, label: 'Nome da trilha' })],
    returns: 'Trilha criada',
    api: ['createProjectTrack']
  },
  'projects:updateTrack': { args: [ID('id', { label: 'ID da trilha' }), DATA('data', 'Dados da trilha')], returns: 'Resultado', api: ['updateProjectTrack'] },
  'projects:deleteTrack': { args: [ID('id', { label: 'ID da trilha' })], returns: 'Resultado', api: ['deleteProjectTrack'] },
  'projects:getClips': { args: [ID('trackId', { label: 'ID da trilha' })], returns: 'Clipes', api: ['getProjectClips'] },
  'projects:addClip': { args: [ID('trackId', { label: 'ID da trilha' }), DATA('data', 'Dados do clipe')], returns: 'Clipe criado', api: ['addProjectClip'] },
  'projects:updateClip': { args: [ID('id', { label: 'ID do clipe' }), DATA('data', 'Dados do clipe')], returns: 'Resultado', api: ['updateProjectClip'] },
  'projects:deleteClip': { args: [ID('id', { label: 'ID do clipe' })], returns: 'Resultado', api: ['deleteProjectClip'] },
  'projects:getMarkers': { args: [PROJECT_ID(), OPT_ID('sequenceId', 'ID da sequência')], returns: 'Marcadores', api: ['getProjectMarkers'] },
  'projects:addMarker': { args: [DATA('data', 'Dados do marcador')], returns: 'Marcador criado', api: ['addProjectMarker'] },
  'projects:deleteMarker': { args: [ID('id', { label: 'ID do marcador' })], returns: 'Resultado', api: ['deleteProjectMarker'] },
  'projects:getSyncGroups': { args: [PROJECT_ID()], returns: 'Grupos de sincronização', api: ['getProjectSyncGroups'] },
  'projects:createSyncGroup': {
    args: [PROJECT_ID(), STR('name', 500, { optional: true, label: 'Nome do grupo' }), OPT_ID('masterMediaId', 'ID da mídia mestre'), t.array(t.object({}, { maxKeys: 20 }), { name: 'items', max: 5000, optional: true, label: 'Itens' })],
    returns: 'ID do grupo',
    api: ['createProjectSyncGroup']
  },
  'projects:updateSyncGroup': { args: [ID('id', { label: 'ID do grupo' }), DATA('data', 'Dados do grupo')], returns: 'Resultado', api: ['updateProjectSyncGroup'] },
  'projects:deleteSyncGroup': { args: [ID('id', { label: 'ID do grupo' })], returns: 'Resultado', api: ['deleteProjectSyncGroup'] },
  'projects:removeSyncGroupItem': { args: [ID('itemId', { label: 'ID do item' })], returns: 'Resultado', api: ['removeProjectSyncGroupItem'] },
  'projects:getMissingMedia': { args: [PROJECT_ID()], returns: 'Mídias ausentes', api: ['getMissingProjectMedia'] },
  'projects:relinkMedia': { args: [ID('mediaId', { label: 'ID da mídia' }), t.file({ name: 'newFilepath', label: 'Novo arquivo' })], returns: 'Resultado', api: ['relinkMedia'] },
  'projects:exportBdspro': { args: [PROJECT_ID(), OUTPUT_SPEC()], returns: 'Resultado da exportação', api: ['exportBdspro'] },
  'projects:inspectBdspro': { args: [t.file({ name: 'bdsproPath', label: 'Pacote .bdspro' })], returns: 'Resumo do pacote', api: ['inspectBdspro'] },
  'projects:scanRelinkFolder': { args: [t.searchDir({ name: 'folderPath', label: 'Pasta' })], returns: 'Arquivos de mídia encontrados', api: ['scanRelinkFolder'] },
  'projects:matchMissingMedia': {
    args: [
      t.array(t.object({}, { maxKeys: 50 }), { name: 'missingList', max: 100000, label: 'Lista de ausentes' }),
      t.array(t.any('itens varridos têm formato do scanner (texto ou objeto); o serviço compara por nome'), { name: 'scannedFiles', max: 2000000, label: 'Arquivos varridos' })
    ],
    returns: 'Correspondências',
    api: ['matchMissingMedia']
  },
  'projects:importBdspro': {
    args: [t.file({ name: 'bdsproPath', label: 'Pacote .bdspro' }), OBJ('relinkMap', {}, { optional: true, label: 'Mapa de relink', maxKeys: 100000 })],
    returns: 'Resultado da importação',
    api: ['importBdspro']
  },
  'projects:exportPremiere': { args: [PROJECT_ID(), OUTPUT_SPEC()], returns: 'Resultado da exportação', api: ['exportProjectPremiere'] },
  'projects:exportSequencePremiere': { args: [PROJECT_ID(), OUTPUT_SPEC()], returns: 'Resultado da exportação', api: ['exportProjectSequencePremiere'] },
  'projects:getSequenceModel': { args: [PROJECT_ID()], returns: 'Modelo da sequência', api: ['getProjectSequenceModel'] },
  'projects:getWaveform': {
    args: [OBJ('params', { uuid: UUID, filePath: t.file({ label: 'Arquivo de mídia' }) }, { label: 'Parâmetros da waveform', maxKeys: 20 })],
    returns: 'Picos da waveform',
    api: ['getMediaWaveform']
  },
  'projects:probeAudioStreams': { error: 'empty', args: [t.file({ name: 'filePath', label: 'Arquivo de mídia' })], returns: 'Streams de áudio ([] em falha)', api: ['probeAudioStreams'] },
  'projects:hasWaveformCache': { args: [{ ...UUID, name: 'uuid' }, STREAM_INDEX()], returns: 'boolean', api: [{ name: 'hasWaveformCache', params: 'uuid, streamIndex', call: 'uuid, streamIndex' }] },
  'projects:deleteWaveformCache': { args: [{ ...UUID, name: 'uuid' }, STREAM_INDEX()], returns: 'true', api: [{ name: 'deleteWaveformCache', params: 'uuid, streamIndex', call: 'uuid, streamIndex' }] },
  'projects:getTrackAudioPath': {
    args: [OBJ('params', { uuid: UUID, filePath: t.file({ label: 'Arquivo de mídia' }) }, { label: 'Parâmetros da trilha', maxKeys: 20 })],
    returns: 'URL file:// do áudio extraído',
    api: ['getTrackAudioPath']
  },
  'projects:runAudioSync': {
    args: [OBJ('params', {
      projectId: PROJECT_ID('projectId'),
      groupName: t.string({ max: 500, optional: true, label: 'Nome do grupo' }),
      masterMediaId: t.id({ label: 'ID da mídia mestre' }),
      mediaList: t.array(t.object({}, { maxKeys: 30 }), { min: 2, max: 500, label: 'Mídias' }),
      maxOffsetSeconds: t.number({ optional: true, min: 0, max: 100000 })
    }, { label: 'Parâmetros da sincronização', maxKeys: 20 })],
    returns: '{ groupId, results }',
    api: ['runAudioSync']
  }
});

// --- Jobs (JobManager; sem exposição no preload por enquanto) ----------------------------------
define('jobs', 'throw', {
  'jobs:getStatus': { returns: 'Estado do JobManager' },
  'jobs:cancel': { args: [STR('jobId', 200, { min: 1, label: 'Tarefa' })], returns: 'Resultado' },
  'jobs:cancelAll': { returns: 'true' },
  'jobs:getHistory': { returns: 'Histórico de jobs' },
  'jobs:clearHistory': { returns: 'true' },
  'jobs:pause': { returns: 'true' },
  'jobs:resume': { returns: 'true' }
});

/**
 * Eventos main → renderer que o preload assina: [nome em window.bds, canal].
 * (Nomes com ponto ficam num namespace: 'downloads.onWait'.)
 */
const EVENTS = [
  ['onMontageProgress', 'montage:progress'],
  ['onMontageFinished', 'montage:finished'],
  ['onMontageQueueUpdated', 'montage:queue-updated'],
  ['onMontageLog', 'montage:log'],
  ['onSilenceProgress', 'silence:progress'],
  ['onSilenceFinished', 'silence:finished'],
  ['onSilenceLog', 'silence:log'],
  ['onMtpProgress', 'mtp:import-progress'],
  ['onSonyImportProgress', 'sony:import-progress'],
  ['onSonyStatusUpdated', 'sony-camera:status-update'],
  ['onMetadataProgress', 'metadata:progress'],
  ['onMetadataLog', 'metadata:log'],
  ['onNavigateToScreen', 'bds:navigate-to-screen'],
  ['downloads.onWait', 'downloads:wait'],
  ['downloads.onAdded', 'downloads:added'],
  ['downloads.onUpdated', 'downloads:updated'],
  ['downloads.onProgress', 'downloads:progress'],
  ['downloads.onCompleted', 'downloads:completed'],
  ['downloads.onFailed', 'downloads:failed'],
  ['downloads.onRemoved', 'downloads:removed'],
  ['downloads.onQueueCompleted', 'downloads:queue-completed'],
  ['onUpdateProgress', 'updates:progress'],
  ['onUpdateCompleted', 'updates:completed'],
  ['recovery.onProgress', 'recovery:progress'],
  ['recovery.onStage', 'recovery:stage'],
  ['recovery.onFinished', 'recovery:finished'],
  ['recovery.onError', 'recovery:error'],
  ['recovery.raw.onProgress', 'recovery:raw:progress'],
  ['recovery.raw.onStage', 'recovery:raw:stage'],
  ['recovery.raw.onFinished', 'recovery:raw:finished'],
  ['recovery.raw.onError', 'recovery:raw:error'],
  ['onDownloadQueue', 'download:queue'],
  ['onProgress', 'download:progress'],
  ['onFinished', 'download:finished'],
  ['onUpdatesChecked', 'updates:checked'],
  ['onDependenciesDownloading', 'dependencies:downloading'],
  ['onDependenciesDone', 'dependencies:done'],
  ['onConverterQueue', 'converter:queue'],
  ['onConverterFileStarted', 'converter:fileStarted'],
  ['onConverterProgress', 'converter:progress'],
  ['onConverterFileFinished', 'converter:fileFinished'],
  ['onConverterFinished', 'converter:finished'],
  ['onConverterOverallProgress', 'converter:overallProgress'],
  ['onYoutubeCode', 'youtube:code'],
  ['onYoutubeAuthStatus', 'youtube:auth-status'],
  ['onAiAnalysisProgress', 'ai:analysisProgress'],
  ['onAiChatDelta', 'ai:chatDelta'],
  ['onAiChatDone', 'ai:chatDone'],
  ['onAiChatError', 'ai:chatError'],
  ['onAiChatStatus', 'ai:chatStatus'],
  ['onAiNavigate', 'ai:navigate'],
  ['onModulesChanged', 'modules:changed'],
  ['onModulesProgress', 'modules:progress'],
  ['onModulesStatus', 'modules:status'],
  ['onThumbsRegenProgress', 'bds:thumbs-regen-progress'],
  ['onMediaImported', 'bds:media-imported'],
  ['onMediaRemoved', 'bds:media-removed'],
  ['onMediaUpdated', 'bds:media-updated'],
  ['onProjectImportProgress', 'projects:importProgress'],
  ['onAudioSyncProgress', 'projects:audioSyncProgress'],
  ['onBdsmDeviceAdded', 'bdsm:device_added'],
  ['onBdsmDeviceRemoved', 'bdsm:device_removed'],
  ['onBdsmDeviceUpdated', 'bdsm:device_updated'],
  ['onBdsmProgress', 'bdsm:progress'],
  ['onBdsmLutSyncProgress', 'bdsm:lutSyncProgress'],
  ['onBdsmPairing', 'bdsm:pairing']
];

module.exports = { CHANNELS, EVENTS };
