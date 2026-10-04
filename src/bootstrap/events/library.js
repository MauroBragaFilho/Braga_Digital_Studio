'use strict';

const EventBus = require('../../core/EventBus');

/** Eventos da biblioteca de mídia (EventBus) -> renderer. */
function bindLibraryEvents({ bridge }) {
  EventBus.on('MEDIA_IMPORTED', (m) => bridge.send('bds:media-imported', m));
  EventBus.on('MEDIA_REMOVED', (p) => bridge.send('bds:media-removed', p));
  EventBus.on('MEDIA_UPDATED', (p) => bridge.send('bds:media-updated', p));
}

module.exports = bindLibraryEvents;
