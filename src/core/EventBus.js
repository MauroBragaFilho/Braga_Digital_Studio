const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
    constructor() {
        super();
        // Aumentando limite caso tenhamos muitos listeners no futuro
        this.setMaxListeners(20);
    }
}

// Exporta uma única instância global para todo o backend
module.exports = new EventBus();
