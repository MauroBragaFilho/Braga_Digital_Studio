; =============================================================================
; Instalador do Braga Digital Studio: personalização (electron-builder + NSIS).
;
; Incluído pelo electron-builder (nsis.include). Usa só os macros oficiais do modelo "assistido":
;   customHeader, customInit, customInstallMode, customWelcomePage, customPageAfterChangeDir,
;   customFinishPage, customInstall, customUnInit, customUnWelcomePage, customUninstallPage, customUnInstall.
;
; O que faz:
;   - tema PRETO (fundo #000000, superfícies #1c1c1c, texto branco, secundário #a1a1a1, acento #ff0000)
;     em todas as páginas do instalador e do desinstalador (ver BdsStyle* e .docs/INSTALADOR.md);
;   - uma página pergunta "Instalação completa" ou "Instalação curta" (padrão: completa);
;   - depois de copiar os arquivos, executa o próprio programa instalado em modo sem janela
;     (--setup-components=full|basic) que baixa e confere os componentes; o instalador mostra o
;     progresso lendo o arquivo de progresso que o programa grava;
;   - falha de rede NÃO falha a instalação: o programa conclui o que faltou na primeira abertura;
;   - atualização silenciosa (/S): não pergunta, não baixa nada e mantém o que existe;
;   - o desinstalador pergunta se mantém os dados do usuário (padrão: manter).
;
; Parâmetros de linha de comando (instalação manual/silenciosa):
;   /COMPONENTES=completa|curta|nenhuma   (em /S o padrão é "nenhuma")
;   /ATALHO=1                             cria o atalho na Área de Trabalho
;   /MODELO=<id>                          (teste) modelo de transcrição pequeno, ex.: tiny
;   /DADOS=<pasta>                        (teste) pasta de dados do usuário; o programa recebe --user-data-dir
; =============================================================================

; ---------------------------------------------------------------- paleta (cores do app) para o MUI
!define MUI_BGCOLOR 000000
!define MUI_TEXTCOLOR FFFFFF
!define MUI_INSTFILESPAGE_COLORS "FFFFFF 000000"

; O modelo só inclui isto quando NÃO existe customCheckAppRunning (definimos um abaixo): inclui aqui.
!include "getProcessInfo.nsh"
Var pid

; ---------------------------------------------------------------- variáveis (globais; este arquivo é incluído no início do script)
Var BdsDataDir        ; pasta de dados do usuário (padrão: %APPDATA%\<nome do pacote>)
Var BdsDataOverride   ; /DADOS= (só para testes)
Var BdsFont           ; fonte da interface (Segoe UI)
Var BdsOuter          ; janela externa já estilizada
Var BdsDlg            ; diálogo interno das páginas próprias (nsDialogs); vazio = procurar pelo diálogo atual

!ifndef BUILD_UNINSTALLER
  Var CompMode        ; "" (ainda não escolhido) | full | basic | none
  Var CompAsk         ; "1" = mostrar a página de escolha
  Var CompDesktop     ; "1" = criar atalho na Área de Trabalho
  Var CompModel       ; /MODELO= (teste)
  Var CompExit        ; código de saída do modo de componentes ("x" = não executou)
  Var CompProc        ; handle do processo do modo de componentes (para o cancelamento)
  Var CompLastMsg     ; última mensagem mostrada (evita repetir)
  Var CompRbFull
  Var CompRbBasic
  Var CompCbDesktop
  Var CompLicEdit     ; caixa de texto da licença
  !define MUI_CUSTOMFUNCTION_ABORT BdsOnAbort   ; chamado quando o usuário cancela (o MUI já define o .onUserAbort)
!else
  Var BdsUnRbKeep
  Var BdsUnRbDelete
  Var BdsUnDelete     ; "1" = apagar também os dados do usuário
!endif

; =============================================================================
; Tema preto: funções geradas para o instalador (prefixo vazio) e para o desinstalador (prefixo "un.")
; =============================================================================
!macro BdsStyleFuncs P
  ; Aplica a paleta a UM controle. Entrada: pilha = hwnd.
  Function ${P}BdsStyleControl
    Exch $0
    Push $1
    Push $2
    Push $3
    System::Call 'user32::GetClassNameW(p r0, w .r1, i 64)'
    StrCpy $3 $1 8
    ${If} $1 == "Static"
      SetCtlColors $0 "FFFFFF" "000000"
      SendMessage $0 0x30 $BdsFont 1
    ${ElseIf} $1 == "Edit"
      SetCtlColors $0 "FFFFFF" "1C1C1C"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_CFD", p 0)'
      SendMessage $0 0x30 $BdsFont 1
    ${ElseIf} $1 == "Button"
      System::Call 'user32::GetWindowLongW(p r0, i -16)i .r2'
      IntOp $2 $2 & 0xF
      ${If} $2 == 0
      ${OrIf} $2 == 1
        ; botão comum: tema escuro do Windows (Windows 10 1809 ou mais novo); nas versões antigas fica nativo
        System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
      ${Else}
        ; caixa de seleção / opção: sem o tema do Windows para a cor do texto valer
        System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
        SetCtlColors $0 "FFFFFF" "000000"
      ${EndIf}
      SendMessage $0 0x30 $BdsFont 1
    ${ElseIf} $1 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
      SendMessage $0 0x409 0 0x0000FF     ; PBM_SETBARCOLOR  = vermelho #ff0000 (COLORREF BGR)
      SendMessage $0 0x2001 0 0x1C1C1C    ; PBM_SETBKCOLOR   = #1c1c1c
    ${ElseIf} $1 == "SysListView32"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
      SendMessage $0 0x1001 0 0x000000    ; LVM_SETBKCOLOR
      SendMessage $0 0x1026 0 0x000000    ; LVM_SETTEXTBKCOLOR
      SendMessage $0 0x1024 0 0xFFFFFF    ; LVM_SETTEXTCOLOR
    ${ElseIf} $3 == "RichEdit"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
      SendMessage $0 0x443 0 0x1C1C1C     ; EM_SETBKGNDCOLOR
      ; texto branco (CHARFORMATW, 92 bytes, com CFM_COLOR)
      System::Call '*(i 92, i 0x40000000, i 0, i 0, i 0, i 0xFFFFFF, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0)p .r2'
      System::Call 'user32::SendMessageW(p r0, i 0x444, p 0, p r2)i .r3'
      System::Call 'user32::SendMessageW(p r0, i 0x444, p 4, p r2)i .r3'
      System::Free $2
      SendMessage $0 0x30 $BdsFont 1
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; Estiliza todos os controles de UM diálogo interno. Entrada: pilha = hwnd do diálogo.
  Function ${P}BdsStyleDialog
    Exch $1
    Push $0
    Push $2
    SetCtlColors $1 "FFFFFF" "000000"
    StrCpy $2 1000
    ${While} $2 <= 1060
      GetDlgItem $0 $1 $2
      ${If} $0 != 0
        Push $0
        Call ${P}BdsStyleControl
      ${EndIf}
      IntOp $2 $2 + 1
    ${EndWhile}
    StrCpy $2 1200
    ${While} $2 <= 1260
      GetDlgItem $0 $1 $2
      ${If} $0 != 0
        Push $0
        Call ${P}BdsStyleControl
      ${EndIf}
      IntOp $2 $2 + 1
    ${EndWhile}
    ; redesenha tudo (necessário quando chamado de fora da thread da interface, como no desinstalador)
    System::Call 'user32::RedrawWindow(p r1, p 0, p 0, i 0x185)'
    Pop $2
    Pop $0
    Pop $1
  FunctionEnd

  ; Estiliza a janela externa (uma vez) e o diálogo interno da página atual.
  Function ${P}BdsStylePage
    Push $0
    Push $1
    Push $2
    ${If} $BdsFont == ""
      CreateFont $BdsFont "Segoe UI" 9 400
    ${EndIf}
    ${If} $BdsOuter != $HWNDPARENT
      StrCpy $BdsOuter $HWNDPARENT
      ; barra de título escura (Windows 10 20H1 / 11): modo escuro, cor da barra e do texto
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x000000, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0xFFFFFF, i 4)'
      SetCtlColors $HWNDPARENT "FFFFFF" "000000"
      ; botões Voltar (3), Próximo (1) e Cancelar (2)
      GetDlgItem $0 $HWNDPARENT 1
      Push $0
      Call ${P}BdsStyleControl
      GetDlgItem $0 $HWNDPARENT 2
      Push $0
      Call ${P}BdsStyleControl
      GetDlgItem $0 $HWNDPARENT 3
      Push $0
      Call ${P}BdsStyleControl
      ; texto da marca e do cabeçalho
      GetDlgItem $0 $HWNDPARENT 1028
      SetCtlColors $0 "A1A1A1" "000000"
      SendMessage $0 0x30 $BdsFont 1
      GetDlgItem $0 $HWNDPARENT 1037
      SetCtlColors $0 "FFFFFF" "000000"
      SendMessage $0 0x30 $BdsFont 1
      GetDlgItem $0 $HWNDPARENT 1038
      SetCtlColors $0 "A1A1A1" "000000"
      SendMessage $0 0x30 $BdsFont 1
      ; linhas em relevo (cinza claro) escondidas: somem na paleta preta
      GetDlgItem $0 $HWNDPARENT 1256
      ShowWindow $0 0
      GetDlgItem $0 $HWNDPARENT 1045
      ShowWindow $0 0
    ${EndIf}
    ; diálogos internos: o da página atual (nsDialogs informa o dele) e todos os demais (o antigo fica escondido)
    ${If} $BdsDlg != ""
      Push $BdsDlg
      Call ${P}BdsStyleDialog
      StrCpy $BdsDlg ""
    ${EndIf}
    StrCpy $1 0
    ${For} $2 1 8
      FindWindow $1 "#32770" "" $HWNDPARENT $1
      ${If} $1 == 0
        ${Break}
      ${EndIf}
      Push $1
      Call ${P}BdsStyleDialog
    ${Next}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

