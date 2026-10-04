# Protocolo BDSM: conexão, pareamento e API

> **BDSM** (*Braga Device Sync & Media Protocol*): comunicação entre o **Braga Digital Studio (desktop)** e o celular com o app **BDS Mobile**.
>
> Fonte da verdade: o código Kotlin do servidor do celular (`core-network/.../LinkModule.kt`, `auth/LinkAuthManager.kt`, `sharing/MediaLibraryService.kt`, `sharing/LutLibraryService.kt`, `HttpRange.kt`). Este documento foi corrigido contra esse código; a documentação do app (`BDSM_PLUGIN_OBS.md`) descreve o pareamento corretamente, mas o desktop nunca o implementava (ver seção 9).

---

## 1. Visão geral

HTTP/REST em texto puro na porta `8080` do celular, mais descoberta mDNS. Desde a versão com pareamento do BDS Mobile, **quase tudo exige um token**: sem ele o celular responde `401 Pairing required`. O desktop só entrega mídia e LUTs depois de **parear** (o operador confere um código de 4 dígitos e aprova no celular).

Recursos usados pelo desktop:

- Descoberta automática por Wi-Fi (mDNS) e por cabo USB (`adb forward`).
- Pareamento por consentimento duplo (computador pede, celular aprova).
- Listar, baixar (com `Content-Length` e retomada por `Range`) e apagar gravações; miniaturas.
- LUTs `.cube`: listar, **enviar** e apagar. **Não existe download de LUT** pelo celular.

---

## 2. Modos de conexão e prioridade

```
Braga Digital Studio (desktop)
   |-- Wi-Fi: mDNS _bdsm._tcp  --> celular (rede local, porta do serviço)
   '-- USB: adb forward tcp:8080 tcp:8080 --> celular em 127.0.0.1:8080
```

- **Wi-Fi:** o celular publica o serviço `_bdsm._tcp` (nome "BDS Link"); não há registros TXT. O desktop também repete a sondagem dos aparelhos já conhecidos.
- **USB:** o desktop executa `adb forward tcp:8080 tcp:8080` e sonda `http://127.0.0.1:8080/api`.
- **USB tem prioridade (comportamento atual):** o mesmo aparelho pode responder por USB e por Wi-Fi. Ele é identificado por `physicalId = "deviceName|deviceModel"` (igual nas duas conexões; o celular não publica um id único). Se há conexão USB, **só o cartão USB aparece**; a Wi-Fi do mesmo aparelho fica oculta e volta sozinha se o cabo sair (`pickPreferredConnection` em `DeviceDiscoveryService.js`). O `id` do cartão continua `"<nome>_usb"` / `"<nome>_wifi"` (o histórico de importação depende dele).
- **Sondagem:** a cada **8 s** (`usbPollInterval`); aparelho sem resposta por mais de **15 s** é removido.
- **Modo de teste (somente desenvolvimento):** com a variável de ambiente `BDS_TEST_BDSM_PORT=<porta>`, a sondagem "USB" vai para `127.0.0.1:<porta>` (por exemplo o celular falso `tests/fixtures/fake-bdsm-phone.js`) e o `adb forward` é ignorado. É ignorada no app empacotado.

---

## 3. Autenticação e pareamento

### 3.1 Regras do servidor

- Tudo sob `/api` exige `Authorization: Bearer <token>` (ou `?token=<token>`), **exceto** `/api/pair/*` e `/api/discovery/info`.
- Sem token válido: `401` com o texto `Pairing required`.
- O servidor guarda só o **hash SHA-256** do token. Um `clientId` tem **um único token**: parear de novo invalida o anterior.
- Pedido pendente dura **90 s**. `429` (`Pending pairing request exists`) quando já há pedido pendente do mesmo IP, 3 pedidos pendentes ou menos de 5 s desde uma recusa/expiração.

### 3.2 Fluxo

```
desktop                                   celular
  | POST /api/pair/request {clientId, clientName}   |
  |------------------------------------------------>|  mostra o código e o pedido ao operador
  |<-- {requestId, code:"4821", expiresInSec:90} ---|
  |  (mostra o código ao usuário)                    |  operador confere o MESMO código e aprova
  | GET /api/pair/status/{requestId}  (a cada 1,5 s)|
  |<-- {state:"PENDING"} ... {state:"APPROVED", token:"..."} (token UMA vez)
  | Authorization: Bearer <token> em todo o resto   |
```

