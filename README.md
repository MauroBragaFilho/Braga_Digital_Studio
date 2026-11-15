# Braga Digital Studio (BDS) 🎬

[![Licença](https://img.shields.io/badge/Licen%C3%A7a-Uso%20gratuito-green.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![NodeJS](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

*[Read in English](README.en.md)*

Braga Digital Studio (anteriormente Braga Media Downloader) é uma central avançada e profissional para o gerenciamento, download, e organização de mídia digital. Desenvolvida especialmente para criadores de conteúdo, fotógrafos e videomakers, a ferramenta atua como o principal *hub* entre seus dispositivos de captação (Câmeras, Cartões SD, Drones) e seu fluxo de trabalho criativo.

## 📥 Baixar e instalar

O BDS é **gratuito**. Baixe o instalador mais recente na página de [Releases](../../releases) (`BragaDigitalStudioSetup.exe` para Windows 10/11 de 64 bits; também há `.AppImage` e `.deb` para Linux).

Na instalação você escolhe entre:

- **Instalação completa (recomendada):** instala o programa, baixa as ferramentas e o recurso de transcrição e deixa tudo pronto para usar.
- **Instalação curta:** instala o programa e as ferramentas básicas; a transcrição pode ser instalada depois em *Configurações → Módulos*.

Como o instalador ainda não tem assinatura digital, o Windows (SmartScreen) pode mostrar um aviso no primeiro uso: use "Mais informações → Executar assim mesmo". Cada release traz o SHA-256 do instalador. O programa avisa em *Configurações* quando há versão nova (a verificação ao abrir o app é opcional) e só instala depois da sua confirmação. Só a versão mais recente recebe correções, em regime de melhor esforço.

## 🚀 Principais Funcionalidades

- **Gerenciamento de Dispositivos de Captura:** 
  - Reconhecimento automático, rápido e seguro de dispositivos conectados via **MTP** (Media Transfer Protocol) para Câmeras/Celulares.
  - Leitura nativa de cartões SD e pendrives via **USB (Mass Storage)**.
  - Integração sem fio com **Câmeras Sony (Alpha/Cyber-shot)** via SSDP e Camera Remote API para telemetria de bateria/armazenamento e download com separação de RAW (.ARW), JPG e MP4.
  - Pareamento seguro com o **celular BDS** (código de 4 dígitos aprovado no aparelho), por USB ou Wi-Fi.
  - Importação de mídias de forma limpa, sem nunca sobrescrever arquivos existentes e ignorando pastas de sistema ocultas das câmeras.

- **Biblioteca e Projetos:** 
  - Biblioteca com janela virtual (milhares de arquivos sem travar), filtros, favoritos e preview de vídeo, áudio e foto.
  - Projetos com pastas, sequências e sincronização por áudio, exportação para o Premiere (XML) e o formato próprio `.bdspro`, com relink de arquivos ausentes.

- **Download Inteligente de Mídias:** 
  - Download acelerado de vídeo e áudio do YouTube e de centenas de outros sites, com pausa configurável entre os itens da fila.
  - Ao colar um link de um item dentro de uma playlist, o app pergunta se você quer só aquele item ou a playlist inteira.

- **Transcrição e legendas (módulo opcional):** 
  - Transcrição local, no seu computador (a nuvem é opcional e só é usada se você escolher), com saída em SRT, Markdown e TXT; filtro automático de trechos sem fala; aceleração por placa NVIDIA opcional.

- **Conversor, Remover Silêncio e Metadados:** ferramentas para converter mídia, cortar silêncios e editar tags e capas.

- **Painel de Color Grading (LUTs):**  (EM PROGRESSO)
  - Interface dedicada à estética cinematográfica para importação, visualização e gerenciamento de arquivos de perfis de cor `.cube`.
  - Simulação interativa e de altíssima performance de efeitos de cor com o recurso "Antes e Depois" (Slider Interativo) em tempo real, suportando imagens nativas.

- **Assistente de IA integrado:** 
  - Um botão flutuante (atalho **Ctrl + J**) abre um chat que conhece a sua biblioteca, os projetos e a tela em que você está, e pode transcrever, converter, remover silêncio, baixar um link, criar projetos e exportar. **Toda ação pede a sua confirmação antes de acontecer.**
  - Funciona com servidores que você escolhe: locais (LM Studio, Ollama) ou na internet (Groq, Qwen, OpenAI ou outro compatível), cada um com a sua chave, com troca automática para o próximo se um falhar. É opcional e pode ser desligado em *Configurações*.

- **Isolamento de Sessão Segura e Login Local:** 
  - Login isolado em janelas particionadas (`persist:youtube`): a sessão das plataformas fica numa partição própria do navegador embutido, separada do restante do app. O BDS não guarda a sua senha nem envia a sessão a nenhuma nuvem do autor. Usar a sua conta nos downloads do YouTube é opcional e vem desligado (*Configurações → Mídia*). Ligado, o app cria um arquivo de texto temporário com a sessão do YouTube só enquanto baixa e o apaga ao terminar; enquanto ele existe, quem usa o seu usuário do Windows consegue lê-lo, então use um computador de confiança. O botão *Sair e apagar a sessão* encerra o login e remove a sessão guardada.

- **Design de Interface:** 
  - Visual limpo, em tema escuro ou claro, com botões em pílula, acento vermelho e outras 4 cores à escolha, fontes Montserrat e Inter e contraste de acessibilidade (WCAG AA).
  - Cada recurso é um módulo que pode ser ligado ou desligado em *Configurações → Módulos*.

## 🛠️ Tecnologias Utilizadas

- **[Electron](https://www.electronjs.org/) / Node.js**: Motor responsável por fornecer os super-poderes nativos da aplicação para acesso a sistema de arquivos, child-processes e gerenciamento de sessões com segurança em sandbox.
- **[PowerShell](https://learn.microsoft.com/en-us/powershell/) (CIM/WMI)**: Motor utilizado invisivelmente no backend para gerenciar a cópia de mídia silenciosa e varredura de hardware.
- **JavaScript (Vanilla), HTML5 e CSS3**: Todo o *Frontend* do programa foi escrito do absoluto zero usando as tecnologias web essenciais, sem engordar o código com frameworks gigantes. Isso garante que as páginas carreguem em questão de milissegundos e utilizem pouquíssima RAM.
- **Componentes de terceiros baixados sob demanda** (FFmpeg, yt-dlp, whisper.cpp e outros), das releases públicas de cada projeto (o FFmpeg vem dos builds do projeto BtbN, porque o FFmpeg não publica binários) e conferidos por SHA-256 quando a fonte publica o hash. A lista completa, com versões e licenças, está em *Configurações → Sobre e licenças*.

## 📦 Instalação e Uso (Desenvolvimento)

> O código-fonte é reservado ao autor (veja a [licença](LICENSE)); esta seção vale para quem tem acesso ao repositório de desenvolvimento.

Certifique-se de ter o **Node.js** instalado na sua máquina (versão 22 ou superior).

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/MauroBragaFilho/Braga_Digital_Studio.git
   cd braga-digital-studio
   ```

2. **Instale as dependências essenciais:**
   ```bash
   npm install
   ```

3. **Inicie o servidor de testes do Electron:**
   ```bash
   npm start
   ```

   Atenção: em desenvolvimento o app grava `data/`, `database/` e `config/` na própria pasta do projeto. Para testar sem tocar nos seus dados, use `--user-data-dir` com uma pasta de teste.

## 🏭 Como Compilar (Gerar o Executável .exe)

Para transformar o projeto em um instalador fácil de distribuir para outros computadores Windows:

```bash
npm run build
```

Isso empacotará o código-fonte (os motores internos de mídia e download são baixados em runtime, não vão no instalador) e gerará o instalador final dentro da pasta `dist/` (cerca de 94 MB). O instalador é preto, em português, e pergunta se a instalação é curta ou completa. Detalhes, parâmetros de linha de comando (como `/S` e `/COMPONENTES=completa|curta|nenhuma`) e como testar com segurança estão em `.docs/INSTALADOR.md`.

## 🧪 Qualidade, Scripts e CI

| Script | O que faz |
|---|---|
| `npm start` | Abre o app em modo de desenvolvimento |
| `npm run check` | Valida a sintaxe de todos os `.js` (módulos ES no renderer) |
| `npm run lint` | ESLint (config flat em `eslint.config.js`) |
| `npm test` | Testes unitários (`node --test`, pasta `tests/`) |
| `npm run verify:package` | Garante que nenhum dado do usuário entra no pacote |
| `npm run verify:preload` | Confere se o `preload.js` (gerado) está igual ao que o gerador produz |
| `npm run generate:licenses` | Regenera a lista de licenças de terceiros |
| `npm run build` / `build:win` | Instalador Windows (NSIS) |
| `npm run build:win:portable` | Versão portable do Windows |
| `npm run build:linux` | AppImage + `.deb` (também `build:linux:appimage` e `build:linux:deb`) |

O workflow `.github/workflows/ci.yml` roda `npm ci`, `check`, `lint` e `test` em todo push/PR, em Linux e Windows. Os workflows de release rodam as mesmas verificações antes de compilar.

## 🚢 Versão e Release

A publicação é **automática**: a cada push na branch `main` o workflow **Release BDS (Windows + Linux)** compila os dois sistemas, calcula a versão (parte do `package.json`; se a tag já existir, usa a próxima de correção livre), cria a tag `vX.Y.Z` e publica uma única Release com os instaladores e os respectivos SHA-256. Depois ele registra a versão nova no `package.json` com um commit "chore(release) ... [skip release]".

- Para um commit **não** gerar release, coloque `[skip release]` na mensagem. Alterações só de documentação (`*.md`, `.docs/`, `LICENSE`) também não disparam.
- Para uma versão maior (minor/major), suba antes no `package.json`: `npm version minor --no-git-tag-version`.
- Também dá para rodar manualmente em Actions → "Release BDS (Windows + Linux)", ou enviar uma tag `v*` para usar os workflows individuais.

O instalador deve continuar se chamando `BragaDigitalStudioSetup.exe`: o atualizador interno procura esse nome de arquivo na Release. Os builds não são assinados digitalmente (o SmartScreen pode alertar no primeiro uso).

## 🧩 Módulos

Cada recurso do BDS é um módulo com um interruptor em *Configurações → Módulos*. Numa instalação nova só o Assistente de IA vem ligado; quem já usa o app mantém o que escolheu. Os recursos pesados, como a **Transcrição** (motor, modelos e DLLs da placa NVIDIA), são baixados sob demanda, com verificação de SHA-256, para `<dataDir>/modules`. Código em `src/core/modules/`, IPC em `src/ipc/moduleHandlers.js`, painel em `renderer/components/modules-panel.js`. Detalhes em [`src/core/modules/README.md`](src/core/modules/README.md).

## 🗂️ Estrutura de Pastas

```
main.js, preload.js      Processo principal e ponte segura (IPC); o preload é gerado
src/core/                Regras de negócio (mídia, biblioteca, dispositivos, módulos...)
src/infrastructure/      Ferramentas externas, filesystem, banco de dados
src/ipc/                 Handlers IPC, tabela de canais e validação de entradas
src/services/            Serviços de aplicação (downloads, conversão, assistente de IA...)
src/setup/               Modo sem janela usado pelo instalador (--setup-components)
src/config/              Configuração versionada (ex.: modules.config.json)
renderer/                Interface (JS vanilla, módulos ES; fontes em renderer/assets/fonts)
installer/               Script NSIS e imagens do instalador
config/                  Configuração local (ignorada); use os *.example.json como modelo
assets/                  Ícones do app e arquivo de licenças de terceiros
scripts/, tests/         Scripts de manutenção e testes automatizados
.github/workflows/       CI e release
```

## 🔒 Privacidade, Dados e Gitignore

Todos os dados que o programa gera (biblioteca, configurações, históricos, miniaturas) ficam no seu computador, em uma pasta local (`AppData`). O programa **não tem telemetria**, não exige conta e não envia a sua biblioteca nem os seus arquivos ao autor. Chaves de servidores de IA são guardadas criptografadas e nunca são exibidas de volta.

O que acessa a internet: verificação e download de atualizações (GitHub), das ferramentas e modelos (releases públicas de cada projeto e Hugging Face), os sites de onde você pedir para baixar e, **se você escolher**, a nuvem: o servidor de IA configurado, a transcrição em nuvem (o áudio vai ao provedor escolhido, Groq ou ElevenLabs) e a análise de transcrição por IA (o texto da transcrição vai ao servidor de IA). Com qualquer um deles, o conteúdo enviado sai do seu computador; por isso o app avisa antes da primeira vez. O servidor MCP, que vem desligado, só aceita conexões do próprio computador. Os relatórios de erro só são enviados se você escolher enviar.

Nenhuma informação sensível é salva neste repositório: banco de dados, caches, logs, pastas `data` e sessões de autenticação estão bloqueados pelas regras do `.gitignore`.

Encontrou uma falha de segurança? Veja a [Política de Segurança](SECURITY.md) e relate em particular, não numa issue pública.

## ⚖️ Direitos autorais e uso responsável

O BDS baixa os vídeos e áudios que **você** pedir, de sites que o programa não controla; o conteúdo continua sendo de quem detém os direitos. Baixe só o que você tem direito de baixar (conteúdo seu, de licença livre ou com autorização de quem o detém): respeitar os direitos autorais e os termos de cada site é responsabilidade de quem baixa. Músicas de serviços de streaming servem para uso pessoal; usá-las como trilha de um vídeo publicado exige licença. O mesmo vale para o envio ao YouTube: publique só o que você tem direito de publicar, com atenção às músicas e às imagens de terceiros.

## 📄 Licença

Copyright © 2026 **Mauro Braga**. Todos os direitos reservados.

O Braga Digital Studio é **gratuito**: você pode instalá-lo e usá-lo em quantos computadores quiser, para uso pessoal ou profissional, e compartilhar o instalador original, sem alterações e sem cobrar. Não é permitido vender, modificar, fazer engenharia reversa nem remover os avisos; o código-fonte não é cedido. Os componentes de terceiros seguem as suas próprias licenças (veja *Configurações → Sobre e licenças*). Texto completo em [LICENSE](LICENSE).
