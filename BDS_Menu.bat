@echo off
color 02
title Menu - Braga Digital Studio

:menu
cls
echo ==================================================
echo         BRAGA DIGITAL STUDIO - MENU
echo ==================================================
echo.
echo [1] Rodar o aplicativo sem instalar (Dev Mode)
echo [2] Gerar Instalador (NSIS)
echo [3] Gerar Versao Portable (Executavel direto)
echo [4] Sair
echo.
set /p opcao="Escolha uma opcao: "

if "%opcao%"=="1" goto run
if "%opcao%"=="2" goto installer
if "%opcao%"=="3" goto portable
if "%opcao%"=="4" goto end
goto menu

:run
cls
echo Iniciando o aplicativo...
call npm start
pause
goto menu

:installer
cls
echo Gerando instalador...
call npm run build
pause
goto menu

:portable
cls
echo Gerando versao portable...
call npm run build:portable
pause
goto menu

:end
exit