- `state`: `PENDING`, `APPROVED`, `DENIED`, `EXPIRED`. `GET /api/pair/status/{id}` só responde ao **mesmo IP** que pediu (`404` caso contrário ou se o pedido foi descartado).
- `clientId`: letras, números, `- _ . :`, até 64. `clientName`: até 40 caracteres, sem controle.
- `401` com token já salvo = o celular não reconhece mais este computador: descartar o token e parear de novo.

### 3.3 Implementação no desktop

| Peça | Arquivo | Função |
|---|---|---|
| Identidade e tokens | `src/core/integrations/bdsm/BdsmAuth.js` | `clientId` (uuid gerado uma vez), `clientName` ("Braga Digital Studio - <computador>", até 40), tokens por aparelho com chave `deviceName\|deviceModel` |
| Fluxo | `src/core/integrations/bdsm/BdsmPairing.js` | `status`, `start`, `cancel`, `forget`; consulta a cada 1,5 s; eventos `bdsm:pairing` |
| Cliente HTTP | `src/core/integrations/bdsm/BdsmClient.js` | `Authorization: Bearer` em tudo; erros com `code` estável |
| Contrato | `src/core/integrations/bdsm/BdsmProtocol.js` | rotas, mensagens, `deviceKey`, `normalizeMediaItem` |

**Onde o token fica e por que é seguro**

- Só no **processo principal**. O renderer recebe estado, código e tempo restante; nunca o token. Miniaturas são buscadas no main (`bdsm:getThumbnail`) e entregues como `data:` URL: uma URL com `?token=` vazaria o token em cache, DevTools e logs.
- Em disco, no arquivo `bdsm-pairing.json` da pasta de configuração do app, **criptografado por `safeStorage`** (DPAPI no Windows). Sem criptografia disponível o token vale só durante a sessão e **nunca** é gravado em texto puro.
- O token nunca é registrado em log (o `clientId` não é segredo).
- A sondagem inicial (`/api/discovery/info`) **não envia o token**: só depois de identificar o aparelho (`deviceName|deviceModel`) o desktop repete o pedido com o token do aparelho certo; se a resposta continuar mínima, o token não vale **naquele endereço** e o aparelho conta como não pareado (o token só é apagado por um `401` numa operação real, ao parear de novo ou ao esquecer: a sondagem não o apaga, porque outro aparelho com o mesmo nome e modelo dividiria a chave).

**Limitação conhecida:** a chave do aparelho é `deviceName|deviceModel` (o celular não publica um id único). Dois celulares com o MESMO nome e modelo dividem o pareamento (parear um substitui o token do outro) e o token de um pode ser enviado ao outro na sondagem.

**Cancelar** só para de acompanhar: o celular mantém o pedido por até 90 s. Um novo "parear" dentro desse prazo **retoma o mesmo pedido** (mesmo código), em vez de provocar `429`.

**Esquecer pareamento** remove o token do desktop. O celular continua listando este computador como pareado até o operador revogá-lo no app do celular.

---

## 4. Endpoints

Prefixo `/api`. `[T]` = exige token.

### 4.1 `GET /api/discovery/info`

Sem token (ou token inválido): informação mínima.

```json
{ "deviceName": "Scorpio", "deviceModel": "SM-A515F", "appVersion": "1.0.0", "authRequired": true }
```

Com token válido: o mesmo objeto sem `authRequired` e com os dados completos.

```json
{
  "deviceName": "Scorpio", "deviceModel": "SM-A515F", "appVersion": "1.0.0",
  "batteryLevel": 87, "totalStorageBytes": 137438953472, "freeStorageBytes": 68719476736, "isCharging": false
}
```

O desktop marca o dispositivo com `paired` e `authRequired` e só mostra bateria e armazenamento quando pareado (antes mostrava "100%" inventado).

### 4.2 Pareamento

