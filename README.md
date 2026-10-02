# Braga Digital Studio (BDS) 🎬

[![Licença](https://img.shields.io/badge/Licen%C3%A7a-Propriet%C3%A1ria-red.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![NodeJS](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

*[Read in English](README.en.md)*

Braga Digital Studio (anteriormente Braga Media Downloader) é uma central avançada e profissional para o gerenciamento, download, e organização de mídia digital. Desenvolvida especialmente para criadores de conteúdo, fotógrafos e videomakers, a ferramenta atua como o principal *hub* entre seus dispositivos de captação (Câmeras, Cartões SD, Drones) e seu fluxo de trabalho criativo.

## 🚀 Principais Funcionalidades

- **Gerenciamento de Dispositivos de Captura:** 
  - Reconhecimento automático, rápido e seguro de dispositivos conectados via **MTP** (Media Transfer Protocol) para Câmeras/Celulares.
  - Leitura nativa de cartões SD e pendrives via **USB (Mass Storage)**.
  - Integração sem fio com **Câmeras Sony (Alpha/Cyber-shot)** via SSDP e Camera Remote API para telemetria de bateria/armazenamento e download com separação de RAW (.ARW), JPG e MP4.
  - Importação de mídias de forma limpa, ignorando pastas de sistema ocultas nativas das câmeras.

- **Painel de Color Grading (LUTs):**  (EM PROGRESSO)
  - Interface dedicada à estética cinematográfica para importação, visualização e gerenciamento de arquivos de perfis de cor `.cube`.
  - Simulação interativa e de altíssima performance de efeitos de cor com o recurso "Antes e Depois" (Slider Interativo) em tempo real, suportando imagens nativas.

- **Download Inteligente de Mídias:** 
  - Integração transparente e em segundo plano com ferramentas nativas para download acelerado de conteúdos de vídeo/áudio do YouTube e outras plataformas.

- **Isolamento de Sessão Segura e Login Local:** 
  - Login isolado em janelas particionadas (`persist:youtube`). Suas contas e dados do YouTube ou outras plataformas ficam isolados e gerenciados nativamente de forma criptografada pelo motor do Electron. Não há senhas salvas em nuvem, garantindo segurança total.

- **Design de Interface Premium:** 
  - Visual elegante, fluido e ultra responsivo.
  - Modo escuro (*Dark Mode*) profissional focado para proteger a visão de coloristas e editores de vídeo durante longas sessões em ambientes de baixa iluminação.

## 🛠️ Tecnologias Utilizadas

- **[Electron](https://www.electronjs.org/) / Node.js**: Motor responsável por fornecer os super-poderes nativos da aplicação para acesso a sistema de arquivos, child-processes e gerenciamento de sessões com segurança em sandbox.
- **[PowerShell](https://learn.microsoft.com/en-us/powershell/) (CIM/WMI)**: Motor utilizado invisivelmente no backend para gerenciar a cópia de mídia silenciosa e varredura de hardware.
- **JavaScript (Vanilla), HTML5 e CSS3**: Todo o *Frontend* do programa foi escrito do absoluto zero usando as tecnologias web essenciais, sem engordar o código com frameworks gigantes. Isso garante que as páginas carreguem em questão de milissegundos e utilizem pouquíssima RAM.

## 📦 Instalação e Uso (Desenvolvimento)

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

## 🏭 Como Compilar (Gerar o Executável .exe)

Para transformar o projeto em um instalador fácil de distribuir para outros computadores Windows:

```bash
npm run build
```

Isso empacotará o código-fonte (os motores internos de mídia e download são baixados em runtime, não vão no instalador), e gerará o arquivo de instalação final dentro da pasta `dist/`. O instalador carregará seu ícone oficial e executará como um aplicativo desktop nativo.

## 🧪 Qualidade, Scripts e CI

| Script | O que faz |
|---|---|
| `npm start` | Abre o app em modo de desenvolvimento |
| `npm run check` | Valida a sintaxe de todos os `.js` (módulos ES no renderer) |
| `npm run lint` | ESLint (config flat em `eslint.config.js`) |
| `npm test` | Testes unitários (`node --test`, pasta `tests/`) |
| `npm run build` / `build:win` | Instalador Windows (NSIS) |
| `npm run build:win:portable` | Versão portable do Windows |
| `npm run build:linux` | AppImage + `.deb` (também `build:linux:appimage` e `build:linux:deb`) |

O workflow `.github/workflows/ci.yml` roda `npm ci`, `check`, `lint` e `test` em todo push/PR. Os workflows de release rodam as mesmas verificações antes de compilar.

## 🚢 Versão e Release

A versão fica em `package.json` e **não** é alterada automaticamente pelo build. Para publicar:

1. `npm version patch --no-git-tag-version` (ou `minor` / `major`) e faça commit do `package.json`/`package-lock.json`;
2. Dispare o workflow **Release BDS (Windows + Linux)** na aba Actions (cria a tag `vX.Y.Z` e publica Windows + Linux numa única Release), ou envie uma tag `v*` para usar os workflows individuais.

O instalador deve continuar se chamando `BragaDigitalStudioSetup.exe`: o atualizador interno procura esse nome de arquivo na Release. Os builds não são assinados digitalmente (o SmartScreen pode alertar no primeiro uso).

## 🧩 Módulos Opcionais

Recursos instalados só se o usuário quiser (hoje: **Whisper**, para legendas e transcrição). O BDS funciona normalmente sem eles. O motor, os modelos (Hugging Face, faster-whisper) e as DLLs de GPU (NVIDIA CUDA) são baixados sob demanda, com verificação de SHA-256, para `<dataDir>/modules`. Código em `src/core/modules/`, IPC em `src/ipc/moduleHandlers.js`, tela em `renderer/screens/modules.*` (visível por enquanto só em modo de desenvolvimento). Detalhes em [`src/core/modules/README.md`](src/core/modules/README.md).

## 🗂️ Estrutura de Pastas

```
main.js, preload.js      Processo principal e ponte segura (IPC)
src/core/                Regras de negócio (mídia, biblioteca, dispositivos, módulos...)
src/infrastructure/      Ferramentas externas, filesystem, banco de dados
src/ipc/                 Handlers IPC e validação de entradas
src/services/            Serviços de aplicação
src/config/              Configuração versionada (ex.: modules.config.json)
renderer/                Interface (JS vanilla, módulos ES)
config/                  Configuração local (ignorada); use os *.example.json como modelo
assets/                  Ícones do app (icon.ico / icon.png)
scripts/, tests/         Scripts de manutenção e testes unitários
.github/workflows/       CI e release
```

## 🔒 Privacidade, Dados e Gitignore

Todos os dados temporários que o programa gera são salvos de forma segura em uma pasta local (`AppData`), invisível para o usuário final. 

**Nenhuma informação sensível é enviada para servidores externos ou salva neste repositório**. 
O banco de dados SQLite temporário, caches de renderização, logs, pastas `data` e sessões isoladas de autenticação do YouTube estão estritamente bloqueadas de serem enviadas para repositórios através de nossas regras rígidas no `.gitignore`.

## 📄 Licença

Copyright © 2026 **Mauro Braga**. Todos os direitos reservados.

Este software é proprietário e confidencial. É estritamente proibida a cópia, modificação, distribuição, sublicenciamento ou divulgação deste código, por qualquer meio, sem a autorização prévia por escrito do autor.
