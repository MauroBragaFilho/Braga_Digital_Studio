# IPC do Braga Digital Studio

Todos os canais `ipcMain.handle` do app passam por UM registrador, que confere o remetente e valida os argumentos
antes de chamar o handler (RK-010). O `preload.js` é gerado da mesma tabela de canais (RK-010 / RK-067).

```
src/ipc/channels.js         TABELA ÚNICA: canal, domínio, args (esquema), retorno, estratégia de erro, api no preload
src/ipc/schema.js           construtores de esquema (t.string, t.id, t.file...) e o validador (sem dependências)
src/ipc/channelRegistry.js  handle(canal, [esquema], fn): remetente + argumentos + estratégia de erro
src/ipc/<domínio>Handlers.js  os handlers (chamam handle(...), nunca ipcMain.handle)
src/ipc/validate.js         validadores de caminho/arquivo/pasta/URL reaproveitados pelos esquemas e handlers
scripts/generate-preload.js gera o preload.js a partir da tabela (npm run generate:preload / verify:preload)
```

## O que o registrador faz em CADA chamada

1. **Remetente**: só aceita o frame principal da página do app (`file://.../renderer/index.html`, em desenvolvimento e
   empacotado). `<webview>` (YouTube Studio), sub-frames, `https://`, `data:`, `devtools:` e outras páginas `file://`
   são recusados com a mensagem "Origem da chamada não autorizada." (o motivo vai só para o log).
2. **Argumentos**: valida contra o esquema do canal e **recusa argumentos além dos declarados**. Caminhos
   (`t.absPath/t.file/t.dir`) chegam ao handler já resolvidos.
3. **Handler**: só é chamado se 1 e 2 passaram. Falhas de 1 e 2 seguem a **estratégia de erro** do canal, para o
   renderer continuar vendo o formato que já esperava:

| `error`   | Falha de remetente/argumentos vira                  | Domínios                                  |
|-----------|-----------------------------------------------------|-------------------------------------------|
| `throw`   | promessa rejeitada (`Error` com `code`)             | a maioria                                 |
| `wrap`    | `{ ok:false, error, code }` (sucesso: `{ ok:true, data }`, erro do handler também vira `{ ok:false }`) | `ai:*`, `modules:*` |
| `success` | `{ success:false, error }`                          | `system:openPath`, `youtube:exportCookies`, `logs:export` |
| `null`    | `null`                                              | `luts:getReferenceImage`                  |
| `empty`   | `[]`                                                | `library:getFolderFiles`, `projects:probeAudioStreams` |

Um canal sem entrada na tabela (ou sem esquema) **não registra**: o app falha ao iniciar em vez de expor um canal sem
validação. O teste `tests/ipc-registry.test.js` também falha se aparecer `ipcMain.handle` fora do registrador.

## Esquemas (`schema.js`)

Um esquema é uma **lista com uma especificação por argumento posicional** (o que o preload passa a `invoke`).

| Construtor                         | Valida                                                                              |
|------------------------------------|-------------------------------------------------------------------------------------|
| `t.string({ max, min, enum, pattern, nonBlank })` | texto (limite padrão 4096, sem byte nulo)                            |
| `t.number({ min, max })` / `t.int()` | número finito / inteiro                                                           |
| `t.id()`                           | inteiro positivo (aceita também `"12"`, como `assertPositiveInt`)                   |
| `t.boolean()`                      | booleano                                                                            |
| `t.object(shape, { maxKeys, strict })` | objeto simples; `shape` tipa as chaves conhecidas, chaves extras passam (o serviço decide) salvo `strict` |
| `t.array(item, { max, min })`      | lista (limite padrão 50000), cada item validado                                     |
| `t.oneOf([...])`                   | qualquer uma das especificações                                                     |
| `t.absPath()`                      | caminho absoluto (recusa relativo, `\0`, > 4096)                                    |
| `t.file()` / `t.dir()` / `t.searchDir()` | arquivo existente / pasta existente (não pode ser raiz de drive) / pasta existente (raiz permitida) |
| `t.cube()`                         | caminho absoluto de um `.cube`                                                      |
| `t.any('motivo')`                  | **sem** validação de tipo; o motivo é obrigatório e fica na tabela                  |

Modificadores: `optional` (aceita `undefined`/`null`), `label` (nome na mensagem), `name` (nome do argumento; o gerador do
preload usa), `allowEmpty` (`""` = não informado). Mensagens são em português e sem detalhes internos.

O esquema é **complementar**: validações específicas do serviço (existência no banco, regras de negócio) continuam no
handler; só foi removida a validação de tipo/limite/caminho que o esquema já cobre.

## Como adicionar um canal

