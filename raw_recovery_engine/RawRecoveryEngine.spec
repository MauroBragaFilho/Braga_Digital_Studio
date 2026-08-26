# -*- mode: python ; coding: utf-8 -*-
# Spec do PyInstaller para o RawRecoveryEngine (BDS).
# Build (Windows):  pyinstaller RawRecoveryEngine.spec
# Build (Linux/Mac): pyinstaller RawRecoveryEngine.spec   (gera binário nativo da plataforma)
#
# IMPORTANTE: o executável final é sempre nativo da plataforma onde o PyInstaller roda.
# Para gerar o .exe de Windows, este build precisa ser executado em uma máquina/CI Windows
# (ou via cibuildwheel/GitHub Actions com runner windows-latest) — não é possível gerar um
# .exe válido rodando o PyInstaller a partir de Linux.

import sys
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

block_cipher = None

datas = []
binaries = []

# rawpy embute a LibRaw compilada como biblioteca dinâmica; garantimos que o PyInstaller
# a detecte e inclua no bundle (senão o .exe falha em runtime com DLL/so ausente).
try:
    binaries += collect_dynamic_libs('rawpy')
except Exception:
    pass

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=['exifread', 'tifffile', 'numpy'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'PyQt5', 'PySide2', 'tkinter'],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='RawRecoveryEngine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