- `POST /api/pair/request` (corpo JSON até 2 KB): `200 {requestId, code, expiresInSec}`; `400 Invalid JSON`; `413`; `429`.
- `GET /api/pair/status/{id}`: `200 {state, token?}`; `404`.

### 4.3 Mídia `[T]`

`GET /api/media` devolve `MediaItemDto`:

```json
[{ "id": "uuid", "filename": "VID_20261001_120000.mp4", "filesize": 104857600, "duration": 45.2,
   "width": 1920, "height": 1080, "fps": 30.0, "codec": "h264", "createdAt": "2026-10-01T12:00:00Z" }]
```

- Só gravações **concluídas** (`COMPLETED`/`COPIED`). `duration` em **segundos**. O desktop converte para `{ id, name, size, duration, ... }` (`BdsmProtocol.normalizeMediaItem`).
- `GET /api/media/{id}/download`: `Content-Length`, `Accept-Ranges: bytes`; `Range: bytes=N-` responde `206` com `Content-Range`; intervalo inválido `416`; `404` se não existe ou não está concluída. A importação confere se o tamanho recebido é o do `Content-Length`.
- `GET /api/media/{id}/thumbnail`: arquivo de imagem ou `404`.
- `DELETE /api/media/{id}`: `200`; `404` (inclusive gravação em andamento ou arquivo que não pôde ser apagado).

### 4.4 LUTs `[T]`

