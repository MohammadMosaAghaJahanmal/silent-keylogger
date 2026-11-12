'use strict';

const statusLine = document.getElementById('status');
function status(message, error = false) {
  statusLine.textContent = message;
  statusLine.className = error ? 'error' : '';
}
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function date(utc) { return utc.replace('T', ' ').replace('Z', ' UTC'); }
function link(label, href) {
  const element = document.createElement('a');
  element.textContent = label;
  element.href = href;
  return element;
}
async function loadSetup() {
  const setup = await api('/api/appsetup');
  const info = document.getElementById('setup-info');
  info.replaceChildren();
  if (!setup) { info.textContent = 'No file available.'; return; }
  info.append(link(setup.original_name, '/download/app'),
    document.createTextNode(` · ${size(setup.file_size)} · ${date(setup.received_at)}`));
}
async function loadUploads() {
  const rows = await api('/api/uploads');
  const table = document.getElementById('uploads');
  table.replaceChildren();
  if (!rows.length) {
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No count files received yet.';
    const row = table.insertRow(); row.append(cell);
  }
  for (const file of rows) {
    const row = table.insertRow(); row.dataset.id = file.id;
    for (const value of [file.id, file.original_name]) {
      row.insertCell().textContent = value;
    }
    const device = row.insertCell(); device.className = 'device';
    const name = document.createElement('div'); name.className = 'device-name';
    name.textContent = file.device_name || 'Unknown device';
    device.append(name);
    if (file.device_id) {
      const id = document.createElement('div'); id.className = 'device-id';
      id.textContent = file.device_id;
      const os = document.createElement('div'); os.className = 'device-os';
      os.textContent = file.os_version;
      device.append(id, os);
    } else {
      const older = document.createElement('div'); older.className = 'device-os';
      older.textContent = 'Older client'; device.append(older);
    }
    for (const value of [size(file.file_size), date(file.received_at)]) row.insertCell().textContent = value;
    const actions = row.insertCell(); actions.className = 'actions';
    const open = link('Open', `/api/uploads/${file.id}/open`);
    open.target = '_blank'; open.rel = 'noopener';
    const download = link('Download', `/api/uploads/${file.id}/download`);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'delete'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${file.original_name}? This removes the file and its record.`)) return;
      remove.disabled = true;
      try {
        await api(`/api/uploads/${file.id}`, { method: 'DELETE' });
        await loadUploads(); status('File deleted.');
      } catch (error) { status(error.message, true); remove.disabled = false; }
    });
    actions.append(open, download, remove);
  }
}
async function refresh() {
  try { await Promise.all([loadSetup(), loadUploads()]); status(''); }
  catch (error) { status(error.message, true); }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('setup-submit');
  button.disabled = true; status('Uploading setup…');
  try {
    await api('/api/appsetup', { method: 'POST', body: new FormData(event.currentTarget) });
    document.getElementById('setup-form').reset();
    await loadSetup(); status('Setup uploaded. The download page is ready.');
  } catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
});
refresh();
