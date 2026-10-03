# Módulos opcionais do BDS

Recursos que o usuário instala **só se quiser** (hoje: Whisper, para legendas e transcrição).
O BDS funciona normalmente sem nenhum deles. Código em `src/core/modules/`, IPC em
`src/ipc/moduleHandlers.js`, painel de instalação em `renderer/components/modules-panel.js` (Configurações → Transcrição) e tela de uso em `renderer/screens/transcription.*`.

## O que é baixado, e de onde

| Parte | Fonte | Quem publica |
|---|---|---|
| Motor (`WhisperLegendas.exe` + dependências) | `manifestUrl` (ou um `.zip` local) | **você** |
| Modelos (tiny, base, small, medium, large-v3-turbo, large-v3) | Hugging Face, repositórios faster-whisper | oficial |
| GPU (cuBLAS + cuDNN) | `developer.download.nvidia.com` (manifestos `redistrib`) | NVIDIA |

Tamanhos e SHA-256 de modelos e CUDA vêm da própria fonte na hora da instalação (nada fica fixo
no BDS), e o download só é aceito se o hash conferir. O CUDA exige o usuário aceitar a licença
da NVIDIA na tela. Versões do CUDA fixadas em `sources.js` (`CUDA_PLAN`): cuBLAS 12.9.2 e
cuDNN 9.27.0 (CUDA 12) — as mesmas DLLs que o motor foi construído para usar.

## Pastas (em `<dataDir>/modules`)

```
modules.json                estado (versões, modelo ativo, datas)
whisper/engine/             motor
whisper/models/<id>/        um modelo por pasta
whisper/cuda/               DLLs do CUDA
```

## Contrato com o motor (já compatível com o WhisperLegendas atual)

O BDS executa:

```
WhisperLegendas.exe --cli jobs [--srt] [--md] [--cpu] [--saida DIR] [--palavras N] <arquivos...>
```

com estas variáveis de ambiente:

| Variável | Uso |
|---|---|
| `WL_MODEL_DIR` | pasta do modelo escolhido (com `model.bin`) |
| `WL_CUDA_DIR` | pasta das DLLs do CUDA (só quando instalado e sem `--cpu`) |
| `WL_FORCE_CPU` | `1` força a CPU |
| `WL_LOG` | arquivo onde o motor grava o progresso |

Formato do log (uma linha por evento): `[progress] 12.5`, `[status] texto`, `[device] GPU (CUDA)`,
`[line] texto`, e no fim `RESULTADO ok=N falhas=M [dispositivo]`. Erros: `ERRO: ...`. Cancelar =
o BDS encerra o processo. Saídas: `<nome>.srt` / `<nome>.md` (com ` (2)` se já existir).

## Como publicar o motor

1. Gere o `.zip` com **somente o motor**: o `.exe` e a pasta `_internal`. **Sem** as pastas
   `modelo`, `cuda`, `deno` e `ytdlp` (modelo e CUDA vêm das fontes oficiais; o BDS já tem yt-dlp/deno).
   O `.exe` pode estar na raiz do zip ou dentro de uma única pasta.
2. Calcule o SHA-256 do zip e publique o arquivo (GitHub Releases, por exemplo; limite de 2 GB por arquivo).
3. Publique um `manifest.json` (GitHub Pages ou qualquer hospedagem estática) e coloque a URL dele em
   `src/config/modules.config.json` → `manifestUrl`:

```json
{
  "schema": 1,
  "modules": {
    "whisper": {
      "version": "1.0.0",
      "apiVersion": 1,
      "platform": {
        "win32": {
          "url": "https://.../WhisperLegendas-motor-1.0.0.zip",
          "sha256": "<sha256 do zip>",
          "size": 245000000,
          "exe": "WhisperLegendas.exe"
        }
      }
    }
  }
}
```

`apiVersion` maior do que o suportado pelo BDS (`MODULE_API_VERSION`) faz o BDS recusar o motor e
pedir atualização do próprio BDS. Enquanto `manifestUrl` estiver vazio, o motor só instala a partir
de um `.zip` escolhido na tela.

## Adicionar outro módulo no futuro

Cada módulo teria seu próprio gerenciador de estado/instalação (como `ModuleManager` para o Whisper),
reutilizando `FileDownloader` (retomada, SHA-256, cancelamento), `ZipExtractor` e `sources`.
Não é preciso um repositório por módulo: um repositório de módulos com uma release por módulo e um
único `manifest.json` serve para todos.