; ---------------------------------------------------------------- funções (depois dos includes do modelo)
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro BdsStyleFuncs ""
    !include WordFunc.nsh
    !include StrContains.nsh
    !insertmacro WordFind

    ; --------------------------------------------------------------- pasta de instalação (mesma lógica do modelo)
    Function BdsInstFilesPre
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${If} $0 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    FunctionEnd

    Function BdsSkipIfUpdated
      ${If} ${isUpdated}
        Abort
      ${EndIf}
    FunctionEnd

    Function BdsPageShow
      Call BdsStylePage
    FunctionEnd

    ; --------------------------------------------------------------- página de licença (própria, na paleta preta)
    ; Mostra o texto do arquivo LICENSE da raiz do projeto (convertido a cada build em installer/license-nsis.txt).
    Function BdsLicensePageCreate
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Acordo de Licença" "Leia os termos antes de instalar o ${PRODUCT_NAME}."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      StrCpy $BdsDlg $0

      ${NSD_CreateLabel} 0u 0u 300u 12u "Se você aceita os termos, clique em Eu Concordo para continuar."
      Pop $0

      nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0u 14u 300u 118u ""
      Pop $CompLicEdit
      SetCtlColors $CompLicEdit "FFFFFF" "1C1C1C"

      ; carrega o texto aos poucos (linhas longas não estouram o limite de texto do instalador)
      ClearErrors
      FileOpen $1 "$PLUGINSDIR\bds-license.txt" r
      ${IfNot} ${Errors}
        FileSeek $1 2 SET                              ; pula o BOM UTF-16
        ${Do}
          FileReadUTF16LE $1 $2
          ${If} ${Errors}
            ${Break}
          ${EndIf}
          SendMessage $CompLicEdit 0xB1 -1 -1        ; EM_SETSEL: fim do texto
          System::Call 'user32::SendMessageW(p $CompLicEdit, i 0xC2, i 0, w r2)'  ; EM_REPLACESEL
        ${Loop}
        FileClose $1
      ${EndIf}
      ClearErrors
      SendMessage $CompLicEdit 0xB1 0 0              ; cursor no início
      SendMessage $CompLicEdit 0xB7 0 0              ; EM_SCROLLCARET

      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:Eu &Concordo"
      Call BdsStylePage
      nsDialogs::Show
    FunctionEnd

    Function BdsLicensePageLeave
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:&Próximo >"
    FunctionEnd

    ; --------------------------------------------------------------- página de escolha
    Function BdsComponentsPageCreate
      ${If} $CompAsk != "1"
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        StrCpy $CompMode "none"
        Abort
      ${EndIf}
      ${If} $installMode == "all"
        StrCpy $CompMode "none"
        Abort
      ${EndIf}
      ; Já existe instalação com componentes: não pergunta de novo e não mexe em nada.
      ${If} ${FileExists} "$BdsDataDir\data\setup-components.json"
      ${OrIf} ${FileExists} "$BdsDataDir\data\yt-dlp.exe"
        StrCpy $CompMode "none"
        Abort
      ${EndIf}
      ${If} $CompMode == ""
        StrCpy $CompMode "full"
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "Como você quer instalar?" "Você pode mudar isso depois, nas Configurações."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      StrCpy $BdsDlg $0

      ${NSD_CreateLabel} 0u 0u 300u 12u "É preciso estar conectado à internet para baixar os componentes."
      Pop $0

      ${NSD_CreateRadioButton} 0u 20u 300u 12u "Instalação completa (recomendada)"
      Pop $CompRbFull
      ${NSD_CreateLabel} 12u 33u 288u 24u "Instala o programa, as ferramentas e a transcrição. Fica pronto para usar. Download de cerca de 420 MB."
      Pop $0
      SetCtlColors $0 "A1A1A1" "000000"

      ${NSD_CreateRadioButton} 0u 66u 300u 12u "Instalação curta"
      Pop $CompRbBasic
      ${NSD_CreateLabel} 12u 79u 288u 24u "Instala o programa e as ferramentas básicas (cerca de 220 MB). A transcrição pode ser instalada depois, em Configurações > Módulos."
      Pop $0
      SetCtlColors $0 "A1A1A1" "000000"

      ${NSD_CreateCheckbox} 0u 116u 300u 12u "Criar atalho na Área de Trabalho"
      Pop $CompCbDesktop

      ${If} $CompMode == "basic"
        ${NSD_Check} $CompRbBasic
      ${Else}
        ${NSD_Check} $CompRbFull
      ${EndIf}
      ${If} $CompDesktop == "1"
        ${NSD_Check} $CompCbDesktop
      ${EndIf}

      Call BdsStylePage
      nsDialogs::Show
    FunctionEnd

    Function BdsComponentsPageLeave
      ${NSD_GetState} $CompRbFull $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $CompMode "full"
      ${Else}
        StrCpy $CompMode "basic"
      ${EndIf}
      ${NSD_GetState} $CompCbDesktop $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $CompDesktop "1"
      ${Else}
        StrCpy $CompDesktop "0"
      ${EndIf}
    FunctionEnd

    ; --------------------------------------------------------------- progresso
    ; Lê a linha "estado|percentual|fase|indice|total|saida" gravada pelo programa e atualiza a tela.
    Function BdsReadProgress
      ClearErrors
      FileOpen $R0 "$PLUGINSDIR\bds-progress.txt" r
      ${If} ${Errors}
        Return
      ${EndIf}
      FileRead $R0 $R1
      FileClose $R0
      ${If} $R1 == ""
        Return
      ${EndIf}
      ${WordFind} "$R1" "|" "+1" $R2
      ${WordFind} "$R1" "|" "+2" $R3
      ${WordFind} "$R1" "|" "+3" $R4
      ${If} $R2 != "run"
      ${AndIf} $R2 != "end"
        Return
      ${EndIf}
      ${If} $R3 == ""
        Return
      ${EndIf}
      ${If} $R4 == "engine"
        StrCpy $R5 "Baixando o motor de transcrição... $R3%"
      ${ElseIf} $R4 == "model"
        StrCpy $R5 "Baixando o modelo de transcrição... $R3%"
      ${ElseIf} $R4 == "settings"
        StrCpy $R5 "Finalizando... $R3%"
      ${Else}
        StrCpy $R5 "Baixando as ferramentas... $R3%"
      ${EndIf}
      ${If} $R5 != $CompLastMsg
        StrCpy $CompLastMsg $R5
        DetailPrint "$R5"
        FindWindow $R6 "#32770" "" $HWNDPARENT
        GetDlgItem $R6 $R6 1004
        SendMessage $R6 0x406 0 100   ; PBM_SETRANGE32 (0 a 100)
        SendMessage $R6 0x402 $R3 0   ; PBM_SETPOS
      ${EndIf}
    FunctionEnd

    ; --------------------------------------------------------------- execução do modo de componentes
    ; Entrada: $CompMode (full|basic), $CompModel e $BdsDataOverride (testes). Saída: $CompExit.
    Function BdsRunComponents
      StrCpy $CompExit "x"
      StrCpy $CompLastMsg ""
      SetDetailsPrint both
      DetailPrint "Preparando o download dos componentes..."
      Delete "$PLUGINSDIR\bds-progress.txt"
      Delete "$PLUGINSDIR\bds-cancel.txt"

      StrCpy $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --setup-components=$CompMode "--progress-file=$PLUGINSDIR\bds-progress.txt" "--cancel-file=$PLUGINSDIR\bds-cancel.txt"'
      ${If} $CompModel != ""
        StrCpy $0 '$0 "--model=$CompModel"'
      ${EndIf}
      ${If} $BdsDataOverride != ""
        StrCpy $0 '$0 "--user-data-dir=$BdsDataOverride"'
      ${EndIf}

      ; STARTUPINFO (68 bytes) e PROCESS_INFORMATION (16 bytes); sem janela (CREATE_NO_WINDOW)
      System::Call '*(i 68,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,i 0,&i2 0,&i2 0,i 0,i 0,i 0,i 0)p.r1'
      System::Call '*(p 0,p 0,i 0,i 0)p.r2'
      System::Call 'kernel32::CreateProcessW(p 0, w r0, p 0, p 0, i 0, i 0x08000000, p 0, p 0, p r1, p r2)i.r3'
      ${If} $3 == 0
        System::Free $1
        System::Free $2
        StrCpy $CompExit "99"
        DetailPrint "Não foi possível iniciar o download dos componentes."
        Return
      ${EndIf}
      System::Call '*$2(p .r4, p .r5)'
      System::Call 'kernel32::CloseHandle(p r5)'
      System::Free $1
      System::Free $2
      StrCpy $CompProc $4

      StrCpy $6 0
      BdsLoop:
        System::Call 'kernel32::WaitForSingleObject(p r4, i 300)i.r7'
        Call BdsReadProgress
        ${If} $7 != 258                  ; 258 = ainda rodando (WAIT_TIMEOUT)
          Goto BdsDone
        ${EndIf}
        IntOp $6 $6 + 1
        ${If} $6 > 20000                 ; ~100 min: o programa tem o próprio limite de 90 min
          System::Call 'kernel32::TerminateProcess(p r4, i 5)'
          Goto BdsDone
        ${EndIf}
        Goto BdsLoop
      BdsDone:
      Call BdsReadProgress
      System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r8)'
      System::Call 'kernel32::CloseHandle(p r4)'
      StrCpy $CompProc ""
      StrCpy $CompExit $8
      ${If} $CompExit == "0"
        DetailPrint "Componentes instalados."
      ${Else}
        DetailPrint "Alguns componentes não foram baixados. O programa conclui isso na primeira abertura."
      ${EndIf}
    FunctionEnd

    ; O usuário clicou em Cancelar durante o download: pede ao programa para parar e limpar os parciais.
    Function BdsOnAbort
      ${If} $CompProc != ""
        FileOpen $0 "$PLUGINSDIR\bds-cancel.txt" w
        FileClose $0
        System::Call 'kernel32::WaitForSingleObject(p $CompProc, i 20000)i.r0'
        ${If} $0 == 258
          System::Call 'kernel32::TerminateProcess(p $CompProc, i 3)'
        ${EndIf}
      ${EndIf}
    FunctionEnd
  !else
    ; --------------------------------------------------------------- desinstalador
    !insertmacro BdsStyleFuncs "un."

    Function un.BdsPageShow
      Call un.BdsStylePage
    FunctionEnd

    Function un.BdsDataPageCreate
      ${If} ${Silent}
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Seus dados" "O que fazer com a sua biblioteca e as suas configurações?"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      StrCpy $BdsDlg $0

      ${NSD_CreateLabel} 0u 0u 300u 12u "Quer manter seus dados?"
      Pop $0

      ${NSD_CreateRadioButton} 0u 20u 300u 12u "Manter meus dados (recomendado)"
      Pop $BdsUnRbKeep
      ${NSD_CreateLabel} 12u 33u 288u 24u "A biblioteca, as configurações e os componentes baixados continuam no computador. Você pode reinstalar depois sem perder nada."
      Pop $0
      SetCtlColors $0 "A1A1A1" "000000"

      ${NSD_CreateRadioButton} 0u 66u 300u 12u "Apagar tudo"
      Pop $BdsUnRbDelete
      ${NSD_CreateLabel} 12u 79u 288u 24u "Remove também a biblioteca, as configurações e os componentes baixados. Isso não pode ser desfeito."
      Pop $0
      SetCtlColors $0 "A1A1A1" "000000"

      ${NSD_Check} $BdsUnRbKeep
      Call un.BdsStylePage
      nsDialogs::Show
    FunctionEnd

    Function un.BdsDataPageLeave
      ${NSD_GetState} $BdsUnRbDelete $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $BdsUnDelete "1"
      ${Else}
        StrCpy $BdsUnDelete "0"
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; ---------------------------------------------------------------- inicialização (.onInit)
!macro customInit
  StrCpy $CompMode ""
  StrCpy $CompAsk "1"
  StrCpy $CompDesktop "0"
  StrCpy $CompModel ""
  StrCpy $CompExit "x"
  StrCpy $CompProc ""
  StrCpy $CompLastMsg ""
  StrCpy $BdsDataOverride ""

  ; texto da licença (arquivo LICENSE da raiz, preparado a cada build) para a página de licença própria
  InitPluginsDir
  File "/oname=$PLUGINSDIR\bds-license.txt" "${BUILD_RESOURCES_DIR}\license-nsis.txt"

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/COMPONENTES=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "completa"
      StrCpy $CompMode "full"
    ${ElseIf} $R1 == "curta"
      StrCpy $CompMode "basic"
    ${ElseIf} $R1 == "nenhuma"
      StrCpy $CompMode "none"
    ${EndIf}
    ${If} $CompMode != ""
      StrCpy $CompAsk "0"
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/ATALHO=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "1"
      StrCpy $CompDesktop "1"
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/MODELO=" $R1
  ${IfNot} ${Errors}
    StrCpy $CompModel $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DADOS=" $R1
  ${IfNot} ${Errors}
    StrCpy $BdsDataOverride $R1
  ${EndIf}
  ClearErrors

  ReadEnvStr $BdsDataDir "APPDATA"
  StrCpy $BdsDataDir "$BdsDataDir\${APP_PACKAGE_NAME}"
  ${If} $BdsDataOverride != ""
    StrCpy $BdsDataDir $BdsDataOverride
  ${EndIf}
