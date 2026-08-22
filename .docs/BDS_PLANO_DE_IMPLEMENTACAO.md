# BDS — Plano de Implementação
### Baseado no ROADMAP_E_ARQUITETURA.md + auditoria do código-fonte real (v1.0.2)

Este plano traduz o roadmap em tarefas executáveis, priorizadas e com arquivos-alvo
identificados a partir de uma varredura real do código enviado. Cada item de "Fundação
multiplataforma" foi confirmado com grep no projeto, não é especulação.

---

## 0. O que a auditoria confirmou

| Problema do roadmap | Evidência real encontrada | Onde |
|---|---|---|
| Serviços conhecem `.exe` | 19 arquivos referenciam `ffmpeg.exe`, `ffprobe.exe`, `yt-dlp.exe`, `spotify-dlp.exe` diretamente | `downloadService.js`, `converterService.js`, `updateService.js`, `silenceService.js`, `montageService.js`, `metadataService.js`, `WaveformService.js`, `AudioSyncService.js`, `ProjectService.js`, `ThumbnailGenerator.js`, etc. |
| `taskkill` espalhado | 5 ocorrências de `spawn('taskkill', ['/PID', ...])` | `downloadService.js:562`, `converterService.js:646`, `silenceService.js:295`, `montageService.js:325`, `metadataService.js:240` |
| PowerShell acoplado ao Core | `exec('powershell -EncodedCommand ...')` e `Get-CimInstance Win32_LogicalDisk` | `MtpService.js` (3 ocorrências), `UsbService.js` |
| Caminhos hardcoded do usuário | Caminho pessoal do dev exposto como fallback | `silence.js:414`, `silence.js:480`, `montage.js:688` → `C:\Users\mauri\Videos\...` |
| Caminho de sistema fixo | `fs.statfs('C:\\')` sem checagem de plataforma | `systemHandlers.js:17` |
| `spawn`/`exec` direto sem camada comum | 22 arquivos chamam `child_process` diretamente, incluindo até `database.js`/`migrations.js` (via `db.exec`, que é outro uso — não é processo, mas reforça a ausência de uma camada única) | ver lista completa na seção 2 |
| `electron-builder` configurado só para Windows | `"build": "electron-builder --win nsis"`, sem alvo Linux | `package.json` |
| Timeline component existe e é pequeno o bastante para reescrever com segurança | `TimelineEngine.js` (330 linhas), `TimelineControls.js` (164 linhas), `project_workspace.js` (1578 linhas) | `renderer/components/timeline/`, `renderer/screens/` |
| Schema/migrations já usam padrão incremental (`ALTER TABLE ... ADD COLUMN`) | Facilita adicionar `audio_track_count` / `audio_stream_index` sem migração destrutiva | `migrations.js` |

Isso confirma que o roadmap está descrevendo o código real, não um cenário hipotético — o plano abaixo pode ser executado arquivo por arquivo.

---

## 1. Ordem de execução (visão geral)

O roadmap já define 10 fases + P0/P1/P2/P3. Este plano funde as duas dimensões em
**sprints executáveis**, mantendo a regra de ouro do documento original:

> Primeiro desacoplar. Depois tornar multiplataforma. Depois estabilizar. Só então migrar de linguagem.

```
Sprint 1  → PathService + ToolRunner (fundação)
Sprint 2  → External Tools Manager + adapters (ffmpeg/ffprobe/yt-dlp/spotDL)
Sprint 3  → Cancelamento multiplataforma (remove taskkill)
Sprint 4  → Remoção de caminhos hardcoded + IPC validation
Sprint 5  → MTP/USB/Device Discovery abstraídos
Sprint 6  → Build Linux + testes de paridade
Sprint 7  → Refatoração interna (main.js, preload, IPC por domínio)
Sprint 8  → Workspace: timeline de sync (os 3 problemas já mapeados na memória)
Sprint 9  → JobManager + performance/cache
Sprint 10 → BDSM protocol
(Kotlin: não entra neste plano — condição ainda não satisfeita)
```

---

## 2. Sprint 1 — PathService + ToolRunner (P0, bloqueante para tudo)

Nada do resto pode começar sem isso, porque **22 arquivos** chamam `spawn`/`exec`
diretamente hoje. Trocar a fundação primeiro evita retrabalho.

**Criar:**
```
src/infrastructure/filesystem/AppPaths.js
src/infrastructure/external-tools/ToolRunner.js
src/infrastructure/external-tools/ProcessRunner.js
```

