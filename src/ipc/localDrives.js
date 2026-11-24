'use strict';

const { execFile } = require('node:child_process');
const { systemExe } = require('../infrastructure/hardware/systemExe');

// Discos fixos do PC para o armazenamento da sidebar (P13). Antes o cálculo usava 'D:\' fixo: somava um
// disco que podia nem existir (ou ser um pendrive) e ignorava E:, F:... Só DriveType=3 (disco local fixo) COM partição
// num disco físico: leitores de cartão vazios, unidades removíveis e discos virtuais (Google Drive) ficam de fora
// (consultar leitor vazio trava segundos).
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, drives }

const GOOGLE_DRIVE_LABEL = /google\s*drive/i;

/**
 * Converte a saída em raízes únicas ("C:\\"). Cada linha é "C:" ou, no formato atual, "C:|<partições>|<rótulo>".
 * Só entram discos FÍSICOS: o Google Drive para computador (e discos de nuvem parecidos) aparece como disco local
 * (DriveType 3, FAT32, tamanho = cota da conta), mas não tem partição em disco nenhum; somá-lo inflava o total.
 * Plano B, se a consulta de partições falhar para todos: tira só os de rótulo "Google Drive".
 */
function parseDriveList(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]):(?:\|(\d+)\|(.*))?\s*$/.exec(line);
    if (!m) continue;
    const root = `${m[1].toUpperCase()}:\\`;
    if (entries.some((e) => e.root === root)) continue;
    entries.push({ root, parts: m[2] === undefined ? null : Number(m[2]), label: m[3] || '' });
  }
  const physical = entries.filter((e) => e.parts === null || e.parts > 0);
  const chosen = physical.length ? physical : entries.filter((e) => !GOOGLE_DRIVE_LABEL.test(e.label));
  return chosen.map((e) => e.root);
}

function queryFixedDrives() {
  return new Promise((resolve) => {
    const cmd = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { '
      + '$p = @(Get-CimAssociatedInstance -InputObject $_ -Association Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue).Count; '
      + "'{0}|{1}|{2}' -f $_.DeviceID, $p, $_.VolumeName }";
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
