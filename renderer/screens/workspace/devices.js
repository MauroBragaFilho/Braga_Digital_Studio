/** Aba Dispositivos: equipamentos usados ou associados ao projeto. */
import { ws, $, mk, icon, setAppStatus, friendlyError } from './state.js';

const GROUPS = [['camera', 'Câmeras', 'photo_camera'], ['audio', 'Áudio', 'mic'], ['other', 'Outros', 'devices_other']];

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
  if (!devices.length) host.append(mk('p', { class: 'ws-empty-line', text: 'Nenhum equipamento registrado. Adicione ao lado.' }));
  for (const [id, label, ic] of GROUPS) {
    const items = devices.filter((d) => d.category === id);
    if (!items.length) continue;
    const ul = mk('ul', { class: 'ws-device-list' });
    for (const d of items) {
      ul.append(mk('li', { class: 'ws-device-item' }, [
        icon('check'),
        mk('span', { class: 'ws-device-name', text: d.name }),
        d.note ? mk('span', { class: 'ws-device-note', text: d.note }) : null,
        mk('button', { type: 'button', class: 'ws-icon-btn', title: 'Remover', 'aria-label': `Remover ${d.name}`, onclick: () => removeDevice(d) }, [icon('close')])
      ]));
    }
    host.append(mk('div', { class: 'ws-device-group' }, [mk('h4', { class: 'ws-subtitle' }, [icon(ic), ` ${label}`]), ul]));
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
    setAppStatus('Dispositivo adicionado.', 'success');
  } catch (err) { window.bdsModal.alert(`Não foi possível adicionar: ${friendlyError(err)}`); }
}

async function removeDevice(d) {
  const ok = await window.bdsModal.confirm(`Remover "${d.name}" dos dispositivos do projeto?`);
  if (!ok) return;
  try { await window.bds.removeProjectDevice(d.id); await renderDevices(); }
  catch (err) { window.bdsModal.alert(`Não foi possível remover: ${friendlyError(err)}`); }
}
