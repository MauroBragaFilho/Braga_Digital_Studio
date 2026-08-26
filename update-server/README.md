# BDS Update Server

Servidor central de atualizações do BDS (Braga Digital Studio). Hospeda o `manifest.json`
e os pacotes de componentes internos (FFmpeg, untrunc, RawRecoveryEngine, etc.), permitindo
que o BDS os atualize automaticamente com checksum SHA-256 obrigatório e rollback — sem
depender de releases públicas do GitHub para componentes próprios (item 14-17 do plano).

## Testado nesta sessão (fluxo real, ponta a ponta)

1. Empacotei o `RawRecoveryEngine` (binário real de ~35MB, buildado com PyInstaller) em
   `components/rawrecoveryengine/1.0.0/linux`.
2. Gerei o manifesto com `node build-manifest.js` — conferi o SHA-256 calculado batendo com
   o do arquivo original.
3. Subi o servidor (`node server.js`) e testei:
   - `GET /health` → OK
   - `GET /manifest.json` → manifesto correto
   - `GET /components/rawrecoveryengine/1.0.0/linux` → download com checksum íntegro
   - Requisição de componente inexistente → `404`
   - Tentativa de path traversal (`..%2f..%2fetc/...`) → `400` (bloqueado)
4. Do lado do BDS, rodei o `DependencyManager` de ponta a ponta contra o servidor real:
   - `configureUpdateServer('http://localhost:8787')`
   - `getComponentsStatus()` detectou corretamente `needsUpdate: true` via manifesto
   - `updateComponent('rawEngine', ...)` baixou, verificou checksum, rodou smoke-test no
     binário staged, trocou atomicamente, revalidou o binário já instalado, e persistiu
     backup + manifesto local
   - O binário instalado rodou de verdade (`RawRecoveryEngine version` retornou JSON válido)
   - Uma segunda checagem confirmou `needsUpdate: false` (mesmo checksum)
   - Simulei uma corrupção do binário instalado e testei `rollbackComponent('rawEngine')`
     — restaurou o backup e o binário voltou a funcionar
5. **Bugs reais encontrados e corrigidos durante esse teste** (não teria pegado só lendo o
   código): `_downloadFile` só suportava `https://`, quebrando com um Update Server HTTP
   interno; e o bit de execução (`chmod +x`) não era garantido após copiar o binário em
   Linux/Mac, fazendo a instalação "funcionar" mas o binário não rodar.

## Deploy

Este é um projeto Node/Express **independente do Electron** — roda em qualquer servidor
com Node 18+ (VPS, container, etc.), separado da aplicação desktop.

```bash
cd update-server
npm install
```

### 1. Empacotar componentes

Organize os binários em `components/<nome>/<versao>/<plataforma>.<ext>`:

```text
components/
├── rawrecoveryengine/
│   └── 1.0.0/
│       └── win32.exe
├── untrunc/
│   └── 2024.1/
│       └── win32.zip
└── ffmpeg/
    └── 7.1.0/
        ├── win32.zip
        └── linux.tar.xz
```

O prefixo do nome do arquivo (`win32`, `linux`, `darwin`) é obrigatório e é como o
`build-manifest.js` identifica a plataforma.

### 2. Gerar o manifest.json

```bash
node build-manifest.js --base-url https://updates.suaempresa.com --bds-version 1.0.3
```

Isso varre `components/`, pega a versão mais recente de cada componente (ordenação
semver-like), calcula o SHA-256 de cada pacote, e escreve `manifest.json`.

### 3. Subir o servidor

```bash
node server.js
# ou: PORT=443 node server.js
```

Recomendado colocar atrás de um reverse proxy (nginx/Caddy) com HTTPS em produção — o
`ToolUpdater` do BDS suporta tanto `http://` quanto `https://`, mas HTTPS é o padrão
recomendado para distribuição de binários executáveis.

## Configuração no BDS

Em **Configurações** (ou diretamente no `settings.json`), preencher `updateServerUrl` com
a URL base do servidor (ex: `https://updates.suaempresa.com`). A partir daí:

- `DependencyManager.getComponentsStatus()` consulta o manifesto primeiro; componentes
  listados nele usam o fluxo do Update Server (checksum sempre obrigatório).
- Componentes **não** listados no manifesto continuam usando o fluxo padrão (GitHub
  releases, ou instalação manual quando marcados como `manualInstallOnly`).
- Isso significa que, assim que vocês publicarem uma versão do `RawRecoveryEngine` (hoje
  manual) no Update Server, o BDS passa a atualizá-lo automaticamente — sem precisar de
  nenhuma mudança de código.

## Endpoints

| Método | Rota                                    | Descrição                          |
|--------|------------------------------------------|-------------------------------------|
| GET    | `/health`                                 | Verificação de saúde                |
| GET    | `/manifest.json`                          | Manifesto atual                     |
| GET    | `/components/:name/:version/:file`        | Download de um pacote de componente |

## Segurança

- Validação de path traversal nos parâmetros de `/components/:name/:version/:file`
  (testado e confirmado bloqueando `../` e separadores de caminho).
- O manifesto é estático (gerado por build, não montado dinamicamente a cada request) —
  o que está publicado é exatamente o que foi gerado, sem superfície de injeção em runtime.
- Checksum SHA-256 é **sempre obrigatório** neste fluxo (diferente do GitHub, onde o
  checksum só é verificado se o release publicar o campo `digest`).
