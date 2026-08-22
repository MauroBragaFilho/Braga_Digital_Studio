# Braga Digital Studio — Arquitetura, Roadmap e Plano de Evolução

Versão analisada: BDS 1.0.2

Status: Planejamento técnico

Última revisão: 2026-08-20

---

# 1. Objetivo deste documento

Este documento define a direção técnica do Braga Digital Studio (BDS),
com base na análise do código-fonte da versão 1.0.2.

O objetivo não é reescrever o BDS do zero.

A estratégia definida é:

- preservar as funcionalidades existentes;
- corrigir problemas arquiteturais;
- remover acoplamentos específicos do Windows;
- tornar o BDS multiplataforma;
- manter FFmpeg, FFprobe, yt-dlp e spotDL;
- melhorar a arquitetura interna;
- preparar integração mais profunda com o BDSM;
- deixar uma eventual migração futura para Kotlin como possibilidade,
  e não como prioridade imediata.

---

# 2. Visão geral do BDS

O BDS é uma aplicação desktop voltada para produção audiovisual,
organização de mídia e automação de processos.

Principais áreas:

- Biblioteca de mídia;
- Projetos;
- Project Workspace;
- Downloads;
- Conversão;
- Remoção de silêncio;
- Montagem automática;
- Sincronização de áudio;
- Sequências;
- Exportação para Adobe Premiere;
- LUTs;
- Dispositivos;
- Uploads;
- Integração com BDSM.

---

# 3. Princípio fundamental da evolução

O BDS NÃO será reescrito do zero.

A evolução será incremental.

A aplicação atual deverá continuar funcionando durante a refatoração.

Regra:

    funcionalidade existente
            ↓
    refatoração interna
            ↓
    mesma funcionalidade
            +
    arquitetura melhor
            +
    suporte multiplataforma

Nenhuma grande funcionalidade deve ser removida apenas para facilitar
a migração arquitetural.

---

# 4. Decisão: não migrar para Kotlin neste momento

A migração completa do BDS para Kotlin NÃO faz parte da primeira fase.

O BDS continuará utilizando sua arquitetura atual enquanto a fundação
multiplataforma é construída.

A experiência adquirida com Kotlin no BDSM poderá ser utilizada futuramente.

A eventual migração para Kotlin deverá ser avaliada somente depois que:

- a arquitetura estiver desacoplada;
- os serviços estiverem bem definidos;
- o sistema multiplataforma estiver funcionando;
- os contratos entre módulos estiverem estabilizados.

---

# 5. Objetivo principal: multiplataforma

O principal objetivo arquitetural é permitir que o BDS funcione em:

- Windows;
- Linux;
- futuramente macOS, se necessário.

A aplicação não deve depender de caminhos, executáveis ou comandos
exclusivos do Windows.

---

# 6. Regra para dependências externas

As seguintes ferramentas NÃO serão removidas:

- FFmpeg;
- FFprobe;
- yt-dlp;
- spotDL.

Elas são partes fundamentais do BDS.

O objetivo é somente remover a dependência de arquivos específicos
como:

    ffmpeg.exe
    ffprobe.exe
    yt-dlp.exe
    spotify-dlp.exe

A aplicação deverá trabalhar com uma abstração de ferramentas externas.

Exemplo:

Windows:

    ffmpeg.exe

Linux:

    ffmpeg

O restante do BDS não deverá precisar saber qual nome ou caminho foi usado.

---

# 7. External Tools Manager

Criar uma camada centralizada:

    src/infrastructure/external-tools/

Estrutura proposta:

    ExternalToolsManager
    ToolResolver
    ToolRunner
    ToolInstaller
    ToolUpdater
    ToolManifest

E adapters:

    FfmpegTool
    FfprobeTool
    YtDlpTool
    SpotDlTool

---

# 8. ToolRunner

Todos os processos externos deverão passar por uma camada comum.

Responsabilidades:

- executar processos;
- capturar stdout;
- capturar stderr;
- acompanhar progresso;
- tratar códigos de saída;
- cancelar processos;
- controlar timeout;
- registrar erros;
- registrar logs.

Nenhum serviço deverá executar diretamente:

    spawn()
    exec()
    taskkill()

sem passar pela camada apropriada.

---

# 9. Cancelamento multiplataforma

Atualmente existem comandos específicos do Windows,
principalmente:

    taskkill

Isso deverá ser removido dos serviços.

A aplicação deverá possuir uma API abstrata:

    ProcessRunner.cancel()