**AppPaths** deve centralizar tudo que hoje é resolvido ad-hoc via `path.join(this.paths.dataDir, ...)` espalhado em cada serviço (esse padrão `this.paths.dataDir` já existe — é uma boa notícia, significa que já existe *algum* nível de indireção, só falta consolidar num único lugar e remover os `.exe` literais).

**ToolRunner** deve expor uma API única:
```js
ToolRunner.run(toolName, args, { onProgress, onLog, timeout, cwd })
ToolRunner.cancel(processId)
```

Todo `spawn(...)` e `exec(...)` hoje distribuído nestes 22 arquivos passa a chamar
`ToolRunner.run` em vez de `child_process` diretamente:

`downloadService.js`, `converterService.js`, `updateService.js`, `silenceService.js`,
`thumbnailService.js`, `montageService.js`, `YoutAuthService.js`, `metadataService.js`,
`libraryHandlers.js`, `MtpService.js`, `AudioSyncService.js`, `ProjectService.js`,
`WaveformService.js`, `FFProbe.js`, `ThumbnailGenerator.js`, `HardwareDetectionService.js`,
`UsbService.js`, `UploadScannerService.js`, `DeviceDiscoveryService.js`, `main.js`.

⚠️ Exceção: `database.js` e `migrations.js` usam `db.exec()` do SQL.js (execução de SQL,
não processo do SO) — **não mexer nesses dois**, não fazem parte do escopo do ToolRunner.

**Critério de aceite do Sprint 1:** nenhum serviço novo pode chamar `spawn`/`exec` fora do `ToolRunner`; serviços antigos ainda podem (migração incremental), mas o `ToolRunner` já precisa estar 100% funcional e coberto por teste manual com ffmpeg.

---

## 3. Sprint 2 — External Tools Manager

**Criar:**
```
src/infrastructure/external-tools/
  ExternalToolsManager.js
  ToolResolver.js
  ToolInstaller.js
  ToolUpdater.js
  ToolManifest.js
  adapters/
    FfmpegTool.js
    FfprobeTool.js
    YtDlpTool.js
    SpotDlTool.js
```

**Regra de resolução de nome por plataforma** (isso resolve diretamente os 19 arquivos
com `.exe` hardcoded):

```js
// ToolManifest.js
{
  ffmpeg:  { win32: 'ffmpeg.exe',  linux: 'ffmpeg',  darwin: 'ffmpeg'  },
  ffprobe: { win32: 'ffprobe.exe', linux: 'ffprobe', darwin: 'ffprobe' },
  ytdlp:   { win32: 'yt-dlp.exe',  linux: 'yt-dlp',  darwin: 'yt-dlp'  },
  spotdl:  { win32: 'spotify-dlp.exe', linux: 'spotdl', darwin: 'spotdl' }
}
```

**Migração arquivo por arquivo** (substituir `path.join(this.paths.dataDir, 'ffmpeg.exe')` por `FfmpegTool.resolve()`):

- `converterService.js` — linhas 202, 272, 277, 529 (ffmpeg + ffprobe)
- `downloadService.js` — linhas 514, 521 (spotify-dlp, yt-dlp)
- `updateService.js` — linhas 35, 48, 62, 83, 97, 111, 131, 137, 150, 156 (é o arquivo mais acoplado — vira `ToolUpdater` no próximo passo, não só resolução de path)
- `silenceService.js`, `metadataService.js`, `WaveformService.js`, `AudioSyncService.js`, `ProjectService.js`, `ThumbnailGenerator.js`, `FFProbe.js`, `libraryHandlers.js`, `deviceHandlers.js`, `projectHandlers.js`, `montageService.js`, `UploadService.js`, `UploadScannerService.js`

**ToolUpdater** absorve toda a lógica hoje em `updateService.js` (baixar release do GitHub, extrair, validar, substituir binário) e a torna genérica por manifesto, em vez de ter uma função por ferramenta hardcoded com URL do GitHub embutida no meio do código.

**Critério de aceite:** `grep -rln "\.exe" src/` retorna zero arquivos de serviço (só pode restar dentro do próprio `ToolManifest.js`).

---

## 4. Sprint 3 — Cancelamento multiplataforma (remove taskkill)

5 pontos exatos a corrigir, todos com o mesmo padrão `spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })`:

| Arquivo | Linha |
|---|---|
| `downloadService.js` | 562 |
| `converterService.js` | 646 |
| `silenceService.js` | 295 |
| `montageService.js` | 325 |
| `metadataService.js` | 240 |

