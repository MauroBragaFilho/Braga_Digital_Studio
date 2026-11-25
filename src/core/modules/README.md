# Módulos opcionais do BDS

Recursos que o usuário instala **só se quiser**. Hoje há dois componentes pesados, baixados sob demanda para
`<dataDir>/modules`: o **Whisper** (legendas e transcrição) e o **modelo local de IA** (`llama-server` e um modelo Qwen).
O BDS funciona normalmente sem nenhum deles. Código em `src/core/modules/` (`ModuleManager.js` para o Whisper e `LocalLlm.js`
para o modelo local), IPC em `src/ipc/moduleHandlers.js` (Whisper) e `src/ipc/aiHandlers.js` (modelo local), painel de instalação
do Whisper em `renderer/components/modules-panel.js` (Configurações → Inteligência Artificial → Neste computador) e tela de uso em
`renderer/screens/transcription.*`. O modelo local tem uma seção própria mais abaixo.

## Como funciona o motor de transcrição

O motor é do BDS: ele **não depende de Python nem de programa externo nosso**. Usa o
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) e faz o resto em JavaScript:

```
vídeo/áudio ──ffmpeg do BDS──▶ WAV 16 kHz ──whisper-cli──▶ JSON (trechos + tokens com tempo)
                                                              │
        whisperCppOutput.js  (tokens → palavras com tempo)  ◀─┘
                 │
        subtitles.js  ──▶ <nome>.srt (divisão de legendas)   e   <nome>.md (transcrição com tempo)
```

- `WhisperCppRunner.js`: executa o fluxo por arquivo, com progresso, cancelamento e erro por arquivo.
  Nunca sobrescreve (`aula (2).srt`). Se a GPU falhar, repete na CPU e não insiste nos próximos arquivos.
- `src/core/transcription/whisperCppOutput.js`: lê o JSON (`-ojf`) e monta as palavras.
- `src/core/transcription/subtitles.js`: divisão em legendas (porta do `legendar.py`, idêntica em 60 casos
  de teste) e o `.md` no formato do `transcrever.py`.

### Configuração do `whisper-cli` (medida, não chutada)

`-bs 1 -bo 1 -mc 0 -dtw <modelo> -nfa -l pt -ojf -t <metade dos núcleos lógicos>` (mais `-pp` e, sem o motor de CPU
instalado, `-ng`; `-t` fica entre 2 e 8)

| Opção | Por quê |
|---|---|
| `-bs 1 -bo 1` | beam 1, como o faster-whisper que era usado antes. Com o padrão (beam 5) levou 197 s num áudio de 175 s; com beam 1, 34 s |
| `-mc 0` | não usar o texto anterior como contexto (o `condition_on_previous_text=False` de antes). Sem isso, junto do DTW, uma frase inteira foi perdida |
| `-dtw <modelo>` | alinhamento por DTW: dá o **fim** de cada palavra com a precisão do faster-whisper. O tempo por token (padrão) erra ~0,5 s na mediana |
| `-nfa` | o DTW não funciona com flash attention (o programa o desliga sozinho) |
| `-t` | metade dos núcleos lógicos. O whisper.cpp espera ocupado entre as etapas: com `-t` igual a quase todos os núcleos e outros programas abertos, o desempenho caiu a quase zero |

Medições (Windows 11, GTX 1650 4 GB, `large-v3-turbo` q5_0, áudio sintético em português com o tempo exato
de cada palavra conhecido pela voz do Windows; texto e tempo comparados com o faster-whisper):

| | whisper.cpp (DTW) | faster-whisper |
|---|---|---|
| Erro de palavras (aula contínua / aula com ruído) | 4,7% / 2,3% | 4,3% / 2,3% |
| Erro de tempo, mediana / p90 | 50 ms / 149 ms | 58 ms / 170 ms |
| Palavras a menos de 250 ms do tempo real | 100% | 93% |
| Palavras "inventadas" em trechos de ruído | 0 | 0 |
| Velocidade de processamento (turbo, GPU) | 5,3 a 5,9× tempo real | 4,2× tempo real |
| Carregar o modelo | 1 a 2 s | ~6 s |

