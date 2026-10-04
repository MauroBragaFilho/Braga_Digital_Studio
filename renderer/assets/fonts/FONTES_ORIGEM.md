# Fontes empacotadas: origem, versão e verificação

Fontes de interface do app (offline, carregadas por `@font-face` em `renderer/style.css`, com `font-display: swap`).
Só arquivos dos repositórios OFICIAIS de cada projeto; nada de pacotes de terceiros, CDN ou conversão local.
Licença: SIL Open Font License 1.1 (textos em `renderer/assets/fonts/OFL-*.txt` e na página "Sobre e licenças").
Baixado em 2026-10-04. Os arquivos são o conjunto de glifos COMPLETO que o projeto publica (inclui latino e latino
estendido para o português), sem subconjunto nem conversão.

## Inter 4.1 (texto e interface; pesos 400 e 600/700)

Origem: release oficial `v4.1` de https://github.com/rsms/inter
Pacote: https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
(33.707.794 bytes, SHA-256 do zip `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`)
Arquivos usados, extraídos de `web/` dentro do zip, sem alteração:

| Arquivo em `renderer/assets/fonts/` | Origem no zip | Bytes | SHA-256 |
|---|---|---|---|
| `Inter-Regular.woff2` | `web/Inter-Regular.woff2` | 111.268 | `e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085` |
| `Inter-SemiBold.woff2` | `web/Inter-SemiBold.woff2` | 114.812 | `5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301` |

Licença: `LICENSE.txt` do zip, copiada para `OFL-Inter.txt`.

## Montserrat 7.222 (títulos; peso 700)

Origem: repositório oficial https://github.com/JulietaUla/Montserrat, tag `v7.222` (a release do GitHub não traz anexos;
os arquivos web oficiais ficam em `fonts/webfonts/` desse tag).
URL: https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/fonts/webfonts/Montserrat-Bold.woff2

| Arquivo em `renderer/assets/fonts/` | Bytes | SHA-256 |
|---|---|---|
| `Montserrat-Bold.woff2` | 86.804 | `294653dc1466dcda027c8ff4d80f7bc8fb074fc0daacab9afde68c1f7646bb1d` |

Licença: https://raw.githubusercontent.com/JulietaUla/Montserrat/v7.222/OFL.txt (4.392 bytes), copiada para `OFL-Montserrat.txt`.

## Tamanho

Acréscimo ao pacote: 312.884 bytes de fontes (cerca de 306 KB) + 8.772 bytes de licenças. Meta: até ~700 KB.

## Como conferir

`tests/design-tokens.test.js` recalcula o SHA-256 de cada arquivo e exige que esteja neste documento, que o `@font-face`
aponte para arquivos existentes e que as licenças estejam em `src/config/third-party-licenses.json`
(gerado por `node scripts/generate-licenses.js`; `--check` valida).