**Substituir por:**
```js
// ProcessRunner.js
cancel(pid) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGTERM'); // SIGKILL como fallback se necessário
  }
}
```

Cada um dos 5 arquivos passa a chamar `ProcessRunner.cancel(pid)` em vez de reimplementar o `spawn('taskkill', ...)` localmente. Isso elimina a duplicação de lógica em 5 lugares diferentes ao mesmo tempo que resolve a portabilidade.

---

## 5. Sprint 4 — Caminhos hardcoded + validação de IPC

**Caminhos pessoais a remover (achados reais, não hipotéticos):**

| Arquivo | Linha | Valor hardcoded |
|---|---|---|
| `renderer/screens/silence.js` | 414, 480 | `C:\Users\mauri\Videos\RemoverSilencio` |
| `renderer/screens/montage.js` | 688 | `C:\Users\mauri\Videos\Montagem` |
| `src/ipc/systemHandlers.js` | 17 | `fs.statfs('C:\\')` |

Ação:
- `silence.js` / `montage.js`: o fallback deve vir de `AppPaths.userVideos` (resolvido via `app.getPath('videos')` do Electron, que já funciona em Windows/Linux/macOS), nunca um literal.
- `systemHandlers.js`: `fs.statfs('C:\\')` deve virar `fs.statfs(os.platform() === 'win32' ? 'C:\\' : '/')`, ou melhor, usar `AppPaths.systemRoot` centralizado.

**Validação de IPC (Regra 4 do roadmap):** os handlers em `src/ipc/*.js` que recebem
caminho vindo do renderer (exclusão de LUT, projeto, arquivo temporário, exportação) devem
passar por um guard comum, ex.:

```js
// infrastructure/filesystem/PathGuard.js
function assertWithin(baseDir, targetPath) {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error('Caminho fora do diretório permitido');
  }
}
```

Aplicar em todo handler de delete/write em `libraryHandlers.js`, `projectHandlers.js`, `deviceHandlers.js` antes de tocar o filesystem.

---

## 6. Sprint 5 — MTP / USB / Device Discovery

Confirmação real do acoplamento com PowerShell:

- `MtpService.js`: 3 chamadas `exec('powershell -EncodedCommand ...')`/`spawn('powershell', ...)` (linhas 136, 192, 390)
- `UsbService.js`: script inline em PowerShell usando `Get-CimInstance Win32_LogicalDisk` (linha 14) + `exec` (linha 30)

**Estrutura a criar:**
```
src/core/devices/
  MtpService.js            (interface pública, fina)
  providers/
    WindowsMtpProvider.js  (todo o código atual de MtpService.js migra pra cá)
    LinuxMtpProvider.js    (novo — via gio/gvfs ou libmtp)
  StorageDeviceService.js
  providers/
    WindowsStorageProvider.js (código atual de UsbService.js migra pra cá)
    LinuxStorageProvider.js   (novo — via lsblk/udisks2)
```

`DeviceDiscoveryService.js` deixa de saber que existe Windows: passa a apenas escolher o provider certo com base em `process.platform`, e cada provider implementa a mesma interface (`list()`, `browse(path)`, `import(file)`).

**Nota de risco:** Linux provider é trabalho novo, não refatoração — vai exigir decidir a dependência real (`gio mount -li`, `udisksctl`, ou uma lib npm tipo `drivelist` que já é cross-platform e evitaria reescrever ambos os providers do zero). Vale avaliar `drivelist`/`node-usb` antes de escrever o provider Linux manualmente.

---

## 7. Sprint 6 — Build Linux

**`package.json` hoje:**
```json
"scripts": {
  "build": "electron-builder --win nsis",
  "build:portable": "electron-builder --win portable"
},
"build": { "win": { "icon": "assets/icon.ico", "target": "nsis" } }
```

Não existe target Linux configurado. Ação:
```json
"scripts": {
  "build:win": "electron-builder --win nsis",
  "build:linux": "electron-builder --linux AppImage deb"
},
"build": {
  "win": { "icon": "assets/icon.ico", "target": "nsis" },
  "linux": { "icon": "assets/icon.png", "target": ["AppImage", "deb"], "category": "AudioVideo" }
}
```
Precisa de um ícone `.png` (o atual é só `.ico`). Rodar teste de paridade: abrir Library, importar mídia, rodar Converter e Silence Removal via `ToolRunner` em uma VM/container Linux antes de considerar a fase concluída.

---