- `GET /api/luts`: `[{ "name", "relativePath", "size", "hash" }]` (`hash` = SHA-256 hexadecimal minúsculo).
- `POST /api/luts/upload`: `multipart/form-data` com o campo de texto `relativePath` e **um** arquivo (o nome do campo do arquivo é livre; o desktop usa `file`).
  - `200` ok (mesmo caminho e mesmo conteúdo também dá `200`).
  - `400` caminho inválido (`Invalid relativePath`), multipart inválido ou faltando campo/arquivo.
  - `409` mesmo caminho com conteúdo diferente: `{ "relativePath", "existingHash", "newHash" }`. **O celular nunca sobrescreve**: para substituir é preciso `DELETE` e depois `POST`.
  - `413` acima de **32 MB**.
  - Caminho válido: só `.cube`, até 4 segmentos, até 255 caracteres, sem `..`, `.`, segmento vazio, `\` ou caracteres de controle.
- `DELETE /api/luts/{path...}`: o caminho vai em **segmentos separados** (`/api/luts/Cinema/Sub/a.cube`, cada um codificado). `200`, `404` ou `400 Invalid path`.
- **Não há `GET` de LUT**: o celular não serve o arquivo.

### 4.5 WebSocket `/ws/link` (referência)

Telemetria e tally para o plugin do OBS, exige token. Mensagens de entrada até 1024 caracteres. O desktop não usa.

### 4.6 Códigos de erro e mensagens do desktop

| HTTP | `code` (BdsmError) | Mensagem para o usuário |
|---|---|---|
| (rede/tempo) | `DEVICE_UNREACHABLE` | Sem conexão com o celular. Confira o cabo ou o Wi-Fi e se o BDS Mobile está aberto. |
| 401 | `PAIRING_REQUIRED` | O celular pede pareamento. Confirme o código no aparelho para continuar. (abre o diálogo "Conectar ao celular") |
| 429 | `DEVICE_BUSY` | O celular ainda tem um pedido de pareamento aberto. Aguarde alguns segundos e tente de novo. |
| 403 | `FORBIDDEN` | O celular não deu permissão para esta ação. |
| 404 | `NOT_FOUND` | O celular não encontrou este item. Atualize a lista e tente de novo. |
| 409 | `CONFLICT` | Já existe no celular um arquivo com o mesmo nome e conteúdo diferente. |
| 413 | `TOO_LARGE` | O arquivo é grande demais para o celular aceitar. |
| 400 | `BAD_REQUEST` | O celular recusou o pedido (dados inválidos). |
| outros | `DEVICE_ERROR` | O celular não conseguiu concluir a operação. Tente de novo. |

Estados finais do pareamento (evento `bdsm:pairing`): `DENIED` ("O pareamento foi recusado no celular."), `EXPIRED` ("O tempo para aprovar no celular acabou."), `ERROR`.

---

## 5. Sincronização de LUTs (comportamento real)

Como o celular não serve LUTs, a sincronização é **de ida (computador para celular)**:

- LUT só no computador (`.cube`, até 4 níveis de pasta): **enviada**.
- LUT só no celular: apenas **listada** (`remoteOnly`); não dá para baixá-la. O plano mantém `download` sempre vazio.
- Mesmo caminho com conteúdo diferente (conflito): **nada muda** por padrão. Com `resolution: 'overwrite_remote'` o desktop apaga a LUT do celular e envia a do computador. (`keep_both` e `overwrite_local` dependeriam de download e não existem.)
- Arquivos `.3dl` locais são ignorados (o celular só aceita `.cube`).
- Falha fatal (pareamento recusado, celular sem resposta) interrompe e mostra o motivo; falhas por arquivo contam em `failed`. `executeSync` devolve `{ completed, failed, skipped, total }`.

---

## 6. Canais IPC do desktop

| Canal | Entrada | Retorno |
|---|---|---|
| `bdsm:getMedia` | `ip, port` | `[{ id, name, size, duration, width, height, fps, codec, createdAt }]` |
| `bdsm:importMedia` | `{ ip, port, deviceId, items, destFolder, projectId }` | quantidade importada (se todas falharem, lança o motivo real) |
| `bdsm:analyzeLutSync` | `ip, port` | `{ upload, download: [], conflict, identical, remoteOnly }` |
| `bdsm:executeLutSync` | `{ ip, port, plan }` | `{ completed, failed, skipped, total }` |
| `bdsm:pairingStatus` | `ip, port` | `{ deviceName, deviceModel, paired, authRequired, tokenRejected }` |
| `bdsm:pairStart` | `ip, port` | `{ state: 'PENDING', code, secondsLeft }` ou `{ state: 'APPROVED', alreadyPaired: true }` |
| `bdsm:pairCancel` | `ip, port` | `true` se havia pedido em andamento |
| `bdsm:pairForget` | `ip, port` | `true` |
| `bdsm:getThumbnail` | `ip, port, id` | `data:` URL da miniatura |
| `bdsm:pairing` (evento) | | `{ ip, port, state, code, secondsLeft, errorCode?, message? }`, `state` = `PENDING`, `APPROVED`, `DENIED`, `EXPIRED`, `ERROR`, `CANCELED` |

Erros do celular chegam ao renderer como `BDSM:<CÓDIGO>:<mensagem>` (o Electron só transporta a mensagem); `renderer/utils/bdsmError.js` separa código e texto.

---

## 7. Como implementar um dispositivo compatível

1. Servidor HTTP na porta `8080`.
2. Anunciar `_bdsm._tcp` via mDNS na mesma porta.
3. Implementar `/api/discovery/info` (mínimo sem token, completo com token), `/api/pair/request`, `/api/pair/status/{id}`, `/api/media`, `/api/media/{id}/download` (com `Content-Length` e `Range`), `/api/luts` e `/api/luts/upload`.
4. Exigir `Authorization: Bearer` em tudo, exceto `/api/pair/*` e `/api/discovery/info`; guardar só o hash do token.

O celular falso `tests/fixtures/fake-bdsm-phone.js` é uma implementação de referência usada nos testes (`node tests/fixtures/fake-bdsm-phone.js [porta] [approve|deny|expire]`).

---

## 8. Diagnóstico

| Sintoma | Causa provável | Solução |
|---|---|---|
| Cartão com "Pareamento necessário" | Computador ainda não pareado (ou o celular revogou) | Clique em "Importar mídia" ou "Sincronizar LUTs", confira o código no celular e toque em Aprovar |
| "O celular ainda tem um pedido de pareamento aberto" | Pedido anterior ainda ativo (90 s) ou recusado há menos de 5 s | Aprove/recuse no celular ou aguarde cerca de 1 minuto |
| "Sem conexão com o celular" | Cabo/Wi-Fi, app fechado, firewall | Conferir o cabo, a rede e abrir o BDS Mobile |
| Dispositivo não aparece no Wi-Fi | Isolamento de clientes no roteador ou bloqueio de mDNS | Desativar o isolamento ou usar o cabo USB |
| Dispositivo USB não responde | Depuração USB desativada | Ativar a Depuração USB |
| LUT não substitui a do celular (`409`) | O celular nunca sobrescreve | O desktop apaga e reenvia quando a resolução é "substituir no celular" |

---

## 9. Divergências encontradas e corrigidas

| # | Documentação/desktop dizia | O código do celular (Kotlin) mostra | Correção |
|---|---|---|---|
| 1 | Desktop não autenticava (causa do `HTTP 401` e do "Falha desconhecida") | Tudo sob `/api`, exceto `/api/pair/*` e `/api/discovery/info`, exige `Bearer` (`LinkModule.kt:91-95`) | Pareamento completo (`BdsmAuth`, `BdsmPairing`) e `Authorization: Bearer` em todas as chamadas |
| 2 | `/discovery/info` sempre trazia bateria e armazenamento | Sem token: só `deviceName, deviceModel, appVersion, authRequired` (`LinkModule.kt:98-110`) | Sondagem em duas etapas; bateria/armazenamento só pareado (antes mostrava 100% inventado) |
| 3 | Cabeçalhos `X-BDSM-Client`/`X-BDSM-Version` identificam o desktop | O servidor não lê esses cabeçalhos; a identificação é o token | Removidos do código e deste documento |
| 4 | Item de mídia: `size`/`name` (a tela usava `m.name`, `m.size`) | `MediaItemDto`: `filename`, `filesize` | `normalizeMediaItem` converte; a tela mostrava nomes `undefined` |
| 5 | Existe `GET /api/luts/{path}` para baixar LUT (`getLutDownloadUrl`) | Não há rota de download (`getLutFile` é código morto) | Download removido; sincronização é de ida; plano com `remoteOnly` |
| 6 | `DELETE /luts/` com o caminho em UM segmento codificado (`a%2Fb.cube`) | Rota `/luts/{path...}`: segmentos separados | `LUTS_DELETE` codifica por segmento |
| 7 | Enviar LUT de novo sobrescreve; "conflito: manter as duas" | `409` com `{relativePath, existingHash, newHash}`; nunca sobrescreve; sem download | Substituir = `DELETE` + `POST`; conflitos ficam como estão por padrão |
| 8 | Upload sem limite ou tratamento de erros | `413` acima de 32 MB; só `.cube`, até 4 segmentos, 255 caracteres | Cliente recusa antes (`TOO_LARGE`); análise ignora `.3dl` e caminhos que o celular recusaria |
| 9 | Resposta do upload tratada só por `409`/`!ok` | `400`, `409`, `413`, `500` com significados distintos | Erros com `code` estável e mensagem específica |
| 10 | Download por URL sem credencial; `fetch` sem checar o tamanho | `Content-Length`, `Accept-Ranges`, `Range`/`416` | Download autenticado; confere `Content-Length`; cliente aceita `Range` |
| 11 | Endpoints `/projects/sync` e `/device/status` | Não existem | Removidos |
| 12 | `physicalId` era o nome do aparelho | O celular não publica id; `deviceName\|deviceModel` é o que existe nas duas formas de resposta | `physicalId = "deviceName\|deviceModel"` (o `id` do cartão não mudou) |
| 13 | mDNS com TXT `name`/`model` | `_bdsm._tcp` "BDS Link", sem TXT | Documento corrigido |
| 14 | Polling a cada 5 s | 8 s no código (`DeviceDiscoveryService`); offline após 15 s | Documento corrigido |
| 15 | `window.api`, eventos `sony:camera_connected`/`sony:status_updated`, `getAllDevices` com `{success, devices}`, `sonyImportItems` com lista de strings | `window.bds`; eventos `sony-camera:connected`/`sony-camera:status-update`; array com `type` `MTP`/`USB`/`BDSM`/`SONY`; `{ imported, failed }` | Documento de API corrigido |
| 16 | Erro genérico "Falha desconhecida" / "HTTP 401" | | Mensagens específicas por `code` (sem conexão, pareamento necessário, recusado, expirado, ocupado, sem permissão) |

*Documento técnico do Braga Digital Studio.*
