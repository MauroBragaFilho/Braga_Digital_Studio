/** Equipamentos do projeto (na Visão geral): etiquetas por equipamento e um formulário curto para adicionar. */
import { ws, $, mk, icon, setAppStatus, friendlyError } from './state.js';

const ICON = { camera: 'photo_camera', audio: 'mic', other: 'devices_other' };

/** Liga os eventos aos elementos desta abertura (a tela é recriada a cada projeto aberto). */
export function bindDevices() {
  $('wsDeviceForm')?.addEventListener('submit', addDevice);
}

export async function renderDevices() {
  const host = $('wsDevicesGroups');
  if (!host) return;
  host.textContent = '';
  let devices = [];
  try { devices = (await window.bds.listProjectDevices(ws.projectId)) || []; } catch (e) { console.error('[WORKSPACE] dispositivos:', e); }
  if (!devices.length) {
    host.append(mk('p', { class: 'ws-empty-line', text: 'Câmeras, gravadores e outros equipamentos usados neste trabalho.' }));
    return;
  }
  for (const d of devices) {
    host.append(mk('span', { class: 'ws-chip', title: d.note || '' }, [
      icon(ICON[d.category] || ICON.other),
      mk('span', { class: 'ws-chip-text', text: d.note ? `${d.name} · ${d.note}` : d.name }),
      mk('button', { type: 'button', class: 'ws-chip-remove', title: 'Remover', 'aria-label': `Remover ${d.name}`, onclick: () => removeDevice(d) }, [icon('close')])
    ]));
  }
}

async function addDevice(e) {
  e.preventDefault();
  const name = $('wsDeviceName').value.trim();
  if (!name) { $('wsDeviceName').focus(); return; }
  try {
    await window.bds.addProjectDevice(ws.projectId, { category: $('wsDeviceCategory').value, name, note: $('wsDeviceNote').value.trim() });
    $('wsDeviceName').value = ''; $('wsDeviceNote').value = '';
    await renderDevices();
    setAppStatus('Equipamento adicionado.', 'success');
  } catch (err) { window.bdsModal.alert(`Não foi possível adicionar: ${friendlyError(err)}`); }
}

async function removeDevice(d) {
  const ok = await window.bdsModal.confirm(`Remover "${d.name}" dos equipamentos do projeto?`);
  if (!ok) return;
  try { await window.bds.removeProjectDevice(d.id); await renderDevices(); }
  catch (err) { window.bdsModal.alert(`Não foi possível remover: ${friendlyError(err)}`); }
}