O mecanismo interno deverá decidir como finalizar o processo
dependendo do sistema operacional.

---

# 10. FFmpeg

O FFmpeg deverá continuar sendo o principal motor de processamento
de mídia.

Serviços que utilizam FFmpeg deverão deixar de conhecer diretamente
o caminho do executável.

Exemplo INCORRETO:

    path.join(dataDir, 'ffmpeg.exe')

Exemplo desejado:

    FfmpegTool.run(args)

---

# 11. FFprobe

O mesmo princípio deverá ser aplicado ao FFprobe.

Serviços como:

- MetadataService;
- WaveformService;
- AudioSyncService;
- MediaImporter;
- Library;
- ThumbnailService;

não devem possuir caminhos próprios para FFprobe.

---

# 12. yt-dlp

Todas as chamadas ao yt-dlp deverão utilizar:

    YtDlpTool

Nenhum serviço deverá assumir:

    yt-dlp.exe

A resolução do executável será responsabilidade da camada
External Tools.

---

# 13. spotDL

O spotDL continuará existindo.

A implementação deverá ser encapsulada em:

    SpotDlTool

A forma de distribuição e execução poderá variar de acordo com
a plataforma.

Essa diferença não deverá chegar ao restante do sistema.

---

# 14. Atualização das ferramentas

O atual UpdateService possui forte dependência do Windows.

Ele deverá ser transformado em um sistema genérico de gerenciamento
de ferramentas externas.

Responsabilidades:

- detectar ferramenta instalada;
- verificar versão;
- comparar versões;
- baixar atualização;
- validar arquivo;
- instalar;
- substituir versão;
- informar progresso;
- tratar erros.

O sistema deverá ser baseado em manifests por plataforma.

---

# 15. PathService

Criar uma camada central para caminhos da aplicação.

Exemplo:

    AppPaths
        userData
        config
        database
        cache
        logs
        temp
        tools
        luts
        projects
        library

Nenhuma tela ou serviço deverá utilizar caminhos absolutos hardcoded.

---

# 16. Remover caminhos Windows hardcoded

Devem ser eliminados exemplos como:

    C:\Users\...
    C:\Users\mauri\...
    C:\Users\Public\...
    C:\Program Files\...
    C:\Windows\...
    LOCALAPPDATA
    APPDATA

quando utilizados como dependência obrigatória.

O BDS deverá utilizar APIs de sistema operacional ou caminhos fornecidos
pelo Electron/Node.

---

# 17. MTP

O MTP atualmente possui dependência de PowerShell.

Isso deverá ser abstraído.

Arquitetura:

    MtpService
        │
        ├── WindowsMtpProvider
        ├── LinuxMtpProvider
        └── MacMtpProvider

O restante do BDS deverá consumir apenas a interface MTP.

---

# 18. USB e armazenamento removível

O sistema atual utiliza APIs específicas do Windows,
como:

    Win32_LogicalDisk
    PowerShell

Criar:

    StorageDeviceService

Com providers específicos:

    WindowsStorageProvider
    LinuxStorageProvider
    MacStorageProvider

---

# 19. Device Discovery

O DeviceDiscoveryService deverá se tornar uma camada de descoberta
abstrata.

Possíveis providers:

    MTP
    USB
    ADB
    Network
    BDSM

O sistema deverá conseguir adicionar novos tipos de dispositivos
sem alterar o restante da aplicação.

---

# 20. Estrutura arquitetural proposta

Estrutura futura:

    src/
    │
    ├── core/
    │   ├── projects/
    │   ├── media/
    │   ├── library/
    │   ├── audio/
    │   ├── video/
    │   ├── downloads/
    │   ├── devices/
    │   └── integrations/
    │
    ├── infrastructure/
    │   ├── database/
    │   ├── filesystem/
    │   ├── external-tools/
    │   ├── logging/
    │   └── network/
    │
    ├── platform/
    │   ├── windows/
    │   ├── linux/
    │   └── macos/
    │
    ├── ipc/
    │
    └── services/

---

# 21. Main.js

O main.js possui responsabilidades excessivas.

Ele deverá gradualmente deixar de conter:

- lógica de LUT;
- regras de negócio;
- resolução de ferramentas;
- lógica de filesystem;
- implementação de serviços;
- handlers diretamente acoplados.

O main.js deverá funcionar principalmente como:

- bootstrap;
- inicialização da aplicação;
- criação da janela;
- composição de dependências;
- registro de IPC;
- lifecycle do Electron.

---

# 22. Preload

O preload continuará sendo a ponte segura entre renderer e backend.

