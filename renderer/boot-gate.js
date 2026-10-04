// Portão de inicialização do renderer (carregado de forma síncrona no <head>, antes do app.js).
//
// O processo principal carrega esta página já na criação da janela, em paralelo com a abertura do banco e o
// registro dos handlers IPC. O app.js aguarda `window.__bdsGate.promise` antes de rodar qualquer código que
// use IPC; o main abre o portão (executeJavaScript -> __bdsGate.go()) assim que os handlers estão registrados.
// Rede de segurança: se ninguém abrir o portão em 60 s, a interface segue sozinha (nunca fica travada).
(function () {
  'use strict';
  var gate = { open: false, resolve: null, promise: null };
  gate.promise = new Promise(function (resolve) { gate.resolve = resolve; });
  gate.go = function () {
    if (!gate.open) {
      gate.open = true;
      gate.resolve();
    }
    return true;
  };
  setTimeout(gate.go, 60000);
  window.__bdsGate = gate;
})();
