# RawRecoveryEngine

Motor interno de diagnóstico, decodificação e reparo estrutural de RAW (CR2/ARW/NEF)
usado pelo BDS (Braga Digital Studio). Baseado em `rawpy` (wrapper de LibRaw), empacotado
como executável standalone via PyInstaller — o usuário final do BDS **não precisa** ter
Python, rawpy ou LibRaw instalados.

## Testado nesta sessão (Linux, prova de conceito)

- `identify` — diagnóstico completo com fabricante/modelo/resolução/ISO via EXIF + LibRaw.
- `export` — decodificação real e exportação para TIFF 16-bit (testado com CR2 real de 26MB,
  gerou TIFF de ~127MB, 5792x3804, `uint16`, 3 canais).
- `repair` — reconstrução estrutural por combinação de cabeçalho da referência + dados de
  sensor (Bayer) do arquivo corrompido. Testado com um CR2 corrompido artificialmente
  (primeiros 64KB sobrescritos com bytes aleatórios) + referência íntegra: o arquivo
  reconstruído voltou a ser decodificável e os dados de pixel batem 100% com o original
  (`np.array_equal` confirmado).
- Empacotamento com PyInstaller: build limpo, binário standalone de ~35MB gerado e testado
  ponta a ponta nos 3 comandos acima, sem Python instalado no ambiente de execução.

## ⚠️ Sobre o build do .exe para Windows

O PyInstaller compila **nativo para a plataforma onde ele é executado**. Eu rodei e validei
o pipeline completo aqui em Linux (prova de que o `.spec`, os hidden imports e o
empacotamento da LibRaw dinâmica funcionam), mas **não é possível gerar um `RawRecoveryEngine.exe`
válido para Windows a partir de um ambiente Linux**. Isso precisa rodar em:

- uma máquina Windows real (rode `build_windows.ps1`), ou
- um runner `windows-latest` do GitHub Actions (recomendado, para reprodutibilidade).

## Build automático via GitHub Actions (recomendado)

Já existe um workflow pronto em `.github/workflows/build-raw-recovery-engine.yml`. Ele builda
em um runner `windows-latest` de verdade — resolve o problema de não dar pra gerar o `.exe`
a partir de Linux.

**Pré-requisito**: este `raw_recovery_engine/` (incluindo a pasta `.github/workflows/`) precisa
estar dentro do repositório Git do BDS (ou de um repositório próprio), na raiz do repo — o
GitHub só lê workflows que estão em `.github/workflows/` na raiz.

### Como disparar

**Manualmente**, a qualquer momento:
1. Vá em Actions → "Build RawRecoveryEngine (Windows)" → "Run workflow".
2. O `.exe` fica disponível como artefato do build (aba do run, seção "Artifacts") por 90 dias.

**Automaticamente**, criando uma tag versionada (também publica uma Release no GitHub com o
`.exe` anexado, pronto para link de download direto):
```bash
git tag raw-recovery-engine-v1.0.0
git push origin raw-recovery-engine-v1.0.0
```

**Em todo push** que mexer em `raw_recovery_engine/**` nas branches `main`/`master`, o workflow
também builda automaticamente (só como artefato, sem criar Release) — funciona como um teste
de fumaça contínuo, pra pegar quebra de build cedo.

O workflow já inclui:
- Instalação das dependências (`requirements.txt`)
- Build via `RawRecoveryEngine.spec`
- **Smoke test real**: roda `RawRecoveryEngine.exe version` e falha o build se o binário não executar
- Cálculo do SHA-256 (arquivo `RawRecoveryEngine.exe.sha256` ao lado do `.exe`, no artefato/release)

O SHA-256 gerado é o que você usa no `manifest.json` do Update Server (via `build-manifest.js`,
que já calcula automaticamente) ou pode ser usado manualmente para conferência.

## Build manual (alternativa)
```powershell
powershell -ExecutionPolicy Bypass -File build_windows.ps1
```
Gera `dist\RawRecoveryEngine.exe`.

### Linux/Mac (útil para CI/testes, não gera o .exe)
```bash
chmod +x build_linux.sh
./build_linux.sh
```

## Uso (linha de comando)

```bash
RawRecoveryEngine.exe identify <arquivo.CR2>
RawRecoveryEngine.exe export   <arquivo.CR2> <saida.tiff> [--tolerant]
RawRecoveryEngine.exe repair   <corrompido.CR2> <referencia.CR2> <saida.CR2>
RawRecoveryEngine.exe version
```

Toda saída estruturada vai para STDOUT como uma única linha JSON. Mensagens de progresso
vão para STDERR. Códigos de saída: `0` sucesso, `1` falha de decodificação/reparo,
`2` erro de uso.

## Integração no BDS

1. Buildar `RawRecoveryEngine.exe` (Windows) conforme acima.
2. Colocar o `.exe` na pasta de ferramentas do BDS (`tools/RawRecoveryEngine.exe`).
3. O `rawRecoveryService.js` do BDS já está preparado para chamar este binário único no
   lugar do par `dcraw_emu` + `raw-repair` (ver changelog da Fase 2).
4. Quando vocês publicarem releases deste binário em um repositório GitHub próprio, o
   `ToolUpdater` pode passar a auto-atualizar este componente — hoje ele está marcado como
   `manualInstallOnly` porque não há uma release pública para consultar.

## Próximos passos sugeridos (não implementados nesta sessão)

- Suporte a mais formatos RAW (CR3, RAF, RW2, ORF, DNG) — LibRaw já suporta a maioria,
  bastaria expandir `SUPPORTED_RAW_EXTENSIONS` no `rawRecoveryService.js` e testar cada um.
- Heurística de `repair` mais sofisticada (hoje é um "header splice" simples — funciona bem
  quando o dano está concentrado no cabeçalho/IFD, mas não tenta reparar dados de sensor
  corrompidos no meio do arquivo).
- Assinatura de código do `.exe` (evita alertas do SmartScreen/Defender no Windows).
