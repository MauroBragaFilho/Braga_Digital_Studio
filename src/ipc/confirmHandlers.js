'use strict';

const { handle } = require('./channelRegistry');
const { ackConfirm, respondConfirm } = require('../infrastructure/desktop/AppConfirm');

/**
 * Respostas do modal de confirmação do app (ver infrastructure/desktop/AppConfirm.js): só valem para um pedido
 * pendente do main, uma vez, e vindas do webContents que recebeu o pedido.
 */
module.exports = function registerConfirmHandlers() {
  handle('ui:confirmAck', (event, id) => ackConfirm(event && event.sender, id));
  handle('ui:confirmRespond', (event, id, accepted) => respondConfirm(event && event.sender, id, accepted));
};
