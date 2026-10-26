@echo off
title Menu - Braga Digital Studio

:menu
color 04
cls
echo ==================================================
echo         BRAGA DIGITAL STUDIO - MENU
echo ==================================================
echo.
echo [1] Rodar o aplicativo sem instalar (Dev Mode)
echo [2] Gerar Instalador (NSIS)
echo [3] Gerar Versao Portable (Executavel direto)
echo [4] Publicar Release (cria a tag e envia ao GitHub)
echo [0] Sair
echo.
set /p opcao="Escolha uma opcao: "

if "%opcao%"=="1" goto run
if "%opcao%"=="2" goto installer
if "%opcao%"=="3" goto portable
if "%opcao%"=="4" goto release
if "%opcao%"=="0" goto end
goto menu

:run
@echo off
color 04
cls
echo Iniciando o aplicativo...
call npm start
pause
goto menu

:installer
@echo off
color 02
cls
echo Gerando instalador...
call npm run build
pause
goto menu

:portable
color 0c
cls
echo Gerando versao portable...
call npm run build:win:portable
pause
goto menu

:release
color 0a
cls
echo ==================================================
echo   PUBLICAR RELEASE (tag + push = instaladores)
echo ==================================================
echo.
echo O script sobe a versao do package.json, faz o commit,
echo cria a tag vX.Y.Z e envia tudo ao GitHub. A tag dispara
echo o workflow que gera e publica os instaladores.
echo.
echo Exige: nada pendente de commit e tag ainda inexistente.
echo.
call node scripts\release-tag.js
pause
goto menu

:end
exit