Na CPU (i5-11300H, 4 threads, com DTW): `tiny` a ~8,8× e `base` a ~4,8× tempo real. O `large-v3-turbo` na CPU ficou
muito abaixo do tempo real: **só vale com a GPU**; na CPU use o `small` ou menor.
Os números foram medidos num notebook com outros programas rodando (antivírus, fabricante); numa máquina ociosa devem ser melhores.

### Caminhos com acento

O `whisper-cli.exe` oficial **não aceita acentos nem caracteres fora do ANSI nos argumentos** (trava ou diz que o
arquivo não existe). Por isso ele roda com a pasta de trabalho como diretório atual e recebe só nomes relativos
em ASCII (`-m ..\..\models\large-v3-turbo\model.bin -f audio.wav -of out`). A pasta de trabalho fica ao lado dos
modelos (`whisper/work`), de modo que o trecho com o nome do usuário do Windows fica sempre no caminho comum.
Se o modelo estiver em outro disco, o executor cria um atalho (hard link) ou, no pior caso, uma cópia.
Os caminhos reais (vídeo de origem, destino das legendas) ficam com o ffmpeg e o Node, que lidam bem com Unicode.

## Filtro de silêncio (`skipSilence`, ligado por padrão)

Antes do whisper, o ffmpeg (`silencedetect`; por padrão -35 dB e silêncios de 1,5 s ou mais, ajustáveis na tela e
validados por `sanitizeSilenceOptions`) marca os trechos sem fala e o
BDS monta um WAV só com a fala (`src/core/transcription/silenceTrim.js`). Isso acelera a transcrição e evita
frases inventadas em trecho mudo. Os tempos finais **não mudam**: depois do whisper, segmentos e palavras voltam
ao tempo do arquivo original por um mapa de tempo (`remapResult`).

- Cada trecho de fala ganha 0,3 s de folga nos dois lados; trechos vizinhos são mesclados.
- Só é usado se tirar pelo menos 10% do áudio ou 20 s; senão o WAV original segue. Áudio todo "silencioso" também
  segue inteiro (o limiar pode estar errado para uma gravação muito baixa).
- O corte copia as amostras PCM do WAV de trabalho em Node (exato por amostra, sem decodificar de novo e sem o
  limite de tamanho de comando do `filter_complex` com centenas de trechos).
- Falha na detecção ou no corte: aviso discreto ("Não foi possível ignorar os silêncios…") e a transcrição segue
  com o áudio inteiro. Cancelar vale também durante a detecção. O whisper-cli continua só com nomes relativos ASCII
  (`audio_fala.wav` na pasta de trabalho, apagada ao fim). O progresso do whisper é relativo ao áudio cortado.
- Na tela: Avançado → "Ignorar trechos sem fala". Pela API: `skipSilence: false` desliga.
- Medição real (motor b5130 na CPU, modelo base, 110 s com 74 s mudos): 104 s sem o filtro (e uma frase perdida
  mais um "[MÚSICA DE FUNDO]" inventado no silêncio) contra 16,5 s com o filtro; os inícios das legendas em comum
  diferem menos de 0,4 s.

## O que é baixado, e de onde

| Parte | Fonte | Tamanho |
|---|---|---|
| Motor (CPU) | release oficial `ggml-org/whisper.cpp` no GitHub (`whisper-bin-x64.zip`) | ~8 MB |
| Aceleração NVIDIA | mesma release (`whisper-cublas-12.4.0-bin-x64.zip`, já com as DLLs da NVIDIA) | ~640 MB |
| Modelos (tiny, base, small, medium, large-v3-turbo, large-v3 — versões q5) | Hugging Face `ggerganov/whisper.cpp` | 31 MB a 1 GB |

- **Motor e aceleração** são fixados em `sources.js` (`WHISPER_CPP_RELEASE`: tag, tamanho e SHA-256). Só o arquivo
  exato que foi testado é aceito. Nada é redistribuído pelo BDS.
- **Modelos**: tamanho, SHA-256 e revisão vêm da API do Hugging Face na hora do download, e a revisão lida é a usada na
  URL do arquivo. Sem o hash, a instalação é recusada (`NO_CHECKSUM`). (No modelo local de IA, ao contrário, a revisão e o
  SHA-256 ficam fixados no código.)
- A aceleração NVIDIA exige aceitar a licença da NVIDIA e o motor instalado (serve de reserva se a placa falhar).
  Requer driver 551 ou mais novo (CUDA 12.4). Não há versão para AMD/Intel: nelas o motor roda na CPU.