A API deverá ser organizada por domínio.

Exemplo:

    window.bds.projects
    window.bds.library
    window.bds.media
    window.bds.downloads
    window.bds.tools
    window.bds.devices
    window.bds.system
    window.bds.bdsm

Evitar uma grande lista de funções independentes.

---

# 23. Renderer

O renderer não deverá conter regras de negócio.

Responsabilidades:

- interface;
- interação;
- estado visual;
- chamadas da API do preload;
- apresentação de dados.

Regras de negócio devem permanecer no backend/core.

---

# 24. Segurança do IPC

Operações que recebem caminhos do renderer deverão validar
esses caminhos.

Exemplo:

Uma operação de exclusão de LUT não pode aceitar arbitrariamente:

    C:\qualquer-arquivo

Ela deve garantir que o caminho pertence ao diretório permitido.

Aplicar a mesma regra para:

- LUTs;
- projetos;
- biblioteca;
- arquivos temporários;
- exportações.

---

# 25. Remote Debugging

O remote debugging deverá ser habilitado somente quando necessário
para desenvolvimento.

Não deixar uma porta de debugging aberta permanentemente em builds
de produção sem justificativa.

---

# 26. Biblioteca

A Library continuará sendo a fonte principal de mídia do BDS.

Ela deverá continuar responsável por:

- importação;
- organização;
- metadata;
- thumbnails;
- pesquisa;
- tags;
- monitoramento de pastas.

A arquitetura atual da Library é considerada uma das partes
mais sólidas do projeto.

---

# 27. Media Import Pipeline

A importação deverá evoluir para uma pipeline clara:

    Scan
      ↓
    Hash
      ↓
    Probe
      ↓
    Metadata
      ↓
    Thumbnail
      ↓
    Database

O processamento deverá utilizar concorrência controlada.

Não executar operações pesadas ilimitadamente em grandes bibliotecas.

---

# 28. Projects

Projects continuará sendo o núcleo organizacional de produção.

A relação conceitual deverá ser:

    Library
       ↓
    Project
       ↓
    Workspace

A mídia permanece na Library e é organizada/contextualizada dentro
do projeto.

---

# 29. BDSPro

O formato .bdspro deverá ser mantido.

Ele deverá se tornar o formato oficial de projeto portátil do BDS.

Estrutura futura poderá conter:

    manifest
    project.json
    metadata
    bins
    sequences
    sync data
    settings
    optional media

A mídia não precisa necessariamente ser incorporada ao pacote.

---

# 30. Project Workspace

O Workspace NÃO deverá se tornar um editor de vídeo completo.

O objetivo é:

- organizar mídia;
- visualizar arquivos;
- preparar material;
- sincronizar áudio;
- criar sequência;
- preparar exportação.

Não adicionar:

- edição NLE completa;
- timeline de edição tradicional;
- movimentação livre de clipes;
- sistema complexo de marcadores;
- efeitos de vídeo;
- transições.

---

# 31. Timeline

A timeline poderá continuar existindo como uma representação
temporal para:

- sincronização;
- organização;
- sequência;
- referência;
- exportação.

Ela não deve tentar competir com Premiere, DaVinci ou outros NLEs.

---

# 32. Audio Sync

O AudioSyncEngine é uma funcionalidade estratégica.

Deverá ser preservado e aprimorado.

Possível arquitetura:

    AudioSyncEngine
        ├── AudioAnalyzer
        ├── SyncDetector
        ├── OffsetCalculator
        └── SyncResult

O resultado da sincronização deverá ser independente do exportador.

---

# 33. Sequence Builder

SequenceBuilder deverá continuar representando uma sequência
independentemente do programa de edição.

Fluxo:

    Project
      ↓
    Sequence Model
      ↓
    Exporter
      ↓
    Premiere XML

Isso permite adicionar outros formatos no futuro.

---

# 34. Premiere Exporter

O PremiereExporter continuará sendo um adapter.

Não espalhar lógica específica de Premiere pelo projeto.

Futuramente poderão existir:

    PremiereExporter
    DaVinciExporter
    GenericXmlExporter
    ...

---

# 35. Silence Removal

O sistema de remoção de silêncio será mantido.

Ele deverá utilizar:

    AudioProcessingEngine

Possíveis módulos:

    SilenceDetector
    SilenceRemover
    AudioAnalyzer

---

# 36. Montage

O sistema de montagem automática será mantido separado do Workspace.

Responsabilidade:

- vídeo base;
- intro;
- inserções;
- regras de posição;
- finalização.

