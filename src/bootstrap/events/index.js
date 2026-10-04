'use strict';

const bindDeviceEvents = require('./devices');
const bindLibraryEvents = require('./library');
const bindDownloadEvents = require('./downloads');
const bindConverterEvents = require('./converter');
const bindSilenceEvents = require('./silence');
const bindMediaEvents = require('./media');

/**
 * Liga os eventos dos serviços ao renderer (via `bridge`), à taskbar e às notificações.
 * `ctx` = { bridge, services }. A guarda contra registro duplicado fica no chamador (Bootstrap).
 */
function bindServiceEvents(ctx) {
  bindDeviceEvents(ctx);
  bindLibraryEvents(ctx);
  bindDownloadEvents(ctx);
  bindConverterEvents(ctx);
  bindSilenceEvents(ctx);
  bindMediaEvents(ctx);
}

module.exports = { bindServiceEvents };
