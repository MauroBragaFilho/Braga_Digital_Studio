#!/usr/bin/env bash
# Build do RawRecoveryEngine para Linux/Mac (útil para CI ou testes locais rápidos).
# O binário do Windows (.exe) SÓ pode ser gerado rodando este mesmo processo em uma máquina
# Windows real ou em um runner windows-latest do GitHub Actions — o PyInstaller compila
# nativo para a plataforma onde ele é executado.
set -euo pipefail

echo "== RawRecoveryEngine :: build $(uname -s) =="

python3 -m venv .venv_build
source .venv_build/bin/activate

pip install --upgrade pip
pip install -r requirements.txt

pyinstaller --clean --noconfirm RawRecoveryEngine.spec

if [ -f "./dist/RawRecoveryEngine" ]; then
  echo "Build concluído: dist/RawRecoveryEngine"
  sha256sum ./dist/RawRecoveryEngine
else
  echo "Build falhou: RawRecoveryEngine não foi gerado."
  exit 1
fi

deactivate