- O download é retomável (`.part`), confere o SHA-256 e é cancelável (`FileDownloader.js`).

### Atualizar a versão do whisper.cpp

1. Em <https://github.com/ggml-org/whisper.cpp/releases> escolha uma tag **`bNNNN`** (as tags `vX.Y.Z` não trazem binários).
2. Copie o `sha256:` e o tamanho de cada pacote da tabela em `sources.js` (`whisper-bin-x64.zip`, `whisper-bin-win-cpu-arm64.zip`,
   `whisper-bin-ubuntu-x64.tar.gz`, `whisper-bin-ubuntu-arm64.tar.gz` e `whisper-cublas-12.4.0-bin-x64.zip`, ou a versão de CUDA nova).
   Por sistema: Windows x64/arm64 e Linux x64/arm64 têm motor (CPU); a aceleração NVIDIA só existe para Windows x64; **macOS não tem
   pacote oficial** (a release só traz um xcframework) e aparece como "indisponível neste sistema"
   (`whisper.engine.available: false` + `whisper.engine.unavailableReason` em `getStatus()`; a CUDA tem os mesmos campos em `whisper.cuda`). Combinação sem entrada na tabela = indisponível, nunca binário errado.
3. Troque `WHISPER_CPP_RELEASE` em `src/core/modules/sources.js` e rode a validação de precisão (os flags acima
   dependem da versão: confira `whisper-cli -h`).

## Pastas (em `<dataDir>/modules`)

```
modules.json                 estado (versões, modelo ativo, datas)
whisper/engine/              motor para CPU (whisper-cli.exe + DLLs)
whisper/cuda/                motor para NVIDIA (whisper-cli.exe + ggml-cuda.dll + bibliotecas CUDA)
whisper/models/<id>/model.bin   um modelo ggml por pasta
whisper/work/                temporários de cada transcrição (apagados ao terminar)
```