Não transformar Montage em editor.

---

# 37. Converter

O Converter continuará como ferramenta independente.

Estrutura conceitual:

    Tools
        ├── Downloader
        ├── Converter
        ├── Silence Removal
        └── Montage

---

# 38. Downloads

DownloadService continuará sendo responsável pela fila de downloads.

Adapters:

    YtDlpAdapter
    SpotDlAdapter

O DownloadService não deverá conhecer detalhes de cada ferramenta.

---

# 39. Job Engine

Criar futuramente um sistema centralizado de jobs.

    JobManager
        ├── DownloadJob
        ├── ConvertJob
        ├── ImportJob
        ├── ThumbnailJob
        ├── SilenceJob
        ├── MontageJob
        └── SyncJob

Cada job deverá possuir:

    id
    status
    progress
    startedAt
    finishedAt
    error
    cancel()

Isso permitirá uma experiência consistente de progresso,
cancelamento e processamento em segundo plano.

---

# 40. Performance

Prioridades:

- cache de thumbnails;
- cache de waveform;
- reduzir probes duplicados;
- controlar concorrência;
- evitar processamento desnecessário;
- reduzir operações pesadas no renderer;
- avaliar consumo do SQL.js;
- evitar carregamento excessivo de dados.

---

# 41. Banco de dados

SQL.js será mantido inicialmente.

Não realizar migração de banco apenas por questão arquitetural.

Primeiro medir:

- RAM;
- tamanho do banco;
- tempo de inicialização;
- frequência de persistência;
- performance em bibliotecas grandes.

---

# 42. BDSM

A integração com o BDSM deverá ser tratada como uma integração oficial.

Estrutura:

    src/core/integrations/bdsm/

Possíveis componentes:

    BdsmClient
    LutSyncService
    BdsmProtocol
    BdsmDeviceProvider

---

# 43. BDS + BDSM

A integração futura deverá permitir comunicação de:

- projetos;
- mídia;
- LUTs;
- metadata;
- sincronização;
- dispositivos;
- informações de gravação.

Não criar um protocolo excessivamente complexo inicialmente.

Primeiro definir contratos claros.

---

# 44. Modelo futuro BDS + BDSM

    BDS
    │
    ├── Project Core
    ├── Media Core
    ├── Sync Core
    ├── Export Core
    │
    └──── Common Protocol ──── BDSM
                                │
                                ├── Camera
                                ├── Recording
                                ├── LUT
                                └── Monitoring

---

# 45. Compatibilidade Windows

Windows continuará sendo suportado durante toda a migração.

Nenhuma alteração de arquitetura deve quebrar o comportamento atual
sem necessidade.

A estratégia é:

    Windows atual
         ↓
    refatoração
         ↓
    Windows funcionando
         +
    Linux funcionando

---

# 46. Linux

A implementação Linux deverá ocorrer depois da criação das
abstrações multiplataforma.

Ordem:

1. PathService
2. ExternalTools
3. ToolRunner
4. FFmpeg
5. FFprobe
6. yt-dlp
7. spotDL
8. UpdateService
9. Cancelamento
10. MTP/USB
11. Build Linux
12. Testes completos

---

# 47. Ordem geral de desenvolvimento

## Fase 0 — Preparação

- backup;
- branch de desenvolvimento;
- documentação;
- testes de regressão;
- inventário de dependências.

## Fase 1 — Fundação multiplataforma

- PathService;
- ExternalToolsManager;
- ToolResolver;
- ToolRunner;
- ToolManifest.

## Fase 2 — Ferramentas externas

- FFmpeg;
- FFprobe;
- yt-dlp;
- spotDL.

## Fase 3 — Processos

- cancelamento;
- timeout;
- logs;
- erros;
- progresso.

## Fase 4 — Sistema operacional

- MTP;
- USB;
- ADB;
- Device Discovery.

## Fase 5 — Linux

- build;
- empacotamento;
- testes;
- correções.

## Fase 6 — Refatoração interna

- main.js;
- preload;
- IPC;
- renderer;
- services.

## Fase 7 — Performance

- cache;
- jobs;
- concorrência;
- database.

## Fase 8 — Workspace

- organização;
- sync;
- sequência;
- export.

## Fase 9 — BDSM

- protocolo;
- sincronização;
- LUT;
- dispositivos.

## Fase 10 — Kotlin

Somente após a arquitetura estar estabilizada.

---

# 48. Prioridades

## P0 — Crítico