1. **Tabela** — em `src/ipc/channels.js`, dentro do `define('<domínio>', '<estratégia>', { ... })` certo (ou um novo):

   ```js
   'projects:duplicate': {
     args: [ID('id', { label: 'ID do projeto' }), STR('name', 500, { nonBlank: true, label: 'Nome' })],
     returns: 'Projeto duplicado',
     api: ['duplicateProject']          // nome em window.bds; sem `api` = canal interno
   },
   ```

   - `args`: esquema por argumento posicional, **com `name`** (o preload gerado usa os nomes). Sem argumentos = `[]`
     (extras são recusados). Use `t.any('motivo')` só quando for realmente livre, com a justificativa.
   - `api`: string (usa os nomes dos argumentos) ou `{ name, params, call }` para assinaturas especiais, ex.:
     `{ name: 'aiChat', params: 'messages', call: '{ messages }' }`. Nome com ponto cria namespace (`downloads.add`).
   - `error`: herda a estratégia do domínio; sobrescreva por canal (`error: 'success'`) se o handler tem outro padrão.
   - Evento main → renderer novo: adicione `['onXxx', 'canal:evento']` em `EVENTS`.
2. **Handler** — em `src/ipc/<domínio>Handlers.js`, com `handle` (o esquema vem da tabela):

   ```js
   const { handle } = require('./channelRegistry');
   handle('projects:duplicate', (event, id, name) => projectService.duplicate(id, name));
   ```

   O handler recebe `(event, ...argumentosValidados)`. Não use `ipcMain` direto.
3. **Preload** — `npm run generate:preload` (reescreve `preload.js`; **não edite o preload à mão**).
4. **Testes** — `npm test`: `ipc-registry.test.js` (tabela x handlers x snapshot), `preload-generated.test.js`
   (preload confere com o gerador e superfície igual a `tests/fixtures/preload-surface.json`),
   `ipc-channels-snapshot.test.js` e `ipc-wiring.test.js`. Ao adicionar/remover canais de propósito, atualize os
   snapshots: `UPDATE_IPC_SNAPSHOT=1 node --test tests/ipc-channels-snapshot.test.js` e, para `window.bds`, regenere
   `tests/fixtures/preload-surface.json` a partir do preload novo (veja `tests/helpers/preload-surface.js`).

`npm run verify:preload` falha se o `preload.js` diferir do que o gerador produz (ex.: edição manual).

## Canais travados no processo principal (exemplo: assistente de IA)

Esquema e remetente não bastam quando um recurso só pode existir em certas condições. O assistente de IA (`ai:chatStart`,
`ai:chatCancel`, `ai:historyGet`, `ai:historyClear`) confere em CADA chamada, no handler (`assistantBlock` em
`aiHandlers.js`): app não empacotado + módulo `ai` ligado + interruptor "Ativar assistente" ligado. Se faltar algo, o canal
devolve `{ ok:false, code:'AI_DISABLED' }` (estratégia `wrap`). Esconder o botão no renderer é só conforto; a trava real é esta.
Respostas em streaming chegam por eventos (`ai:chatDelta`, `ai:chatDone`, `ai:chatError`), listados em `EVENTS`.
A "liberação no app final" é uma única constante (`ASSISTANT_ALLOWED_IN_PACKAGED_APP` em `src/services/ai/releaseGate.js`).

**Ferramentas do assistente: NÃO existe canal para elas.** O modelo pede ferramentas ao processo principal pelo laço do
chat (`AssistantChat` → `ToolBox`, ver `.docs/ASSISTENTE_IA_FERRAMENTAS.md`); o renderer só envia texto (`ai:chatStart`) e
cancela (`ai:chatCancel`). A confirmação das ações (transcrever, criar projeto) é um diálogo nativo do main
(`dialog.showMessageBox`), que o renderer não consegue acionar nem pular. A única adição de superfície para isso é o evento
`ai:chatStatus` (main para renderer): `{ id, text, kind }` com `kind` = `tool`, `confirm`, `notice` ou `clear`, mostrado como
linha de status no chat. Por isso um canal novo do tipo "executar ferramenta" ou "confirmar" nunca deve ser criado:
`tests/ai-assistant-tools.test.js` falha se aparecer qualquer canal `ai:*` com "tool" ou "confirm" no nome.

## Remetente confiável (detalhes)

`senderProblem(event)` exige: `event.senderFrame` presente, **sem `parent`** (frame principal), `event.sender.getType()`
diferente de `webview`, `senderFrame.url` e `sender.getURL()` iguais à página do app (consulta e âncora ignoradas;
no Windows sem diferenciar maiúsculas). O `<webview>` do YouTube Studio roda sem o preload (o `main.js` o remove em
`will-attach-webview`), então hoje nem tem `window.bds`; o registrador é a segunda barreira caso isso mude.
