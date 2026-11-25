# Política de Assinatura de Código — Braga Digital Studio

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Estado atual:** o fluxo de assinatura está pronto no repositório, mas depende de configuração (o token e o ID da organização
> na SignPath). Enquanto ela não estiver feita, as Releases saem **sem** assinatura digital (foi o caso da v1.1.2) e a
> verificação é pelo SHA-256 (veja *Verificação pelo usuário*). Este aviso sai quando a primeira Release assinada for publicada.

*(English summary at the end of this file.)*

## Escopo

Esta política vale para os instaladores Windows (`braga-digital-studio-<versão>-windows-x64.exe`) do **Braga Digital Studio (BDS)**,
publicados em <https://github.com/MauroBragaFilho/Braga_Digital_Studio>. O projeto é software livre,
licenciado sob a [GPL-3.0](LICENSE). Só são assinados binários construídos a partir do código-fonte deste
repositório; o BDS não assina nem redistribui binários de terceiros como se fossem seus.

## Papéis e permissões

| Papel | Quem | O que pode |
|---|---|---|
| Autor / mantenedor | [Mauro Braga](https://github.com/MauroBragaFilho) | Escreve e aprova o código; cria as tags de release |
| Revisor | Mauro Braga | Revisa as alterações que entram na `main` |
| Aprovador de assinatura | Mauro Braga | Aprova no SignPath cada pedido de assinatura de produção |

Hoje o projeto tem um único mantenedor, que acumula os três papéis. Se entrarem novos colaboradores, esta tabela
será atualizada antes de eles receberem qualquer permissão de escrita, aprovação ou assinatura.

## Quando um build é assinado

- Somente builds de **produção** disparados por uma **tag de versão** (`vX.Y.Z`) criada a partir da branch `main`
  são enviados para assinatura, e só quando `SIGNPATH_API_TOKEN` (secret) e `SIGNPATH_ORGANIZATION_ID` (variable) estão
  configurados no repositório. Sem eles, o instalador sai sem assinar.
- Pushes comuns, pull requests, branches de teste e execuções manuais do fluxo de release **não** geram binários assinados.
- O pedido de assinatura de produção sai do workflow
  [`.github/workflows/release-bds.yml`](.github/workflows/release-bds.yml) (job `build-windows`), rodando em **runners
  hospedados pelo GitHub**. O [`release-sign.yml`](.github/workflows/release-sign.yml) é só um teste manual da assinatura (build
  e envio à SignPath, sem publicar Release; o gatilho por tag está desativado). O SignPath confere a origem (repositório,
  commit, workflow) com o GitHub; esses metadados não podem ser forjados pelo script de build.
- A política de assinatura de produção no SignPath exige **aprovação manual** do aprovador acima antes de o
  certificado ser usado; o workflow espera essa aprovação por até 24 horas.
- Só o instalador do Windows (`.exe`) é assinado. O zip portátil, o AppImage e o `.deb` não são. Depois da assinatura o
  workflow exige que o Windows reconheça a assinatura como válida (`Get-AuthenticodeSignature`) e só então calcula o
  `SHA256SUMS.txt`, que cobre todos os arquivos da Release.

## Como o código é revisado antes de assinar

1. As alterações entram na `main` por commit do mantenedor ou por pull request, e o CI (`ci.yml`) roda sintaxe,
   lint e testes.
2. Por prática do mantenedor, contribuições de terceiros só entram por pull request revisado por ele.
3. Antes de criar a tag, o mantenedor confere o que mudou desde a última versão (`git log` / `git diff`).
4. O workflow de release repete as verificações (`npm run check`, `npm run lint`, `npm test`) e só prossegue se
   passarem. Dependências são instaladas com `npm ci` (versões travadas no `package-lock.json`).
5. O workflow confere que o commit da tag pertence à `main` antes de qualquer envio à SignPath; uma tag fora dela derruba o
   build do Windows e a Release não é publicada.

## Proteção dos segredos

- O token de API do SignPath (`SIGNPATH_API_TOKEN`) fica **apenas** em *GitHub Actions secrets* do repositório.
  Nunca é gravado no código, em logs ou em arquivos de configuração. O ID da organização (`SIGNPATH_ORGANIZATION_ID`) não é
  segredo e fica em *Actions variables*, como o slug do projeto e o da política (opcionais).
- O token pertence a um usuário do SignPath com permissão de **submitter** apenas nesta política de assinatura.
- A chave privada do certificado **nunca sai** do HSM do SignPath; o BDS e o GitHub nunca têm acesso a ela.
- Segredos não são expostos a builds de pull requests (o passo de assinatura só liga em tag de versão, e o GitHub não
  entrega segredos a PRs de forks). A conta do mantenedor usa autenticação em dois fatores.
- Em caso de suspeita de vazamento, o token é revogado no SignPath e recriado, e a ocorrência é registrada nas
  Releases.

## Privacidade

O BDS não envia dados do usuário a ninguém por causa da assinatura. O programa só se conecta à internet para o
que o usuário pede (downloads, verificação de atualização, etc.); veja o [README](README.md) e os termos do
projeto.

## Verificação pelo usuário

Cada Release traz o `SHA256SUMS.txt` com o hash SHA-256 de todos os arquivos. Quando a assinatura está configurada, o
instalador do Windows vai assinado; Releases publicadas sem essa configuração saem sem assinatura (o PowerShell mostra
`NotSigned`), e nelas só vale conferir o SHA-256. No Windows: *botão direito no `.exe` → Propriedades → Assinaturas
Digitais*, ou em PowerShell:

```powershell
Get-AuthenticodeSignature .\braga-digital-studio-<versão>-windows-x64.exe
Get-FileHash .\braga-digital-studio-<versão>-windows-x64.exe -Algorithm SHA256
```

## English summary

Free code signing provided by SignPath.io, certificate by SignPath Foundation. Braga Digital Studio is GPL-3.0
software. Only release builds triggered by a version tag (`vX.Y.Z`) on the `main` branch, built on GitHub-hosted
runners by `release-bds.yml` (only the Windows installer is signed), are submitted for signing, and each signing request
requires manual approval by the maintainer (Mauro Braga) in SignPath. Code is reviewed by the maintainer and checked by CI
(syntax, lint, tests) before tagging. The `SIGNPATH_API_TOKEN` is stored only as a GitHub Actions secret; the private key
never leaves SignPath's HSM. **Current status:** signing is optional and not configured yet, so releases such as v1.1.2
are published unsigned; verify them with the SHA-256 in `SHA256SUMS.txt`.
