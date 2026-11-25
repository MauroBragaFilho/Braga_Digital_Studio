# LUTs embutidas

Estas LUTs (.cube) acompanham o instalador. Na primeira abertura do app (módulo de LUTs ou de Dispositivos ligado)
cada uma é copiada uma única vez para a pasta de LUTs do usuário; a que o usuário excluir não volta.

- No app instalado esta pasta vira `resources/luts-embutidas` (`build.extraResources` do `package.json`).
- Em desenvolvimento o app lê esta mesma pasta (`appPaths.bundledLutsDir`).
- Não coloque aqui arquivos com aviso de copyright de terceiros. As quatro LUTs utilitárias com aviso da Adobe
  (`8Bits Parcial para Completo`, `SMPTEToFull8`, `SMPTEToFull10` e `SMPTEToFull12`) ficam de fora de propósito.

## Procedência e licença

`PROCEDENCIA.json` lista cada arquivo com tamanho, SHA-256, origem, licença e `status`.

Os cabeçalhos das 40 LUTs trazem apenas "Enhanced with VOXCOLOR algorithms": nenhuma declara autor, ano, licença ou
origem. Por isso o `status` de todas é `a-confirmar` e:

- as `.cube` não vão para o Git (`.gitignore`; só `PROCEDENCIA.json` e este arquivo são versionados);
- `npm run build:*` (e `npm run verify:package -- --release`) falha enquanto houver `a-confirmar`.

Ao confirmar a procedência: preencha `origem` e `licenca`, troque o `status` para `confirmada`, ponha `"release": true`
em `PROCEDENCIA.json` e apague a linha das `.cube` do `.gitignore`. O `.gitattributes` já protege os bytes (sem
conversão de fim de linha).

Para trocar o conteúdo de uma LUT, atualize o `sha256` e o `bytes` dela em `PROCEDENCIA.json`: o `verify:package` e
os testes recalculam e reprovam se divergir.
