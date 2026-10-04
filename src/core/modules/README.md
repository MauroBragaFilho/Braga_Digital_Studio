# Módulos opcionais do BDS

Recursos que o usuário instala **só se quiser** (hoje: Whisper, para legendas e transcrição).
O BDS funciona normalmente sem nenhum deles. Código em `src/core/modules/`, IPC em
`src/ipc/moduleHandlers.js`, painel de instalação em `renderer/components/modules-panel.js`
(Configurações → Transcrição) e tela de uso em `renderer/screens/transcription.*`.

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

`-bs 1 -bo 1 -mc 0 -dtw <modelo> -nfa -l pt -ojf -t <metade dos núcleos lógicos>`

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

Antes do whisper, o ffmpeg (`silencedetect`: -35 dB, silêncios de 1,5 s ou mais) marca os trechos sem fala e o
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
- **Modelos**: tamanho e SHA-256 vêm da API do Hugging Face na hora do download (a revisão é fixada).
- A aceleração NVIDIA exige aceitar a licença da NVIDIA e o motor instalado (serve de reserva se a placa falhar).
  Requer driver 551 ou mais novo (CUDA 12.4). Não há versão para AMD/Intel: nelas o motor roda na CPU.
- O download é retomável (`.part`), confere o SHA-256 e é cancelável (`FileDownloader.js`).

### Atualizar a versão do whisper.cpp

1. Em <https://github.com/ggml-org/whisper.cpp/releases> escolha uma tag **`bNNNN`** (as tags `vX.Y.Z` não trazem binários).
2. Copie o `sha256:` e o tamanho de cada pacote da tabela em `sources.js` (`whisper-bin-x64.zip`, `whisper-bin-win-cpu-arm64.zip`,
   `whisper-bin-ubuntu-x64.tar.gz`, `whisper-bin-ubuntu-arm64.tar.gz` e `whisper-cublas-12.4.0-bin-x64.zip`, ou a versão de CUDA nova).
   Por sistema: Windows x64/arm64 e Linux x64/arm64 têm motor (CPU); a aceleração NVIDIA só existe para Windows x64; **macOS não tem
   pacote oficial** (a release só traz um xcframework) e aparece como "indisponível neste sistema" (`engine.available:false` +
   `unavailableReason` em `getStatus()`). Combinação sem entrada na tabela = indisponível, nunca binário errado.
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

Instalar de um `.zip` local também é possível (Configurações → Motor → "Instalar de um .zip"): serve o
`whisper-bin-x64.zip` baixado à mão, para uso sem internet.

## Legendas e análise por IA (código do próprio BDS)

- **Divisão de legendas** — `src/core/transcription/subtitles.js`: transforma palavras com tempo em `.srt`
  (pontuação, pausas, limite de palavras/linhas, sem terminar em "de", "o", "que"…) e monta o `.md`. É a porta
  em JavaScript do `legendar.py` do projeto "Whisper + LM Studio", e `tests/subtitles.test.js` confere que a
  saída é **idêntica** à do Python (arquivo dourado `tests/fixtures/subtitles-golden.json`, gerado pelo próprio
  `legendar.py`).
- **Análise com IA (opcional)** — `src/services/ai/transcriptAnalysis.js` (tarefa `analyzeTranscript`) e
  `analyzeFile.js`. Pega o `.md` (ou `.srt`) de uma transcrição e grava `<nome>.analise.md` ao lado, com resumo,
  principais assuntos, pontos importantes e trechos relevantes (mesmo prompt do projeto "Whisper + LM Studio").
  Transcrição longa é dividida por tempo (~8 mil caracteres por parte), cada parte é analisada e as análises são
  unidas em grupos até sobrar uma. Usa o servidor de IA configurado (LM Studio, Ollama, OpenAI…) em
  Configurações → Inteligência Artificial → *Servidor de IA*; é **opcional e vem desligada** na tela de Transcrição, e a
  tela avisa quando o texto sairia do computador. IPC: `ai:analyzeTranscript` / `ai:cancelAnalysis` e o evento
  `ai:analysisProgress` (uma análise por vez; cancelar derruba a requisição ao servidor).

## Adicionar outro módulo no futuro

Cada módulo teria seu próprio gerenciador de estado/instalação (como `ModuleManager` para o Whisper),
reutilizando `FileDownloader` (retomada, SHA-256, cancelamento), `ZipExtractor` e `sources`.

## Sistema de módulos (ligar/desligar recursos)

Em Configurações → Módulos o usuário liga/desliga recursos; desligado, o recurso some do menu lateral,
dos cartões da Home e dos atalhos (Ctrl+N) e qualquer navegação a ele volta para a Home. **Não se baixa
código de telas**: o módulo controla visibilidade e, quando há (`hasEngine`), o motor pesado.

- `ModuleRegistry.js`: definições (`id`, `title`, `description`, `screens[]`, `devOnly`, `defaultEnabled`,
  `hasEngine`, `order`) e funções puras `resolveEnabled(settings, { isDev })`, `isEnabled`, `sanitizeEnabledModules`.
  O slot `EXTRA_MODULES` (vazio) é onde entram módulos futuros; vazio, nada aparece na interface.
- Estado em `settings.enabledModules` (`{ id: boolean }`). Chave ausente = padrão do módulo = **desligado**
  (instalação nova começa com tudo desligado). Migração única em `SettingsManager._migrateModules`, controlada
  por `modulesMigrated`: se não havia `enabledModules` e já existia um `settings.json` (instalação anterior),
  grava Transcrição, Metadados e Remover Silêncios ligados para ninguém perder recursos; instalação nova
  (sem `settings.json`) grava a flag sem ligar nada; depois disso a escolha do usuário nunca é sobrescrita.
  Módulos `devOnly` (Assistente de IA, Montagem, Recuperar) só existem em desenvolvimento. O módulo `ai` não tem tela (`screens: []`): ele controla o botão flutuante do assistente (`renderer/components/ai-assistant.js`).
- Motor sob demanda: o que é pesado é o motor/binário, baixado na ativação. Ao ligar um módulo com
  `hasEngine` e motor ausente, Configurações → Módulos pergunta antes de instalar: Transcrição abre o painel do
  motor Whisper (`engine: 'whisper'`); Recuperar (`engine: 'tool:untrunc'`) baixa o motor de recuperação via
  `updates:updateTool`. Untrunc, Deno e spotDL são `onDemand` no `DependencyManager`: ausentes, não entram em
  `hasUpdates` nem em "Atualizar tudo"; instalados, continuam sendo atualizados.
- Configurações → Inteligência Artificial (servidor de IA: endereço, modelo, chave, teste de conexão) aparece
  quando Transcrição OU Assistente de IA está ligado; a tela de Transcrição só lê essa configuração.
- IPC (`moduleHandlers.js`): `modules:list` (estado, `installed`, `available`), `modules:setEnabled(id, enabled)`
  e evento `modules:changed`. Desligar um módulo com tarefa em andamento a cancela (transcrição, silêncios,
  metadados). O main é a fonte da verdade; `renderer/app.js` aplica o resultado.
