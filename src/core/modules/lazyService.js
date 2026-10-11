'use strict';

/**
 * Serviço "preguiçoso": o objeto devolvido se comporta como o serviço real, mas o código só é construído na
 * PRIMEIRA vez que alguém o usa (chamar um método, ler uma propriedade). É assim que os módulos desligados
 * (Downloads, Conversor, Projetos…) deixam de custar tempo e memória na abertura do app: se ninguém os usa,
 * nunca são criados.
 *
 * Regras:
 *   - `then`, `toJSON` e símbolos NÃO constroem (await/JSON/inspeção não devem acordar o serviço);
 *   - métodos vêm já ligados à instância real (`svc.on(...)` funciona como no serviço original);
 *   - `isCreated(proxy)` diz se já foi construído (desligamento e checagens não devem construí-lo só para olhar);
 *   - `onceCreated(proxy, fn)` roda `fn(instanciaReal)` quando existir (imediatamente se já existe). Com um objeto
 *     comum (testes, serviço eager) roda na hora.
 */

const CONTROL = Symbol('bds.lazyService');

function lazyService(factory) {
  let instance;
  let created = false;
  const waiting = [];

  const real = () => {
    if (!created) {
      instance = factory();
      created = true;
      for (const fn of waiting.splice(0)) {
        try { fn(instance); } catch (_) { /* um ouvinte com defeito não derruba o serviço */ }
      }
    }
    return instance;
  };

  const control = {
    isCreated: () => created,
    onceCreated: (fn) => { if (created) fn(instance); else waiting.push(fn); }
  };

  return new Proxy({}, {
    get(_, prop) {
      if (prop === CONTROL) return control;
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      const svc = real();
      const value = svc[prop];
      return typeof value === 'function' ? value.bind(svc) : value;
    },
    set(_, prop, value) { real()[prop] = value; return true; },
    has(_, prop) { return prop in Object(real()); },
    getPrototypeOf() { return Object.getPrototypeOf(real()); }
  });
}

/** O serviço já foi construído? Objetos comuns (não preguiçosos) contam como construídos. */
function isCreated(service) {
  const control = service && service[CONTROL];
  return control ? control.isCreated() : Boolean(service);
}

/** Devolve o serviço só se já existe (não o constrói); senão null. Para checagens e desligamento. */
function liveService(service) {
  return isCreated(service) ? service : null;
}

/** Roda `fn(instanciaReal)` assim que o serviço existir. */
function onceCreated(service, fn) {
  const control = service && service[CONTROL];
  if (control) control.onceCreated(fn);
  else if (service) fn(service);
}

module.exports = { lazyService, isCreated, liveService, onceCreated };