## 8. Sprint 7 — main.js, preload, IPC por domínio

`main.js` tem **1059 linhas** hoje — confirma o diagnóstico do roadmap de responsabilidades excessivas. Plano de extração (sem reescrever, só mover):

1. Mapear no `main.js` atual os blocos de: registro de IPC, lógica de LUT, inicialização de serviços, criação de janela.
2. Cada bloco de lógica de negócio migra para o serviço correspondente em `src/core/` ou `src/services/`.
3. `main.js` final deve conter apenas: `app.whenReady()`, criação de `BrowserWindow`, composição de dependências (instanciar serviços e passar pro `ipc/*Handlers.js`), e `app.on('window-all-closed', ...)`.
4. `preload.js` reorganizado por domínio (`window.bds.projects`, `window.bds.library`, `window.bds.tools`, etc.), conforme já especificado na seção 22 do roadmap original — hoje é preciso auditar se já segue esse padrão ou é uma lista plana de funções (recomendo checar `preload.js` diretamente antes de iniciar esse item).

---

## 9. Sprint 8 — Project Workspace / Timeline de sincronização

Este item já estava em andamento (ver contexto de conversas anteriores) e se encaixa
exatamente na Fase 8 do roadmap + Regra 10 ("BDS não deve virar editor de vídeo completo").
Os três problemas mapeados continuam válidos e devem ser resolvidos nesta ordem:

1. **Overflow de canvas** — `TimelineEngine.js` (330 linhas): adicionar `min-width: 0` na cadeia flex ancestral em `project_workspace.css`, e capar a largura máxima do canvas (renderizar em viewport + virtualização, em vez de desenhar a timeline inteira em pixels proporcionais à duração).
2. **Múltiplas faixas de áudio** — `FFProbe.js` hoje só captura o último stream de áudio; corrigir para coletar `[{ index, codec, channels, ... }]` por stream. Adicionar `audio_track_count` e `audio_stream_index` em `schema.sql` via `migrations.js` (o padrão `ALTER TABLE ... ADD COLUMN` já é usado 10+ vezes nesse arquivo — seguir o mesmo estilo, é seguro e não-destrutivo). `WaveformService.js` passa a extrair waveform por `stream_index`. Inserção no monitor cria um clipe por stream de áudio, em faixas separadas.
3. **Remoção de controles de edição** — em `TimelineControls.js` (164 linhas) e nos handlers de teclado em `project_workspace.js` (1578 linhas): remover ferramenta de blade, delete de clipe, drag de clipe e atalhos de edição, mantendo apenas play/pause/scrub/zoom — a timeline vira estritamente uma referência de sincronização, nunca editável.

**Critério de aceite:** timeline nunca ultrapassa a largura do container mesmo com vídeo de 3h+; vídeo com 2+ streams de áudio mostra 2+ faixas; nenhuma tecla ou clique remove/move clipe.

---

## 10. Sprints 9 e 10 — JobManager e BDSM (resumo)

Menor prioridade imediata (P2), mantidos conforme o roadmap original sem alteração —
`JobManager` centraliza progress/cancel de forma consistente (reaproveitando o `ToolRunner`
do Sprint 1), e a integração BDSM entra só depois que `ExternalTools`, `Project Core`,
`Media Core` e `Sync Core` estiverem isolados (pré-condição explícita da seção 53 do roadmap).

---

## 11. Definição de pronto (multiplataforma) — checklist rastreável

Baseado na seção 52 do roadmap, mas agora com verificação automatizável via grep:

- [ ] `grep -rln "\.exe" src/` → vazio (fora do `ToolManifest.js`)
- [ ] `grep -rln "taskkill" src/` → vazio (fora do `ProcessRunner.js`, ramo `win32`)
- [ ] `grep -rln "C:\\\\\\\\" .` → vazio (fora de comentários/docs)
- [ ] `grep -rn "powershell" src/core/devices/providers/WindowsMtpProvider.js` → OK ficar aqui, mas **não** fora dela
- [ ] `package.json` com target `linux` configurado e testado
- [ ] Timeline nunca overflow, sync com múltiplas faixas de áudio, zero controles de edição

---

## 12. Observação final

O roadmap já é bem estruturado — este plano não muda nenhuma decisão dele, só a torna
executável: cada tarefa abaixo tem arquivo e linha reais, então dá para tratar como
backlog de PRs pequenos (um serviço por vez) em vez de uma reescrita monolítica, exatamente
como a Regra 3 do roadmap original pede ("não reescrever o BDS do zero").