!macroend

; ---------------------------------------------------------------- por usuário, sem administrador
; Pula a pergunta "para todos os usuários / só para mim": instala só para o usuário atual (sem administrador),
; a menos que já exista uma instalação para todos os usuários (aí mantém o comportamento original).
!macro customInstallMode
  ${If} $hasPerMachineInstallation != "1"
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend

; ---------------------------------------------------------------- páginas do instalador
; Boas-vindas, licença (texto do arquivo LICENSE da raiz do projeto) e pasta de instalação. Todas com a paleta preta.
!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE BdsSkipIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente instala o ${PRODUCT_NAME} no seu computador.$\r$\n$\r$\nClique em Próximo para continuar."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BdsPageShow
  !insertmacro MUI_PAGE_WELCOME

  Page custom BdsLicensePageCreate BdsLicensePageLeave

  !define MUI_PAGE_CUSTOMFUNCTION_PRE BdsSkipIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BdsPageShow
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro customPageAfterChangeDir
  Page custom BdsComponentsPageCreate BdsComponentsPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE BdsInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BdsPageShow
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "Abrir o ${PRODUCT_NAME}"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BdsFinishShow
  !insertmacro MUI_PAGE_FINISH

  Function BdsFinishShow
    StrCpy $BdsDlg $mui.FinishPage
    Call BdsStylePage
    ${If} $CompExit == "0"
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Tudo pronto! O ${PRODUCT_NAME} foi instalado e já pode ser usado."
    ${ElseIf} $CompExit != "x"
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:O ${PRODUCT_NAME} foi instalado, mas alguns componentes não foram baixados. O programa conclui isso na primeira abertura."
    ${Else}
      SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:O ${PRODUCT_NAME} foi instalado no seu computador."
    ${EndIf}
  FunctionEnd
