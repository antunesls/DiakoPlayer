'use strict';
// Descoberta automática na rede local: o app Android envia um broadcast UDP e o PC responde.
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 26539;
const MAGIC = 'DIAKOPLAYER_DISCOVER';

function startDiscovery({ getPort, version }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString().trim() !== MAGIC) return;
    const reply = Buffer.from(
      JSON.stringify({ app: 'diakoplayer', name: os.hostname(), port: getPort(), version }),
    );
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => console.error('[descoberta]', e.message));
  sock.bind(DISCOVERY_PORT, '0.0.0.0');
  return () => sock.close();
}

/** Endereços IPv4 da máquina na rede local (para exibir e gerar o QR code). */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  // Prioriza redes domésticas comuns (192.168.x / 10.x) sobre adaptadores virtuais.
  const score = (a) =>
    (/^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : 2) +
    (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback/i.test(a.name) ? 10 : 0);
  return out.sort((a, b) => score(a) - score(b));
}

module.exports = { startDiscovery, lanAddresses, DISCOVERY_PORT };
