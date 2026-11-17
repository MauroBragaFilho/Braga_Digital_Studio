'use strict';

const { execFile } = require('node:child_process');
const { systemExe } = require('../infrastructure/hardware/systemExe');

// Discos fixos do PC para o armazenamento da sidebar (P13). Antes o cálculo usava 'D:\' fixo: somava um
// disco que podia nem existir (ou ser um pendrive) e ignorava E:, F:... Só DriveType=3 (disco local fixo):
// leitores de cartão vazios e unidades removíveis ficam de fora (consultar leitor vazio trava segundos).
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, drives }

/** Converte a saída (uma letra por linha, ex. "C:") em raízes únicas ("C:\\"). */
function parseDriveList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]):\s*$/.exec(line);
    if (m) {
      const root = `${m[1].toUpperCase()}:\\`;
      if (!out.includes(root)) out.push(root);
    }
  }
  return out;
}

function queryFixedDrives() {
  return new Promise((resolve) => {
    const cmd = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $_.DeviceID }';
    execFile(systemExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(err ? [] : parseDriveList(stdout)));
  });
}

/**
 * Raízes dos discos a somar. No Windows, os discos fixos (com a do sistema sempre incluída); fora dele, só a raiz.
 * @param {string} systemRoot
 * @returns {Promise<string[]>}
 */
async function listLocalDriveRoots(systemRoot) {
  if (process.platform !== 'win32') return [systemRoot];
  if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), drives: await queryFixedDrives() };
  const sys = String(systemRoot || 'C:\\').toUpperCase();
  return cache.drives.includes(sys) ? cache.drives.slice() : [sys, ...cache.drives];
}

module.exports = { listLocalDriveRoots, parseDriveList };
