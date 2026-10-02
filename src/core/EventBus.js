const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
    constructor() {
        super();
        // Vários serviços escutam MEDIA_IMPORTED/MEDIA_REMOVED; evita warnings espúrios
        this.setMaxListeners(50);
    }
}

// Exporta uma única instância global para todo o backend
module.exports = new EventBus();