!macroend

; ---------------------------------------------------------------- instalação
!macro customInstall
  ; atalho opcional na Área de Trabalho (o do Menu Iniciar já é criado pelo modelo)
  ${If} $CompDesktop == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}

  ; Atualização silenciosa (/S) sem /COMPONENTES: não baixa nada e mantém o que existe.
  ${If} $CompMode == ""
    StrCpy $CompMode "none"
  ${EndIf}
  ; Instalação "para todos os usuários" roda como administrador: os componentes ficam para a primeira abertura.
  ${If} $installMode == "all"
    StrCpy $CompMode "none"
  ${EndIf}
  ${If} $CompMode == "full"
  ${OrIf} $CompMode == "basic"
    Call BdsRunComponents
  ${EndIf}
!macroend

; ---------------------------------------------------------------- verificação "o programa está aberto?"
; É a primeira coisa que as páginas de progresso fazem (e demora alguns segundos, pois usa o PowerShell). A página de
; progresso do desinstalador não chama o callback de exibição, então o tema preto é aplicado aqui, ANTES da verificação.
; O restante é idêntico ao do modelo do electron-builder (mesmos macros).
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.BdsStylePage
  !else
    Call BdsStylePage
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; ---------------------------------------------------------------- desinstalação
!macro customUnInit
  StrCpy $BdsDataOverride ""
  StrCpy $BdsUnDelete "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DADOS=" $R1
  ${IfNot} ${Errors}
    StrCpy $BdsDataOverride $R1
  ${EndIf}
  ClearErrors
  ReadEnvStr $BdsDataDir "APPDATA"
  StrCpy $BdsDataDir "$BdsDataDir\${APP_PACKAGE_NAME}"
  ${If} $BdsDataOverride != ""
    StrCpy $BdsDataDir $BdsDataOverride
  ${EndIf}
!macroend

; Boas-vindas escura e pergunta sobre os dados (página própria, na mesma paleta; padrão: manter).
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Desinstalar o ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente remove o ${PRODUCT_NAME} do seu computador.$\r$\n$\r$\nClique em Próximo para continuar."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.BdsPageShow
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.BdsDataPageCreate un.BdsDataPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.BdsPageShow
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.BdsPageShow
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ; atalho da Área de Trabalho criado na instalação (o modelo não o remove quando não o cria sozinho)
    Delete "$oldDesktopLink"
    ; Apaga os dados só se o usuário escolheu "Apagar tudo" (em modo silencioso nunca apaga; use --delete-app-data).
    ${If} $BdsUnDelete == "1"
      StrLen $0 "$BdsDataDir"
      ${If} $0 > 9
      ${AndIf} ${FileExists} "$BdsDataDir\*.*"
        RMDir /r "$BdsDataDir"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
