// Helper único para montar URLs file:// a partir de caminhos locais (Windows/UNC/POSIX).
// Escapa cada segmento (#, ?, %, espaço, aspas e parênteses), para que arquivos com esses
// caracteres no nome carreguem em <img>/<video>/<audio> e em url('...') do CSS.

function encodeSegment(seg) {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function toFileUrl(fsPath) {
  if (fsPath == null) return '';
  const raw = String(fsPath);
  if (!raw) return '';
  if (/^file:/i.test(raw)) return raw;
  const p = raw.replace(/\\/g, '/');

  // UNC: //servidor/share/arquivo -> file://servidor/share/arquivo
  if (p.startsWith('//')) {
    const parts = p.slice(2).split('/');
    return 'file://' + parts.map(encodeSegment).join('/');
  }
  // Unidade do Windows: C:/pasta/arquivo -> file:///C:/pasta/arquivo (o ':' da unidade não é escapado)
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  if (drive) {
    const rest = (drive[2] || '/').split('/').map(encodeSegment).join('/');
    return 'file:///' + drive[1] + rest;
  }
  // POSIX absoluto (ou relativo, tratado como absoluto)
  return 'file://' + (p.startsWith('/') ? '' : '/') + p.split('/').map(encodeSegment).join('/');
}

/** Junta uma base file:// (já escapada) com um nome de arquivo (escapando o nome). */
export function joinFileUrl(baseUrl, name) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${encodeSegment(String(name))}`;
}
