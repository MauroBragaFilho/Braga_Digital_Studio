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
echo [0] Sair
echo.
set /p opcao="Escolha uma opcao: "

if "%opcao%"=="1" goto run
if "%opcao%"=="2" goto installer
if "%opcao%"=="3" goto portable
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
call npm run build:portable
pause
goto menu

:end
exit
