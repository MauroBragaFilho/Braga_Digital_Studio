# _Archives

Código removido do bundle ativo do BDS por estar sem uso (não é importado/instanciado por
nenhuma tela), mas preservado aqui para eventual reaproveitamento futuro — não é lixo, é
arquivo morto intencionalmente guardado.

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
  carregada pelo `bootstrap.js` (`require('./core/devices/SonyCameraService')`) e usada em
  todos os handlers IPC de câmera Sony.
- Nenhuma referência a este arquivo em `bootstrap.js`, `ipc/*` ou em qualquer outro módulo.

## src/services/YoutAuthService.js

- Classe `AuthService` com um único método `conectarYoutube`, que dispara `yt-dlp --username
  oauth2 --simulate` contra um vídeo dummy do YouTube para capturar o código de autenticação
  OAuth2 via regex na saída do processo.
- Nunca instanciado nem importado em nenhum lugar do projeto (`bootstrap.js`, IPC handlers,
  renderer). Parece um protótipo/experimento de fluxo de login OAuth2 do yt-dlp que não
  chegou a ser integrado.

## src/services/ftpService.js

- Classe `FtpService` que sobe um servidor FTP local (porta 2121) usando o pacote `ftp-srv`.
- Não é importado por nenhum módulo do backend. O pacote `ftp-srv` continua listado em
  `package.json` apenas por causa deste arquivo — se o arquivo não for reaproveitado, a
  dependência também pode ser removida do `package.json`/`package-lock.json`.

## src/core/integrations/bdsm/BdsmDeviceProvider.js

- `BdsmDeviceProvider extends StorageProvider` — provider de dispositivos para o protocolo
  BDSM (Wi-Fi/USB ADB), usando `BdsmClient` e `BdsmProtocol` (esses dois continuam ativos e em
  uso via `src/ipc/deviceHandlers.js`).
- Este provider específico nunca é registrado em `DeviceManager.js`/`DeviceDiscoveryService.js`
  nem referenciado em nenhum outro arquivo — parece a integração do lado "device provider" do
  protocolo BDSM ter ficado pela metade (o client/protocol existem e funcionam, mas não há
  provider plugado ao sistema de descoberta de dispositivos).
