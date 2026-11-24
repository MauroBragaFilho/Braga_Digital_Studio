# Braga Digital Studio (BDS) 🎬

[![Licença](https://img.shields.io/badge/Licen%C3%A7a-GPL--3.0-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)
[![NodeJS](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org/)

*[Read in English](README.en.md)*

Braga Digital Studio (anteriormente Braga Media Downloader) é um programa para baixar, importar, organizar e preparar mídia digital. Feito para criadores de conteúdo, fotógrafos e videomakers, ele liga os dispositivos de captação (câmeras, celulares, cartões SD) ao fluxo de edição.

## 📥 Baixar e instalar

O BDS é **gratuito**. Baixe o instalador mais recente na página de [Releases](../../releases) (`braga-digital-studio-<versão>-windows-x64.exe` para Windows 10/11 de 64 bits; também há o zip portátil `-windows-x64-portable.zip` e, para Linux, `-linux-x86_64.AppImage` e `-linux-x86_64.deb`).

**Sistemas:** Windows 10/11 x64 (completo); Linux x64 (sem MTP; transcrição só no processador); macOS não é suportado.

Na instalação você escolhe entre:

- **Instalação completa (recomendada):** instala o programa, baixa as ferramentas e o recurso de transcrição e deixa tudo pronto para usar.
- **Instalação curta:** instala o programa e as ferramentas básicas; a transcrição pode ser instalada depois em *Configurações → Módulos*.

Enquanto o instalador não sair com assinatura digital, o Windows (SmartScreen) pode mostrar um aviso no primeiro uso: use "Mais informações → Executar assim mesmo". Cada release traz o SHA-256 do instalador e o `SHA256SUMS.txt` com o de todos os arquivos. O programa avisa em *Configurações* quando há versão nova (a verificação ao abrir o app é opcional) e só instala depois da sua confirmação. Só a versão mais recente recebe correções, em regime de melhor esforço.

## 🚀 Principais Funcionalidades

Numa instalação nova só o Assistente de IA vem ligado. Os outros recursos abaixo se ligam em *Configurações → Módulos*.

- **Gerenciamento de Dispositivos de Captura:** 
  - Reconhecimento de câmeras e celulares conectados via **MTP** (Media Transfer Protocol; só no Windows).
  - Leitura de cartões SD e pendrives via **USB (Mass Storage)**.
  - Integração sem fio com **Câmeras Sony (Alpha/Cyber-shot)** via SSDP e Camera Remote API, com download separando RAW (.ARW), JPG e MP4.
  - Pareamento seguro com o **celular BDS** (exige o app próprio no celular; código de 4 dígitos aprovado no aparelho), por USB ou Wi-Fi. A descoberta pela rede (mDNS) pode falhar atrás de VPN.
  - Importação de mídias sem nunca sobrescrever arquivos existentes e ignorando pastas de sistema ocultas das câmeras, com organização das mídias depois de importar.

- **Início, Biblioteca e Projetos:** 
  - Biblioteca com janela virtual (milhares de arquivos sem travar), filtros, favoritos e preview de vídeo, áudio e foto.
  - Projetos com pastas, sequências e sincronização por áudio, exportação para o Premiere (XML) e o formato próprio `.bdspro`, com relink de arquivos ausentes. Cada projeto tem uma área de trabalho com abas de visão geral, arquivos, áudio, dispositivos, monitor e entrega.

- **Download de Mídias:** 
  - Download de vídeo e áudio do YouTube e de centenas de outros sites (yt-dlp), com pausa configurável entre os itens da fila.
  - Ao colar um link de um item dentro de uma playlist, o app pergunta se você quer só aquele item ou a playlist inteira.

- **Envio ao YouTube:** fila de envio e o YouTube Studio dentro do app.

- **Transcrição e legendas (módulo opcional):** 
  - Transcrição local, no seu computador (a nuvem é opcional e só é usada se você escolher), com saída em SRT, Markdown e TXT; filtro automático de trechos sem fala; aceleração por placa NVIDIA opcional (só no Windows).

- **Conversor, Remover Silêncio e Metadados:** ferramentas para converter mídia, cortar silêncios e editar tags e capas.

- **Painel de Color Grading (LUTs):**  (EM PROGRESSO)
  - Importação, visualização e gerenciamento de perfis de cor `.cube`, com sincronização de LUTs com dispositivos.
  - Comparação "Antes e Depois" com controle deslizante, em tempo real, sobre imagens.

- **Assistente de IA integrado:** 
  - Um botão flutuante (atalho **Ctrl + J**) abre um chat que conhece a sua biblioteca, os projetos e a tela em que você está, e pode transcrever, converter, remover silêncio, baixar um link, criar projetos e exportar. **Toda ação pede a sua confirmação antes de acontecer.** Antes da primeira mensagem a um servidor que não é local, o app avisa que o conteúdo sairá do seu computador.
  - Funciona com servidores que você escolhe: locais (o modelo próprio do app, LM Studio, Ollama) ou na internet (Groq, Qwen, OpenAI ou outro compatível), cada um com a sua chave, com troca automática para o próximo se um falhar. O modelo próprio do app baixa o `llama-server` oficial do llama.cpp e um modelo Qwen2.5-0.5B ou Qwen3-VL 2B/4B/8B (com visão), escolhido pela memória da placa de vídeo. É opcional e pode ser desligado em *Configurações*.

- **Isolamento de Sessão Segura e Login Local:** 
  - Login isolado em janelas particionadas (`persist:youtube`): a sessão das plataformas fica numa partição própria do navegador embutido, separada do restante do app. O BDS não guarda a sua senha nem envia a sessão a nenhuma nuvem do autor. Usar a sua conta nos downloads do YouTube é opcional e vem desligado (*Configurações → Mídia*). Ligado, o app cria um arquivo de texto temporário com a sessão do YouTube só enquanto baixa e o apaga ao terminar; enquanto ele existe, quem usa o seu usuário do Windows consegue lê-lo, então use um computador de confiança. O botão *Sair e apagar a sessão* encerra o login e remove a sessão guardada.

- **Design de Interface:** 
  - Visual limpo, em tema escuro ou claro, com botões em pílula, acento vermelho e outras 4 cores à escolha, fontes Montserrat e Inter e contraste de acessibilidade (WCAG AA).
  - Cada recurso é um módulo que pode ser ligado ou desligado em *Configurações → Módulos*.

## 🛠️ Tecnologias Utilizadas

- **[Electron](https://www.electronjs.org/) / Node.js**: acesso ao sistema de arquivos, processos externos e sessões isoladas, com o renderer em sandbox. No pacote, os Electron Fuses desligam `runAsNode`, `NODE_OPTIONS` e `--inspect`.
- **[PowerShell](https://learn.microsoft.com/en-us/powershell/) (CIM/WMI)**: usado no Windows para a varredura de hardware e a cópia de mídia via MTP. No Linux não há PowerShell, e por isso não há MTP.
- **JavaScript (Vanilla), HTML5 e CSS3**: a interface usa só as tecnologias web básicas, sem framework, o que a mantém leve.
- **[sql.js](https://sql.js.org/)** (SQLite em WebAssembly) como banco de dados; `bonjour-service` (mDNS dos dispositivos), `chokidar` (vigiar pastas), `winston` (logs) e `adm-zip`.
- **Componentes de terceiros baixados sob demanda** (FFmpeg, yt-dlp, whisper.cpp, llama.cpp e outros), das releases públicas de cada projeto (o FFmpeg vem dos builds do projeto BtbN, porque o FFmpeg não publica binários) e conferidos por SHA-256 quando a fonte publica o hash. A lista completa, com versões e licenças, está em *Configurações → Sobre e licenças*.

## 📦 Instalação e Uso (Desenvolvimento)

O código-fonte é aberto, sob a [GPL v3](LICENSE). Certifique-se de ter o **Node.js** instalado na sua máquina (versão 22 ou superior; o CI usa a 24).

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/MauroBragaFilho/Braga_Digital_Studio.git
   cd Braga_Digital_Studio
   ```

2. **Instale as dependências essenciais:**
   ```bash
   npm install
   ```

3. **Abra o app em modo de desenvolvimento:**
   ```bash
   npm start
   ```

   Atenção: em desenvolvimento o app grava `data/`, `database/`, `logs/` e `config/` na própria pasta do projeto. Para testar sem tocar nos seus dados, use `--user-data-dir` com uma pasta de teste.

## 🏭 Como Compilar (Gerar o Executável .exe)

Para transformar o projeto em um instalador fácil de distribuir para outros computadores Windows:

```bash
npm run build
```

Isso empacota o código-fonte (os motores de mídia, download e IA são baixados em runtime, não vão no instalador) e gera o instalador `braga-digital-studio-<versão>-windows-x64.exe` dentro da pasta `dist/` (cerca de 90 a 100 MB). O instalador é preto, em português, e pergunta se a instalação é curta ou completa. Parâmetros de linha de comando:

- `/S` instala sem janela; nesse modo o padrão é `/COMPONENTES=nenhuma`, ou seja, uma atualização silenciosa não baixa nada e mantém o que já existe.
- `/COMPONENTES=completa|curta|nenhuma` escolhe o que baixar; completa e curta chamam o app com `--setup-components=full|basic`.
- Reinstalar sobre uma instalação que já tem os componentes não pergunta de novo.

O script do instalador fica em `installer/`.

## 🧪 Qualidade, Scripts e CI

| Script | O que faz |
|---|---|
| `npm start` | Abre o app em modo de desenvolvimento |
| `npm run check` | Valida a sintaxe de todos os `.js` (módulos ES no renderer) |
| `npm run lint` | ESLint (config flat em `eslint.config.js`) |
| `npm test` | Testes unitários (`node --test`, pasta `tests/`) |
| `npm run verify:package` | Garante que nenhum dado do usuário entra no pacote |
| `npm run generate:preload` | Gera o `preload.js` |
| `npm run verify:preload` | Confere se o `preload.js` está igual ao que o gerador produz |
| `npm run generate:licenses` | Regenera a lista de licenças de terceiros |
| `npm run build` / `build:win` | Instalador Windows (NSIS) |
| `npm run build:win:portable` | Versão portable do Windows (`.exe`; o `.zip` da Release é montado pelo workflow de release) |
| `npm run build:linux` | AppImage + `.deb` (também `build:linux:appimage` e `build:linux:deb`) |

Outros scripts em `scripts/`, sem atalho no npm: `after-pack-check.js` (roda depois do empacotamento), `generate-installer-images.js`, `installer-license.js` e `limpar-artefatos.js`. O `BDS_Menu.bat`, na raiz, é um menu do Windows para rodar o app, gerar o instalador ou a versão portable, publicar uma release e limpar artefatos do GitHub Actions.

O workflow `.github/workflows/ci.yml` roda em todo push (qualquer branch) e PR, em Linux e Windows, com Node 24: instala o FFmpeg (sem ele os testes de mídia são pulados), roda `npm ci`, `check`, `lint` e `test`, confere a lista de licenças (`node scripts/generate-licenses.js --check`, no Windows) e, num job à parte, `npm audit --omit=dev --audit-level=high`. Os workflows de release rodam as mesmas verificações antes de compilar.

## 🚢 Versão e Release

Uma release sai de uma **tag de versão** `vX.Y.Z` cujo commit esteja na `main`. Push na `main` só roda o CI.

```bash
node scripts/release-tag.js            # sugere a próxima versão
node scripts/release-tag.js 1.0.8      # versão explícita
node scripts/release-tag.js --dry-run  # só mostra o que faria (--yes pula a confirmação)
```

O script confere se você está na `main` com tudo commitado e sincronizado, recusa uma tag que já exista (local ou no remoto), atualiza o `package.json` e o `package-lock.json`, cria a tag anotada e a envia. O workflow **Release BDS (Windows + Linux)** (`release-bds.yml`) então:

1. compila Windows e Linux, depois de passar por `check`, `lint` e `test`;
2. assina o instalador Windows na SignPath (quando o token da SignPath está configurado; sem ele, o instalador sai sem assinar), só se o commit da tag estiver na `main` (veja a [política de assinatura](CODE_SIGNING_POLICY.md));
3. publica uma única Release, com o `SHA256SUMS.txt` e as notas: o SHA-256 do instalador e a seção **Mudanças**, com o título de cada commit desde a tag anterior. Por isso vale escrever o título do commit como uma frase que o usuário entenda.

O mesmo workflow pode ser rodado à mão (sem tag): ele pega a próxima versão livre e faz um commit `chore(release): vX.Y.Z [skip release]` na `main`. Os workflows `build-bds-release.yml` (só Windows), `build-bds-linux.yml` (só Linux, com teste de abertura via Xvfb) e `release-sign.yml` são de execução manual; a assinatura de produção roda dentro do `release-bds.yml`.

Para quem faz fork: a Release é publicada no repositório `RELEASES_REPO` com o token do próprio repositório (`GITHUB_TOKEN`, sem segredo à parte); a assinatura exige `SIGNPATH_API_TOKEN` e `SIGNPATH_ORGANIZATION_ID`.

Os arquivos da Release seguem um padrão só, que o atualizador interno procura:

| Arquivo | O que é |
|---|---|
| `braga-digital-studio-<versão>-windows-x64.exe` | Instalador do Windows (é o que o atualizador baixa) |
| `braga-digital-studio-<versão>-windows-x64-portable.zip` | Versão portátil do Windows |
| `braga-digital-studio-<versão>-linux-x86_64.AppImage` | Linux, sem instalar |
| `braga-digital-studio-<versão>-linux-x86_64.deb` | Linux (Debian/Ubuntu) |

## 🤝 Como contribuir

Issues e pull requests são bem-vindos. Antes de abrir um PR, rode `npm run check`, `npm run lint` e `npm test`. Ao contribuir, você concorda que a sua contribuição é distribuída sob a mesma licença (GPL v3). Falhas de segurança vão pela [Política de Segurança](SECURITY.md), não por issue pública.

## 🧩 Módulos

Cada recurso do BDS é um módulo com um interruptor em *Configurações → Módulos*. Numa instalação nova só o Assistente de IA vem ligado; quem já usa o app mantém o que escolheu. Os recursos pesados, como a **Transcrição** (motor whisper.cpp, modelos e DLLs da placa NVIDIA) e o **modelo local de IA** (`llama-server` e o modelo escolhido pela memória da placa), são baixados sob demanda, com verificação de SHA-256, para `<dataDir>/modules`. Código em `src/core/modules/`, IPC em `src/ipc/moduleHandlers.js`, painel em `renderer/components/modules-panel.js`. Detalhes em [`src/core/modules/README.md`](src/core/modules/README.md).

As telas de Recuperação e Montagem estão em desenvolvimento e não aparecem no app instalado.

## 🗂️ Estrutura de Pastas

```
main.js, preload.js      Processo principal e ponte segura (IPC); o preload é gerado
src/bootstrap/           Inicialização, serviços, desligamento e ponte com o renderer
src/core/                Regras de negócio (mídia, biblioteca, dispositivos, módulos...)
src/infrastructure/      Ferramentas externas, filesystem, banco de dados
src/ipc/                 Handlers IPC, tabela de canais e validação de entradas
src/services/            Serviços de aplicação (downloads, conversão, assistente de IA...)
src/setup/               Modo sem janela usado pelo instalador (--setup-components)
src/config/              Configuração versionada (módulos, atualização, licenças de terceiros)
renderer/                Interface (JS vanilla, módulos ES; fontes em renderer/assets/fonts)
installer/               Script NSIS e imagens do instalador
config/                  Configuração local (ignorada); use os *.example.json como modelo
data/, database/, logs/  Dados locais em desenvolvimento (ignorados)
assets/                  Ícones do app e arquivo de licenças de terceiros
scripts/, tests/         Scripts de manutenção e testes automatizados
.github/workflows/       CI e release
```

## 🔒 Privacidade e Dados

Todos os dados que o programa gera (biblioteca, configurações, históricos, miniaturas) ficam no seu computador, em uma pasta local (`AppData`). O programa **não tem telemetria**, não exige conta e não envia a sua biblioteca nem os seus arquivos ao autor. Chaves de servidores de IA e os tokens de pareamento dos celulares são guardados criptografados pelo sistema (DPAPI no Windows) e nunca são exibidos de volta; se o sistema não oferecer criptografia (por exemplo, Linux sem chaveiro), a chave não é guardada.

Relatórios de falha são gravados só no seu computador, sem e-mails nem chaves longas (inclusive nas últimas 30 linhas de log que eles trazem), e apagados depois de 30 dias. Nada é enviado automaticamente, a menos que você configure um endereço https ou envie um relato manual. O histórico é apagado depois de 180 dias; o do assistente guarda no máximo 40 mensagens.

O que acessa a internet: verificação e download de atualizações (GitHub), das ferramentas e modelos (releases públicas de cada projeto e Hugging Face), os sites de onde você pedir para baixar e, **se você escolher**, a nuvem: o servidor de IA configurado, a transcrição em nuvem (o áudio vai ao provedor escolhido, Groq ou ElevenLabs) e a análise de transcrição por IA (o texto da transcrição vai ao servidor de IA). Com qualquer um deles, o conteúdo enviado sai do seu computador; por isso o app avisa antes da primeira vez. Na rede local, o app procura câmeras Sony (SSDP) e o celular BDS (mDNS).

O servidor MCP vem desligado. Ligado, escuta só em 127.0.0.1 (se a porta estiver ocupada, usa outra livre), confere o Host, recusa conexões vindas de navegador e exige um token aleatório de 256 bits, gerado ao ligar e guardado na sua pasta de usuário. "Sem token" e "ações sem confirmação" são opcionais e não podem ficar ligados ao mesmo tempo.

Nenhuma informação sensível é salva neste repositório: banco de dados, caches, logs, pastas `data` e sessões de autenticação estão bloqueados pelas regras do `.gitignore`.

Encontrou uma falha de segurança? Veja a [Política de Segurança](SECURITY.md) e relate em particular, não numa issue pública.

## ⚖️ Direitos autorais e uso responsável

O BDS baixa os vídeos e áudios que **você** pedir, de sites que o programa não controla; o conteúdo continua sendo de quem detém os direitos. Baixe só o que você tem direito de baixar (conteúdo seu, de licença livre ou com autorização de quem o detém): respeitar os direitos autorais e os termos de cada site é responsabilidade de quem baixa. Músicas de serviços de streaming servem para uso pessoal; usá-las como trilha de um vídeo publicado exige licença. O mesmo vale para o envio ao YouTube: publique só o que você tem direito de publicar, com atenção às músicas e às imagens de terceiros.

## 📄 Licença

Copyright © 2026 **Mauro Braga**. Software livre sob a [GNU GPL v3.0](LICENSE): você pode usar, estudar, modificar e redistribuir, desde que mantenha a mesma licença e o código-fonte aberto. Os componentes de terceiros seguem as suas próprias licenças (veja *Configurações → Sobre e licenças*).

Assinatura dos instaladores Windows (quando assinados): [Política de Assinatura de Código](CODE_SIGNING_POLICY.md) — assinatura gratuita por [SignPath.io](https://signpath.io), certificado da [SignPath Foundation](https://signpath.org).
