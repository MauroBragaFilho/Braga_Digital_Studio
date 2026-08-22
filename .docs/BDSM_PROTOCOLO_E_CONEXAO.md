# 📱 Protocolo BDSM — Guia de Conexão e Integração

> **BDSM** (*Braga Device Sync & Media Protocol*)  
> Especificação técnica de comunicação e sincronização entre o **Braga Digital Studio (Desktop)** e dispositivos móveis / câmeras compatíveis (BDS Companion, smartphones, etc.).

---

## 📌 1. Visão Geral

O protocolo BDSM é uma camada de comunicação leve baseada em **HTTP/REST + mDNS (Bonjour)**, projetada para permitir que o **Braga Digital Studio** descubra, transfira mídias, gerencie LUTs 3D (.cube) e sincronize dados de projetos com dispositivos móveis em tempo real.

### Principais Recursos
- **Zero Configuração:** Descoberta automática na rede local via mDNS (Bonjour).
- **Dual-Mode:** Conexão sem fio (Wi-Fi) ou cabeada de alta velocidade via USB (ADB Forward).
- **Transferência Streaming:** Download com suporte a barra de progresso em tempo real.
- **Sincronização Bidirecional de LUTs:** Envio e exclusão de perfis de cor `.cube` com detecção de conflitos por hash.

---

## 🔌 2. Modos de Conexão

O BDS suporta dois canais de transporte simultâneos:

```
┌─────────────────────────────────────────────────────────────┐
│                 Braga Digital Studio (Desktop)              │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
       (1) Wi-Fi (mDNS / Bonjour)      (2) USB (ADB Port Forward)
               │                               │
               ▼                               ▼
┌───────────────────────────────┐ ┌───────────────────────────┐
│     Smartphone / Câmera       │ │   Smartphone Conectado    │
│      (Rede Local: 8080)       │ │     (127.0.0.1:8080)      │
└───────────────────────────────┘ └───────────────────────────┘
```

### 2.1 Conexão Sem Fio (Wi-Fi / mDNS)
- **Descoberta:** O dispositivo anuncia o serviço mDNS `_bdsm._tcp` na rede local.
- **Porta Padrão:** `8080` (HTTP).
- **Vantagem:** Totalmente sem fios, ideal para transferências rápidas no estúdio ou em campo.

### 2.2 Conexão via Cabo USB (ADB Forward)
- **Túnel Local:** O BDS executa automaticamente:
  ```bash
  adb forward tcp:8080 tcp:8080
  ```
- **Endereço de Sondagem:** `http://127.0.0.1:8080/api`
- **Vantagem:** Maior velocidade de transferência e carregamento contínuo da bateria do dispositivo.

---

## 🏷️ 3. Cabeçalhos HTTP (Headers)

Todas as requisições enviadas pelo Desktop para o dispositivo incluem os headers de identificação:

| Header | Valor | Descrição |
|---|---|---|
| `X-BDSM-Client` | `BragaDigitalStudio-Desktop` | Identifica o cliente desktop do BDS |
| `X-BDSM-Version` | `1.0` | Versão do protocolo utilizada |
| `Accept` | `application/json` | Formato padrão de resposta |

---

## 📡 4. Endpoints da API REST

A API do dispositivo deve responder sob o prefixo `/api`:

### 4.1 Descoberta e Diagnóstico

#### `GET /api/discovery/info`
Retorna as informações do dispositivo conectado.

**Resposta de Sucesso (`200 OK`):**
```json
{
  "deviceName": "Galaxy S24 Ultra - Câmera A",
  "deviceModel": "SM-S928B",
  "appVersion": "1.0.0",
  "batteryLevel": 85,
  "totalStorageBytes": 536870912000,
  "freeStorageBytes": 214748364800,
  "isCharging": false
}
```

---

### 4.2 Mídias e Arquivos

#### `GET /api/media`
Lista todos os arquivos de mídia gravados no dispositivo disponíveis para importação.

**Resposta de Sucesso (`200 OK`):**
```json
[
  {
    "id": "VID_20260820_153022",
    "filename": "VID_20260820_153022.mp4",
    "filesize": 104857600,
    "duration": 45.2,
    "width": 3840,
    "height": 2160,
    "fps": 60.0,
    "codec": "hevc",
    "createdAt": "2026-08-20T18:30:22Z"
  }
]
```

#### `GET /api/media/:id/download`
Realiza o download binário (stream) do arquivo de vídeo ou áudio.
- **Header retornado:** `Content-Length: <tamanho_em_bytes>`
- **Content-Type:** `video/mp4`, `audio/wav`, etc.

#### `GET /api/media/:id/thumbnail`
Retorna a miniatura da mídia (imagem JPEG/WebP) para exibição na grade do BDS.

#### `DELETE /api/media/:id`
Exclui a mídia do dispositivo após importação bem-sucedida (se solicitado pelo usuário).

---

### 4.3 Sincronização de LUTs 3D (.cube)

#### `GET /api/luts`
Lista os perfis de cor e LUTs instalados no dispositivo móvel.

**Resposta de Sucesso (`200 OK`):**
```json
[
  {
    "name": "BDS_Cinema_Warm.cube",
    "relativePath": "Cinema/BDS_Cinema_Warm.cube",
    "size": 102450,
    "hash": "a1b2c3d4e5f6..."
  }
]
```

#### `POST /api/luts/upload`
Envia um arquivo `.cube` do computador para a memória do dispositivo móvel.
- **Formato:** `multipart/form-data`
- **Campos:**
  - `file`: Arquivo `.cube` binário
  - `relativePath`: Subpasta de destino no dispositivo (ex: `Sony_SLog3/Cinema.cube`)

**Respostas:**
- `200 OK` — LUT transferida com sucesso.
- `409 Conflict` — Arquivo com o mesmo nome mas conteúdo diferente já existe.

#### `DELETE /api/luts/:path`
Remove uma LUT do dispositivo.

---

## 🛠️ 5. Como Implementar um Dispositivo Compatível

Para criar um aplicativo (Android, iOS ou microcontrolador) compatível com o BDS:

1. **Subir Servidor HTTP:** Inicie um servidor HTTP local na porta `8080`.
2. **Anunciar via mDNS:**
   - Tipo de serviço: `_bdsm._tcp`
   - Porta: `8080`
   - TXT Records (opcional): `name=NomeDoDispositivo`, `model=Modelo`
3. **Implementar os Endpoints:** Implemente as rotas `/api/discovery/info`, `/api/media`, `/api/media/:id/download` e `/api/luts`.

---

## 🔍 6. Diagnóstico e Resolução de Problemas

| Sintoma | Possível Causa | Solução |
|---|---|---|
| Dispositivo não aparece no Wi-Fi | Isolamento de cliente AP no roteador ou firewall bloqueando mDNS | Desative o isolamento de rede ou utilize conexão via cabo USB |
| Dispositivo USB não responde | Depuração USB desativada no Android | Ative a "Depuração USB" em Opções do Desenvolvedor |
| Erro `409 Conflict` no upload de LUT | O mesmo nome de arquivo já existe com hash diferente | Renomeie a LUT no BDS ou exclua a versão anterior no celular |

---

*Documento técnico oficial — Braga Digital Studio © 2026 Mauro Braga.*