Instalar de um pacote local também é possível (Configurações → Inteligência Artificial → Neste computador → "Usar um
arquivo…"): serve o `whisper-bin-x64.zip` baixado à mão, para uso sem internet. O SHA-256 do pacote é conferido contra o
fixado em `sources.js`; se não bater, só instala depois de uma confirmação explícita ("Instalar mesmo assim"), senão o erro é
`UNOFFICIAL_ZIP`. O código aceita também `.tar.gz`/`.tgz`, mas a janela de escolha do painel filtra só `.zip`.

## Legendas e análise por IA (código do próprio BDS)

- **Divisão de legendas** — `src/core/transcription/subtitles.js`: transforma palavras com tempo em `.srt`
  (pontuação, pausas, limite de palavras/linhas, sem terminar em "de", "o", "que"…) e monta o `.md`. É a porta
  em JavaScript do `legendar.py` do projeto "Whisper + LM Studio", e `tests/subtitles.test.js` confere que a
  saída é **idêntica** à do Python (arquivo dourado `tests/fixtures/subtitles-golden.json`, gerado pelo próprio
  `legendar.py`).
- **Análise com IA (opcional)** — `src/services/ai/transcriptAnalysis.js` (tarefa `analyzeTranscript`) e
  `analyzeFile.js`. Pega o `.md`, `.srt`, `.vtt` ou `.txt` de uma transcrição (até 5 MB) e grava `<nome>.analise.md` ao lado, com
  resumo, principais assuntos, pontos importantes e trechos relevantes (mesmo prompt do projeto "Whisper + LM Studio").
  Transcrição longa é dividida por tempo (~6,5 mil caracteres por parte, ajustável de 2 mil a 15 mil), cada parte é analisada e
  as análises são unidas em grupos até sobrar uma. Usa o provedor de chat configurado (o modelo local do app, LM Studio, Ollama,
  OpenAI…) em Configurações → Inteligência Artificial → Provedores; é **opcional e vem desligada** na tela de Transcrição, e a
  tela avisa quando o texto sairia do computador. IPC: `ai:analyzeTranscript` / `ai:cancelAnalysis` e o evento
  `ai:analysisProgress` (uma análise por vez; cancelar derruba a requisição ao servidor).

## Adicionar outro módulo no futuro

Um módulo novo é, no mínimo, uma definição no `ModuleRegistry.js` (`BASE_MODULES` ou o slot `EXTRA_MODULES`). O resto é opcional:

1. Definição com `id`, `title`, `description`, `screens`, `devOnly`, `defaultEnabled`, `hasEngine`, `engine` (se houver) e `order`.
2. O `data-view` da tela no menu do `renderer/index.html`.
3. Tarefas de fundo: entrada em `HOOKS[id]` em `src/bootstrap/moduleRuntime.js` (`start`/`stop`).
4. Serviço criado só no primeiro uso: `lazyService` em `src/bootstrap/services.js`.
5. Cancelar ao desligar: entrada em `tasks[id]` em `src/ipc/index.js`.
6. Cartões das Configurações com `data-module="<id>"` em `settings.html`.
7. Telas e ferramentas do assistente: `src/services/ai/screens.js` e `renderer/utils/assistantContext.js` (campo `module`).
8. Testes em `tests/module-registry.test.js` e `tests/modules-migration.test.js`.

Módulo novo **não** entra em `CORE_SCREEN_MODULE_IDS` (chave ausente = padrão do módulo). Se precisar baixar algo, o gerenciador
de instalação reaproveita `FileDownloader` (retomada, SHA-256, cancelamento), `ZipExtractor` e `sources`, como fazem o
`ModuleManager` (Whisper) e o `LocalLlm` (modelo local).

## Sistema de módulos (ligar/desligar recursos)

**Todas as telas, exceto Home e Configurações, são módulos**: Downloads, Conversor, Biblioteca, Projetos (com a área de
trabalho, que inclui "Remover silêncio" na aba Arquivos), Envio, Dispositivos, LUTs, Transcrição, Metadados, mais Recuperar e
Montagem (desenvolvimento) e o Assistente de IA (sem tela): 12 módulos. Remover silêncio já foi um módulo com tela própria;
hoje é uma função de Projetos (`renderer/screens/workspace/silence.js`) e não tem interruptor. Em Configurações → Módulos o usuário liga/desliga cada um; desligado, o recurso some do menu
lateral, dos cartões da Home, dos atalhos (Ctrl+N), das opções de tela inicial, dos cartões das Configurações
(`[data-module="<id>"]` em `settings.html`) e das ferramentas/telas do assistente, e qualquer navegação a ele volta para a Home.
A pesquisa do topo e o contador de mídias dependem da Biblioteca. As abas ficam ocultas até o main informar o estado
(fail-closed; a tela inicial espera até 3 s por isso) e, se a lista de módulos não puder ser lida, as telas principais aparecem.

- `ModuleRegistry.js`: definições (`id`, `title`, `description`, `screens[]`, `devOnly`, `defaultEnabled`,
  `hasEngine`, `engine`, `order`) e funções puras `resolveEnabled(settings, { isDev })`, `isEnabled`, `getModule`,
  `isKnownId`, `moduleForScreen`, `sanitizeEnabledModules` (descarta ids desconhecidos ao salvar, como o antigo `silence`);
  `CORE_SCREEN_MODULE_IDS` lista os 7 módulos de tela criados em 2026-10-05.
  O slot `EXTRA_MODULES` (vazio) é onde entram módulos futuros; vazio, nada aparece na interface.
- Estado em `settings.enabledModules` (`{ id: boolean }`). Chave ausente = padrão do módulo = **desligado**
  (instalação nova começa só com Home, Configurações e o Assistente de IA). Duas migrações únicas em
  `SettingsManager`, que nunca sobrescrevem uma escolha já gravada: `_migrateModules` (`modulesMigrated`) liga
  Transcrição e Metadados para quem tinha um `settings.json` anterior ao sistema de módulos (o mesmo conjunto é aplicado quando o
  `settings.json` está ilegível: o arquivo ruim é renomeado para `.corrupt-<data>` e o que a pessoa usava é mantido);
  `_migrateScreenModules` (`screenModulesMigrated`) liga as 7 telas principais para quem já usava o app quando elas
  viraram módulos (ninguém perde tela). Instalação nova grava as duas flags sem ligar nada.
  Módulos `devOnly` (Montagem, Recuperar) só existem em desenvolvimento. O módulo `ai` não tem tela (`screens: []`): ele controla o botão flutuante do assistente (`renderer/components/ai-assistant.js`).
- **Processo principal sob demanda** (`src/bootstrap/moduleRuntime.js` e `src/core/modules/lazyService.js`): os serviços
  dos módulos (downloads, conversor, miniaturas, exportadores e sequenciador de Projetos, ondas de áudio, sincronia de áudio,
  sincronização de LUTs, varredor do Envio) são criados no primeiro uso, e as tarefas de fundo (monitoramento da Biblioteca
  e regeneração de miniaturas, descoberta de dispositivos/pareamento/câmeras Sony, lembretes de prazo dos Projetos,
  limpeza de temporários das LUTs, yt-dlp dos Downloads) só começam com o módulo ligado e começam/param ao ligar/desligar em Configurações, sem
  reiniciar. Os handlers IPC continuam sempre registrados (o preload os expõe); o banco, a fila de importação e o histórico
  são núcleo. A sondagem de armazenamento da sidebar só enumera dispositivos MTP/USB com o módulo Dispositivos ligado.
- Motor sob demanda: o que é pesado é o motor/binário, baixado na ativação. Ao ligar um módulo com
  `hasEngine` e motor ausente, Configurações → Módulos pergunta antes de instalar: Transcrição abre o painel do
  motor Whisper (`engine: 'whisper'`); Recuperar (`engine: 'tool:untrunc'`) baixa o motor de recuperação via
  `updates:updateTool` (se a fonte não publica checksum, pede uma confirmação extra antes). Untrunc, Deno e spotDL são `onDemand` no `DependencyManager`: ausentes, não entram em
  `hasUpdates` nem em "Atualizar tudo"; instalados, continuam sendo atualizados.
- Configurações → Inteligência Artificial (subabas Assistente, Provedores, Neste computador e Agentes externos) aparece
  quando Transcrição OU Assistente de IA está ligado; a tela de Transcrição só lê essa configuração.
- IPC (`moduleHandlers.js`): `modules:list` (id, título, descrição, telas, `devOnly`, `hasEngine`, `engine`, `enabled`,
  `installed`, `available`) e `modules:setEnabled(id, enabled)`, que também liga/desliga as tarefas de fundo
  (`moduleRuntime.toggle`; falha ali não desfaz o que foi salvo). O evento `modules:changed` leva o mapa `{ id: boolean }`.
  Os demais canais `modules:*` cuidam do Whisper: `getStatus`, `installEngine`, `uninstallEngine`, `installModel`,
  `removeModel`, `setActiveModel`, `installCuda`, `removeCuda`, `cancel`, `transcribe`, `cloudGet`, `cloudSet`, `cloudTest` e
  `reveal`, com os eventos `modules:progress` e `modules:status`. Desligar um módulo com tarefa em andamento a cancela
  (transcrição, downloads, conversor, metadados). O main é a fonte da verdade; `renderer/app.js` aplica o resultado.

## Modelo local de IA (`LocalLlm.js`)

O assistente pode usar um modelo que roda no próprio computador, sem internet depois de instalado. É o provedor `embedded`
("Modelo local do app"): um `llama-server` do llama.cpp escutando só em `127.0.0.1` (porta `EMBEDDED_PORT`, em
`src/services/ai/providers/presets.js`). Instalar, trocar e remover fica em Configurações → Inteligência Artificial →
Neste computador.

- **Servidor:** release oficial `ggml-org/llama.cpp` (tag `b12322`), com tamanho e SHA-256 fixados em `LocalLlm.js` para cada
  sistema (Windows x64/arm64, Linux x64/arm64, macOS arm64/x64). O pacote com placa de vídeo (Vulkan: NVIDIA, AMD e Intel, sem
  instalar CUDA) só existe para Windows x64.
- **Modelos** (Qwen, Apache 2.0, repositórios oficiais `Qwen/...-GGUF` no Hugging Face, revisão e SHA-256 fixados): o
  `qwen2.5-0.5b-instruct` (Q4_K_M, sem visão) e o Qwen3-VL 2B, 4B e 8B (Q4_K_M mais o projetor de imagem `mmproj` Q8_0, com
  visão). O primeiro da lista é o padrão.
- **Memória da placa (`llmMemory.js`):** lê a memória LIVRE (`nvidia-smi` nas NVIDIA; nas outras, o que o `llama-server
  --list-devices` informa), calcula o que cada modelo pede (pesos, projetor, cache do contexto e buffers) e só coloca na placa o
  que cabe, com folga de 8% da memória total (mínimo 512 MB); abaixo de 15% das camadas na placa, roda tudo no processador. Placas
  integradas não contam. A lista de modelos mostra o que cabe e `recommendId` indica o maior que cabe inteiro; a escolha é da pessoa.
- **Ciclo de vida:** o servidor liga na primeira pergunta e desliga depois de 10 minutos sem uso. Se a placa falhar ao
  ligar, tenta de novo uma vez e cai para o processador, gravando `runtime.json`; a placa volta a ser tentada depois de 1 h,
  6 h e 24 h (a marca vale por modelo).
- **Pastas** (em `<dataDir>/modules/llm`): `runtime/` (CPU), `runtime-gpu/` (Vulkan), `models/<id>/<arquivo>`, `choice.json`
  (modelo escolhido) e `runtime.json`.
- **IPC** (`aiHandlers.js`): `ai:localLlmStatus`, `ai:localLlmInstall(modelId?)`, `ai:localLlmSetModel`, `ai:localLlmCancel`,
  `ai:localLlmRemove` e o evento `ai:localLlmProgress`.
- **Atualizar:** troque a tag `bNNNN` e o tamanho e o SHA-256 de cada pacote em `LocalLlm.js` (mesmo procedimento do whisper.cpp).
- Testes: `tests/local-llm*.test.js`, `tests/llm-memory.test.js`, `tests/settings-local-llm-model.test.js`.

## Transcrição na nuvem (Groq, OpenAI e ElevenLabs), ordem e modo Automático

Além do motor local (whisper.cpp), a transcrição pode ser feita por um serviço de nuvem, escolhido no botão de status da tela
de transcrição. É opcional e desligado por padrão. As chaves ficam em `config/transcricao-nuvem.json`, criptografadas (Electron
`safeStorage`), uma por serviço, e nunca voltam para a interface (`modules:cloudGet` devolve só `hasKey` e `keySource`). Os
endereços são fixos (`api.groq.com`, `api.openai.com`, `api.elevenlabs.io`). **Chave compartilhada:** sem chave própria, o
serviço usa a do provedor de CHAT ligado que fala com exatamente o mesmo endereço (`AIService.keyForHost`; nunca para outro
endereço, nem com o aviso de servidor externo pendente); `keySource` diz `own` ou `chat`.

**Ordem e modo Automático** (Configurações → Inteligência Artificial → Provedores → Áudio): `transcriptionOrder` (todos os
motores, na ordem escolhida) e `transcriptionFallback` (os ligados), tratados em `src/core/transcription/order.js`. A tela de
Transcrição tem a opção **Automático** (`engine: 'auto'`): `modules:transcribe` monta `chain = autoEngines(settings)` e o
runner tenta cada motor pronto, nessa ordem. De fábrica só o local está ligado: o Automático nunca envia áudio sem o usuário
ligar um serviço (e confirmar na primeira vez).

- `src/core/transcription/CloudConfig.js`: chaves, modelo de cada serviço e teste da chave (`modules:cloudGet/Set/Test`).
- `CloudBase.js`: preparo do áudio (AAC mono via ffmpeg), envio com novas tentativas (429/5xx/rede) e mensagens de erro.
- `GroqTranscriber.js`: `Groq` e `OpenAI` (mesma API `/audio/transcriptions`): blocos de ~10 min, tempo por palavra e por trecho.
- `ElevenLabsTranscriber.js`: um envio só (Scribe, `/v1/speech-to-text`); os trechos são montados a partir das palavras.
- `WhisperCppRunner.run({ engine, fallback, chain })`: com `chain` (modo Automático), tenta os motores prontos nessa ordem; sem ela,
  o motor escolhido e, se ele falhar por causa do serviço (rede, limite, chave, créditos), os da lista `transcriptionFallback`
  na ordem escolhida. O formato de saída é o do
  whisper.cpp, então legendas, texto, corte de silêncio e tempos não mudam.
- **Privacidade:** com o motor local escolhido não há fallback para a nuvem (o áudio nunca sai do computador sem o usuário pedir).
  Ao escolher um serviço de nuvem pela primeira vez, a tela confirma que o áudio será enviado a ele.
- Não verificado com as contas reais: preços e limites do plano gratuito de cada serviço (confira nos sites) e o alinhamento por
  palavra em comparação com o local.
