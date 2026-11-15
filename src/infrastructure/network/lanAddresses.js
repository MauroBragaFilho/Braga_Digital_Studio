'use strict';

const os = require('node:os');

/** Endereço de rede local (10.x, 172.16-31.x, 192.168.x): onde um celular ou uma câmera do mesmo Wi-Fi pode estar. */
function isLanAddress(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
}

/**
 * Endereços IPv4 das redes locais deste computador, em ordem. VPNs (Radmin, Tailscale, Hamachi...) usam outras faixas e ficam de fora.
 *
 * Por que isto existe: pergunta multicast (mDNS dos celulares BDS Mobile, SSDP das câmeras Sony) enviada sem escolher a
 * interface sai só pela rede "padrão" do Windows, e com uma VPN ligada ela não é o Wi-Fi: o aparelho nunca recebia a pergunta.
 * A pergunta precisa sair por CADA rede local.
 * @returns {string[]}
 */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal && isLanAddress(n.address) && !out.includes(n.address)) out.push(n.address);
    }
  }
  return out.sort();
}

module.exports = { lanAddresses, isLanAddress };
