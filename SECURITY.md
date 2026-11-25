# Política de Segurança — Braga Digital Studio

*(English summary at the end of this file.)*

O Braga Digital Studio (BDS) é um programa local, mantido por uma pessoa. Esta página diz como avisar sobre uma falha de
segurança e o que esperar em troca.

## Versões que recebem correções

Só a versão mais recente publicada nas Releases recebe correções de segurança, em regime de melhor esforço. Não há contrato de
suporte nem prazo garantido.

## Como relatar uma falha de segurança

**Não abra uma issue pública** com os detalhes de uma falha. Use um destes canais:

1. **Relato privado do GitHub:** na página do repositório, aba **Security → Report a vulnerability**. Se esse botão não
   aparecer, a opção ainda não está ativada no repositório: use o e-mail.
2. **E-mail:** <obragafilho00@gmail.com>, com o assunto "Segurança BDS".

Conte: a versão do BDS (Configurações → Sobre e licenças → Sobre), os passos para reproduzir, o que a falha permite fazer e, se tiver, uma sugestão
de correção. **Não envie** senhas, chaves, tokens, nem arquivos ou dados reais de clientes: um exemplo fictício basta.

## O que esperar

Estes prazos são metas, não promessas:

- confirmação de que recebi o relato: até 7 dias;
- primeira avaliação (se é uma falha real e qual a gravidade): até 14 dias;
- correção publicada em uma nova versão, em prazo que depende da gravidade;
- crédito ao relator na nota da correção, se ele quiser.

Pedimos divulgação coordenada: a falha só deve ser divulgada depois que a correção estiver publicada, ou em 90 dias, o que vier
primeiro.

## O que está no escopo

- O aplicativo desktop, o instalador e o atualizador.
- A comunicação com o celular (BDS Mobile) e o servidor MCP local.
- O envio automático ao YouTube e o uso da conta do YouTube nos downloads.
- O armazenamento das chaves de serviços de IA e de transcrição em nuvem e o envio de conteúdo a esses serviços (só quando a
  pessoa os liga).

Fora do escopo, por serem de terceiros: falhas no Electron, FFmpeg, yt-dlp, spotDL, ExifTool, Whisper, llama.cpp e nas outras
ferramentas que o BDS usa. Relate-as ao projeto de origem; se o BDS usar uma versão afetada, avise também por aqui. Também ficam fora ataques que
exigem acesso físico ao computador ou controle total da conta de usuário do Windows.

**Limitações já conhecidas:** o link com o celular usa HTTP, sem criptografia, e só deve ser usado em rede de confiança ou por
cabo; enquanto o instalador não tiver assinatura digital (veja a [Política de Assinatura de Código](CODE_SIGNING_POLICY.md)),
o Windows pode mostrar um aviso no primeiro uso.

## Se um problema afetar os usuários

Se for confirmado um problema que alcance quem usa o BDS (por exemplo, uma versão comprometida ou um token de publicação ou
assinatura vazado), o roteiro é este:

1. **Conter:** retirar a versão afetada das Releases e revogar os tokens envolvidos.
2. **Corrigir:** publicar uma nova versão e orientar a atualização.
3. **Avisar:** registrar uma nota de segurança nas Releases e no README, dizendo o que aconteceu, quem foi afetado e o que fazer.
4. **Registrar:** guardar data, causa, impacto e correção de cada incidente.

O BDS não envia ao autor a sua biblioteca nem os seus arquivos. Relatórios de falha ficam só no seu computador (e são apagados
depois de 30 dias); só chegam ao autor se você os enviar. Se você usa o BDS com dados de terceiros (clientes, alunos,
eventos) e um incidente puder alcançá-los, cabe a você, como responsável por esses dados, avaliar se precisa avisar os titulares e
a ANPD (LGPD, art. 48). O autor ajuda com o que souber sobre o problema.

---

## English summary

Braga Digital Studio (BDS) is a local desktop program maintained by one person.

- **Supported versions:** only the latest release gets security fixes, on a best-effort basis.
- **Reporting:** please do **not** open a public issue. Use GitHub's private vulnerability reporting (Security tab → Report a
  vulnerability; if the button is not there, the option is not enabled yet) or write to <obragafilho00@gmail.com> with the subject "BDS security". Include the BDS version,
  steps to reproduce and the impact. Do not send passwords, tokens or real customer data.
- **What to expect (targets, not promises):** acknowledgement within 7 days, first assessment within 14 days, a fix in a new
  release depending on severity, and credit if you want it. We ask for coordinated disclosure: after the fix is published or after
  90 days, whichever comes first.
- **Scope:** the desktop app, installer, updater, the phone link (BDS Mobile), the local MCP server, the YouTube upload queue and
  the optional YouTube account use, and the storage of AI and cloud-transcription keys. Flaws in third-party tools (Electron,
  FFmpeg, yt-dlp, spotDL, ExifTool, Whisper, llama.cpp) belong to their own projects.
- **Known limitations:** the phone link uses plain HTTP and should only be used on a trusted network or over USB; until installers
  are code-signed, Windows may show a warning on first run.
- **If users are affected:** we pull the affected release, revoke the tokens involved, publish a fixed version, post a security
  notice and keep a record. BDS does not send your library or files to the author; if you process other people's personal data
  with BDS, assessing whether to notify data subjects and the regulator is your responsibility as the data controller.
