'use strict';


const perf = require('../infrastructure/diagnostics/startupPerf');
const logger = require('../services/logService');
const { externalTools } = require('../infrastructure/external-tools/ExternalToolsManager');
const { moduleRuntime, HOOKS } = require('./moduleRuntime');

/** Pausa curta que devolve o processo principal ao Chromium (IPC da Home, pintura) entre duas etapas. */
const yieldToChromium = () => new Promise((resolve) => setImmediate(resolve));

/** Folga antes da auto-limpeza de cache: assíncrona, mas não deve disputar I/O com a abertura da Home. */
const CACHE_MAINTENANCE_DELAY_MS = 1500;

/**
 * Etapas de startup em segundo plano, NA ORDEM em que rodam: [nome, função]. Cada etapa é isolada
 * (uma falha é registrada e as demais continuam) e o processo principal é cedido ao Chromium entre elas.
 * `ctx` = { services, paths, appPaths, settingsManager, getMainWindow }.
 */
function buildBackgroundSteps(ctx) {
  // As tarefas de fundo de um módulo só rodam com ele LIGADO (e começam sozinhas quando ele é ligado depois,
  // em Configurações → Módulos). Desligado: nada é carregado nem iniciado.
  const on = (id) => moduleRuntime.isEnabled(id);
  return [
    // 1. Biblioteca: watchers de pastas (a reconciliação de arquivos é agendada à parte, só aqui no startup —
    // reiniciar watchers ao trocar uma pasta não varre o disco de novo) e regeneração de thumbnails ausentes
    ['watchers', () => {
      if (on('library')) moduleRuntime.start('library', { startup: true });
      else HOOKS.library.skipped();
    }],

    // 2. Dispositivos: identidade e tokens de pareamento dos celulares (criptografados por safeStorage), antes da primeira sondagem
    ['bdsm-auth', () => {
      if (on('devices')) HOOKS.devices.startAuth(ctx);
    }],

    // 3. Dispositivos: descoberta (mDNS/Bonjour, ADB, SSDP da Sony)
    ['discovery', () => {
      if (on('devices')) moduleRuntime.start('devices', { startup: true, skipAuth: true });
      else HOOKS.devices.skipped();
    }],

    // 4. Projetos: lembretes de prazo
    ['deadlines', () => {
      if (on('projects')) moduleRuntime.start('projects', { startup: true });
      else HOOKS.projects.skipped();
    }],

    // 5. Auto-limpeza de cache e temporários antigos — assíncrona e depois do primeiro paint,
    // com pequena folga para não competir com a reconciliação/IPC iniciais.
    ['cache-maintenance', () => {
      setTimeout(() => runCacheMaintenance(ctx), CACHE_MAINTENANCE_DELAY_MS);
    }],
  ];
}

/**
 * Inicia as tarefas de segundo plano, uma etapa por vez e cedendo o processo ao Chromium entre elas.
 * Nenhuma etapa é descartada: uma que falha é registrada e a seguinte roda mesmo assim.
 * `opts.steps` e `opts.yieldFn` existem para os testes.
 * @returns {Promise<string[]>} nomes das etapas executadas, na ordem
 */
async function startBackgroundServices(ctx, { steps = buildBackgroundSteps(ctx), yieldFn = yieldToChromium } = {}) {
  perf.mark('bg:start');
  moduleRuntime.setContext(ctx);
  // LUTs embutidas: só com LUTs ou Dispositivos ligados (a sincronização de LUTs usa a mesma pasta)
  try { if (moduleRuntime.isEnabled('luts')) moduleRuntime.start('luts', { startup: true }); } catch (_) { /* opcional */ }
  const ran = [];
  for (const [name, run] of steps) {
    try {
      run();
    } catch (err) {
      logger.error('Erro ao iniciar serviços em segundo plano:', { step: name, error: err.message });
    }
    ran.push(name);
    await yieldFn();
  }
  logger.info('Serviços em segundo plano inicializados.');
  return ran;
}

