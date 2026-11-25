# _Archives

Código removido do bundle ativo do BDS por estar sem uso (não é importado/instanciado por
nenhuma tela), mas preservado aqui para eventual reaproveitamento futuro — não é lixo, é
arquivo morto intencionalmente guardado.

Estado da pasta: foi guardada em 31/08/2026 (versão 1.0.5) e o que está aqui é o que o Git rastreia desse dia. A pasta está no
`.gitignore`, então arquivos NOVOS colocados aqui não sobem para o repositório. Nada daqui entra no instalador e nada é conferido
por `npm run check` nem por `npm run lint`.

## renderer/components/timeline/

- `TimelineEngine.js` — engine de cálculo de layout de timeline (réguas, marcações de tempo).
- `TimelineControls.js` — controles interativos de timeline (zoom, scroll, seek), com um
  método `destroy()` já implementado corretamente para limpeza de listeners globais
  (`window.addEventListener('mousemove'/'mouseup')`).

**Contexto:** remanescentes da refatoração que removeu o mini-timeline do painel do Project
Workspace. Confirmado (grep em todo o projeto) que nenhuma tela ativa do BDS importa ou
instancia nenhum dos dois arquivos.

**Se for reaproveitar:** os dois arquivos mantêm a mesma estrutura relativa entre si
(`TimelineControls.js` importa de `./TimelineEngine.js`), então funcionam se movidos juntos de
volta para dentro de `renderer/`. Lembre de religar o `destroy()` do `TimelineControls` ao
ciclo de vida de quem for instanciá-lo (ex: ao trocar de projeto/fechar o painel), para não
reintroduzir o vazamento de listeners globais que motivou a documentação desse cuidado.

## src/services/sonyCameraService.js

- Versão antiga do serviço de câmeras Sony (protocolo Sony Camera Remote API via SSDP/HTTP,
  classe `SonyCameraService extends EventEmitter`, 337 linhas).
- **Superada por** `src/core/devices/SonyCameraService.js`, que é a versão efetivamente
  carregada por `src/bootstrap/moduleRuntime.js` e usada em `src/ipc/sonyHandlers.js` e
  `src/ipc/deviceListHandlers.js`.
- Nenhuma referência a este arquivo em `src/bootstrap/`, `src/ipc/` ou em qualquer outro módulo.

## src/services/YoutAuthService.js

- Classe `AuthService` com um único método `conectarYoutube`, que dispara `yt-dlp --username
  oauth2 --simulate` contra um vídeo dummy do YouTube para capturar o código de autenticação
  OAuth2 via regex na saída do processo.
- Nunca instanciado nem importado em nenhum lugar do projeto (`src/bootstrap/`, IPC handlers,
  renderer). Parece um protótipo/experimento de fluxo de login OAuth2 do yt-dlp que não
  chegou a ser integrado.

## src/services/ftpService.js

- Classe `FtpService` que sobe um servidor FTP local (porta 2121) usando o pacote `ftp-srv`.
- Não é importado por nenhum módulo do backend. O pacote `ftp-srv` já foi removido do
  `package.json` e do `package-lock.json`; para reaproveitar este arquivo, instale o pacote de novo.

## src/core/integrations/bdsm/BdsmDeviceProvider.js

- Cópia antiga (153 linhas) de `BdsmDeviceProvider extends StorageProvider`, o provider de dispositivos para o protocolo
  BDSM (Wi-Fi/USB ADB), que usa `BdsmClient` e `BdsmProtocol` (esses dois continuam ativos e em
  uso via `src/ipc/deviceHandlers.js`).
- **Não reaproveite esta cópia:** o arquivo vivo `src/core/integrations/bdsm/BdsmDeviceProvider.js` é mais novo (por exemplo,
  usa `stream`/`pipeline` e sanitiza o nome de arquivo vindo do celular). Ele só é referenciado por
  `tests/bdsm-client-auth.test.js`: em produção não está plugado ao `DeviceDiscoveryService`. O client/protocol existem e
  funcionam; o provider no sistema de descoberta ficou pela metade.
