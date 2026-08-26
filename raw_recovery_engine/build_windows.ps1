# Build do RawRecoveryEngine.exe para Windows.
# Rodar em uma máquina Windows (ou runner windows-latest no GitHub Actions) com Python 3.10+.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File build_windows.ps1

$ErrorActionPreference = "Stop"

Write-Host "== RawRecoveryEngine :: build Windows ==" -ForegroundColor Cyan

python -m venv .venv_build
. .\.venv_build\Scripts\Activate.ps1

pip install --upgrade pip
pip install -r requirements.txt

pyinstaller --clean --noconfirm RawRecoveryEngine.spec

if (Test-Path ".\dist\RawRecoveryEngine.exe") {
    Write-Host "Build concluído: dist\RawRecoveryEngine.exe" -ForegroundColor Green
    Get-FileHash .\dist\RawRecoveryEngine.exe -Algorithm SHA256 | Format-List
} else {
    Write-Host "Build falhou: RawRecoveryEngine.exe não foi gerado." -ForegroundColor Red
    exit 1
}

deactivate