/** Auto-limpeza de cache (se habilitada) e remoção de temporários com mais de 1 h, sem bloquear o event loop. */
async function runCacheMaintenance(ctx) {
  try {
    const settings = ctx.settingsManager.load();
    const CacheService = require('../core/CacheService');
    const cacheSvc = new CacheService(ctx.appPaths, {
      maxSizeMB: settings.cacheMaxSizeMB || 500,
      autoClean: !!settings.cacheAutoClean,
    });
    const result = await cacheSvc.autoCleanIfNeededAsync();
    if (result.trimmed) {
      logger.info(`[Bootstrap] Auto-limpeza de cache no startup: liberado ${result.totalFormatted}`);
    }
    // Remove apenas arquivos temporários de execuções anteriores (>1h); NÃO toca em thumbnails/waveforms
    await cacheSvc.cleanStaleTempFilesAsync(60 * 60 * 1000);
  } catch (err) {
    logger.warn('Bootstrap:autoCleanCache:error', { error: err.message });
  } finally {
    perf.done('cache');
  }
}

/**
 * Primeira inicialização: baixa as dependências essenciais ausentes; senão, checa atualizações
 * (se habilitado). `ctx` = { services, settingsManager, bridge }.
 */
async function checkInitialDependencies(ctx) {
  try {
    return await checkInitialDependenciesImpl(ctx);
  } finally {
    perf.done('deps');
  }
}

async function checkInitialDependenciesImpl(ctx) {
  const { updateService } = ctx.services;
  moduleRuntime.setContext(ctx);

  // Verifica apenas ferramentas essenciais de execução; o yt-dlp só é exigido com o módulo Downloads ligado
  // (ligar o módulo depois baixa o yt-dlp, ver moduleRuntime.js).
  const requiredTools = ['ffmpeg', 'ffprobe', ...(moduleRuntime.isEnabled('download') ? ['ytdlp'] : [])];
  const missing = requiredTools.filter(tool => {
    try {
      if (tool === 'ytdlp') return !externalTools.ytdlp.exists();
      if (tool === 'ffmpeg') return !externalTools.ffmpeg.exists();
      if (tool === 'ffprobe') return !externalTools.ffprobe.exists();
    } catch (_) {
      return true;
    }
    return false;
  });

  if (missing.length > 0) {
    logger.info(`Primeira inicialização: Baixando dependências essenciais ausentes: ${missing.join(', ')}`);
    ctx.bridge.send('dependencies:downloading');

    for (const tool of missing) {
      // ffmpeg e ffprobe vêm no mesmo pacote: se o primeiro já trouxe o segundo, não baixa de novo.
      try {
        if ((tool === 'ffprobe' && externalTools.ffprobe.exists()) || (tool === 'ffmpeg' && externalTools.ffmpeg.exists())) continue;
      } catch (_) { /* segue e tenta instalar */ }
      try {
        // Primeira instalação de um essencial ausente: sem ele o app não funciona, então instala
        // mesmo que a fonte não publique checksum (o toolUpdater registra o aviso no log).
        await updateService.updateTool(tool, null, { allowUnverified: true });
      } catch (e) {
        logger.error(`Erro ao baixar ${tool} na inicialização`, { error: e.message });
      }
    }

    ctx.bridge.send('dependencies:done');
    logger.info('Dependências iniciais instaladas com sucesso.');
  } else if (ctx.settingsManager.load().checkUpdatesOnStart) {
    // Usa checkEverything() (mesmo método do botão "Verificar Atualizações" em
    // Configurações) para checar app + dependências num formato { hasUpdates, app,
    // dependencies } esperado pelo renderer. checkAll() é um método legado com formato
    // diferente (um objeto por ferramenta) e não deve ser usado aqui.
    updateService.checkEverything().then((result) => {
      ctx.bridge.send('updates:checked', result);
    }).catch((error) => {
      logger.warn('updates:startup_check_failed', { error: error.message });
    });
  }
}

module.exports = { startBackgroundServices, buildBackgroundSteps, runCacheMaintenance, checkInitialDependencies };