- ExternalTools;
- ToolRunner;
- PathService;
- remover caminhos hardcoded;
- FFmpeg multiplataforma;
- FFprobe multiplataforma;
- yt-dlp multiplataforma;
- spotDL multiplataforma;
- cancelamento multiplataforma.

## P1 — Alta

- UpdateService;
- MTP;
- USB;
- Device Discovery;
- Linux build;
- main.js;
- JobManager.

## P2 — Média

- Workspace;
- AudioSync;
- Sequence Builder;
- BDSPro;
- BDSM Protocol;
- performance.

## P3 — Futuro

- migração parcial ou total para Kotlin;
- macOS;
- novos exporters;
- novos dispositivos.

---

# 49. Funcionalidades que serão mantidas

- Biblioteca;
- Projetos;
- BDSPro;
- Workspace;
- Downloads;
- yt-dlp;
- spotDL;
- FFmpeg;
- FFprobe;
- Converter;
- Silence Removal;
- Montage;
- Audio Sync;
- Sequence Builder;
- Premiere Exporter;
- LUTs;
- Upload;
- Devices;
- BDSM integration.

---

# 50. Funcionalidades/código a serem removidos ou substituídos

Não remover funcionalidades do produto sem análise de uso.

Prioridade para remoção:

- caminhos hardcoded;
- lógica Windows espalhada;
- chamadas diretas a taskkill;
- resolução duplicada de executáveis;
- código legado sem uso;
- implementações duplicadas;
- dependências desnecessárias.

---

# 51. Regras arquiteturais

## Regra 1

Core não deve conhecer o sistema operacional.

## Regra 2

Serviços não devem conhecer caminhos de executáveis.

## Regra 3

Renderer não deve conter regra de negócio.

## Regra 4

IPC deve validar entradas.

## Regra 5

Processos externos devem passar pelo ToolRunner.

## Regra 6

Plataforma deve ser tratada por adapters/providers.

## Regra 7

Não duplicar sistemas existentes.

## Regra 8

Não criar funcionalidades apenas para justificar uma nova arquitetura.

## Regra 9

Windows deve continuar funcionando.

## Regra 10

O BDS não deve virar um editor de vídeo completo.

---

# 52. Critérios para considerar a arquitetura multiplataforma pronta

O BDS será considerado preparado para multiplataforma quando:

- nenhum serviço depender diretamente de .exe;
- FFmpeg funcionar no Windows e Linux;
- FFprobe funcionar no Windows e Linux;
- yt-dlp funcionar no Windows e Linux;
- spotDL funcionar no Windows e Linux;
- não existirem caminhos pessoais hardcoded;
- não existirem comandos Windows espalhados pelo Core;
- cancelamento funcionar nas duas plataformas;
- biblioteca funcionar nas duas plataformas;
- projetos funcionarem nas duas plataformas;
- processamento de mídia funcionar nas duas plataformas;
- build Linux estiver automatizado;
- Windows continuar funcional.

---

# 53. Critérios para futura migração Kotlin

A migração para Kotlin somente deverá ser considerada quando:

- Core estiver desacoplado;
- interfaces estiverem bem definidas;
- serviços estiverem independentes do Electron;
- contratos de dados estiverem documentados;
- ExternalTools estiver isolado;
- Project Core estiver isolado;
- Media Core estiver isolado;
- Sync Core estiver isolado;
- integração BDSM estiver baseada em protocolos.

A migração poderá então ser feita gradualmente.

---

# 54. Visão de longo prazo

O BDS deverá evoluir para uma plataforma modular de produção audiovisual.

    Braga Digital Studio
             │
    ┌────────┼─────────┐
    │        │         │
 Library  Projects   Tools
    │        │         │
    │    Workspace     │
    │        │         │
    └────────┼─────────┘
             │
          Media Core
             │
       Processing Core
             │
       External Tools
             │
    ┌────────┴────────┐
    │                 │
 Windows             Linux
    │                 │
    └────────┬────────┘
             │
          BDSM
             │
        Android

---

# 55. Princípio final

O objetivo não é transformar o BDS em um projeto tecnicamente
complexo apenas por ser complexo.

O objetivo é:

- código mais previsível;
- código mais fácil de manter;
- menos dependência do Windows;
- maior estabilidade;
- melhor desempenho;
- facilidade de adicionar recursos;
- possibilidade real de Linux;
- integração sólida com BDSM;
- possibilidade futura de Kotlin.

A regra principal:

> Primeiro desacoplar. Depois tornar multiplataforma.
> Depois estabilizar. Só então considerar uma migração de linguagem.