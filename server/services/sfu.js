// SFU for voice/video rooms, built on mediasoup. Replaces the O(n²) P2P mesh: each participant
// uploads their tracks ONCE to the server, which fans them out — so a 10-person room costs each
// client 1 upload instead of 9.
//
// Reachability: media flows directly between clients and this process over UDP/TCP on ONE port
// (SFU_PORT, default 40000, shared across all transports via a WebRtcServer) — it does NOT go
// through the Cloudflare tunnel. LAN clients reach the announced LAN address with no router work;
// remote clients additionally need that port forwarded and a public address in SFU_ANNOUNCED_IPS.
//
// Config (env):
//   SFU_DISABLED=1         turn the SFU off (clients fall back to the mesh automatically)
//   SFU_PORT               media port (default 40000, both UDP and TCP)
//   SFU_ANNOUNCED_IPS      comma-separated addresses to advertise (default: this host's LAN IPv4s)
//
// The whole module is defensive: if the worker can't spawn (unsupported platform, port in use),
// enabled() turns false and every client request answers null → mesh fallback, never an outage.
const os = require('os');

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 800 },
  },
];

function lanIPv4s() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function createSfu({ io }) {
  const PORT = parseInt(process.env.SFU_PORT || '40000', 10);
  const disabled = process.env.SFU_DISABLED === '1';
  const announced = (process.env.SFU_ANNOUNCED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const announcedAddresses = announced.length ? announced : lanIPv4s();

  let mediasoup = null;
  try { mediasoup = require('mediasoup'); } catch (_) { /* not installed → SFU off */ }

  let worker = null;
  let webRtcServer = null;
  let broken = false;
  const rooms = new Map(); // room name -> { router, peers: Map<socketId, peerState> }

  async function getWorker() {
    if (worker) return worker;
    worker = await mediasoup.createWorker({ logLevel: 'warn' });
    worker.on('died', () => {
      // A dead worker takes every room with it. Mark the SFU broken (clients joining later get the
      // mesh) rather than crash the whole app server.
      console.error('[sfu] mediasoup worker died — SFU disabled until restart');
      broken = true;
      worker = null;
      webRtcServer = null;
      rooms.clear();
    });
    // One shared port per announced address (its udp and tcp bindings share the number). Two
    // bindings can't share the same ip:port, so the i-th announced address gets PORT+i — a host
    // with a single LAN address (the SBC) uses exactly PORT, which is also the one port to forward
    // on the router for remote users.
    const listenInfos = [];
    if (announcedAddresses.length === 0) {
      for (const protocol of ['udp', 'tcp']) listenInfos.push({ protocol, ip: '0.0.0.0', port: PORT });
    }
    announcedAddresses.forEach((addr, i) => {
      for (const protocol of ['udp', 'tcp']) {
        listenInfos.push({ protocol, ip: '0.0.0.0', announcedAddress: addr, port: PORT + i });
      }
    });
    webRtcServer = await worker.createWebRtcServer({ listenInfos });
    console.log(`[sfu] ready from port ${PORT} (udp/tcp), announcing: ${announcedAddresses.join(', ') || '(none)'}`);
    return worker;
  }

  function enabled() { return !!mediasoup && !disabled && !broken; }

  async function getRoom(name) {
    let room = rooms.get(name);
    if (room) return room;
    const w = await getWorker();
    const router = await w.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = { router, peers: new Map() };
    rooms.set(name, room);
    return room;
  }

  function getPeer(room, socketId) {
    let peer = room.peers.get(socketId);
    if (!peer) {
      peer = { transports: new Map(), producers: new Map(), consumers: new Map() };
      room.peers.set(socketId, peer);
    }
    return peer;
  }

  // Everything a client can produce into the room right now, for late joiners.
  function producerList(room, exceptSocketId) {
    const out = [];
    for (const [socketId, peer] of room.peers) {
      if (socketId === exceptSocketId) continue;
      for (const producer of peer.producers.values()) {
        out.push({ producerId: producer.id, peerSocketId: socketId, kind: producer.kind });
      }
    }
    return out;
  }

  // Remove one participant: close their transports (which closes producers/consumers) and tell the
  // room their media is gone. Called on voice:leave and on disconnect.
  function removePeer(roomName, socketId) {
    const room = rooms.get(roomName);
    if (!room) return;
    const peer = room.peers.get(socketId);
    if (!peer) return;
    for (const producer of peer.producers.values()) {
      io.to(roomName).emit('sfu:producer-closed', { producerId: producer.id, peerSocketId: socketId });
    }
    for (const t of peer.transports.values()) { try { t.close() } catch (_) { /* already closed */ } }
    room.peers.delete(socketId);
    if (room.peers.size === 0) {
      try { room.router.close() } catch (_) { /* already closed */ }
      rooms.delete(roomName);
    }
  }

  // Wire the per-socket signaling. `roomOf(socket)` returns the voice room this socket is in (the
  // caller owns room membership); handlers verify it so a socket can't produce into a room it left.
  function bindSocket(socket, roomOf) {
    const fail = (cb, msg) => { if (typeof cb === 'function') cb({ error: msg }) };

    // Capability probe + router caps. Answering null (not an error) = "use the mesh".
    socket.on('sfu:caps', async (_payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!enabled()) return cb(null);
      const roomName = roomOf(socket);
      if (!roomName) return cb(null);
      try {
        const room = await getRoom(roomName);
        cb({ routerRtpCapabilities: room.router.rtpCapabilities });
      } catch (err) {
        console.error('[sfu] caps failed:', err.message);
        broken = true; // e.g. media port already bound — don't retry every join
        cb(null);
      }
    });

    socket.on('sfu:create-transport', async (_payload, cb) => {
      const roomName = roomOf(socket);
      if (!enabled() || !roomName) return fail(cb, 'sfu unavailable');
      try {
        const room = await getRoom(roomName);
        const transport = await room.router.createWebRtcTransport({
          webRtcServer,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        getPeer(room, socket.id).transports.set(transport.id, transport);
        cb({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:connect-transport', async ({ transportId, dtlsParameters } = {}, cb) => {
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) return fail(cb, 'unknown transport');
      try { await transport.connect({ dtlsParameters }); cb({ ok: true }) }
      catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:produce', async ({ transportId, kind, rtpParameters, appData } = {}, cb) => {
      const roomName = roomOf(socket);
      const room = roomName && rooms.get(roomName);
      const peer = room?.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) return fail(cb, 'unknown transport');
      try {
        const producer = await transport.produce({ kind, rtpParameters, appData: appData || {} });
        peer.producers.set(producer.id, producer);
        producer.on('transportclose', () => peer.producers.delete(producer.id));
        socket.to(roomName).emit('sfu:new-producer', { producerId: producer.id, peerSocketId: socket.id, kind });
        cb({ id: producer.id });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:close-producer', ({ producerId } = {}) => {
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!producer) return;
      try { producer.close() } catch (_) { /* already closed */ }
      peer.producers.delete(producerId);
      socket.to(roomName).emit('sfu:producer-closed', { producerId, peerSocketId: socket.id });
    });

    socket.on('sfu:producers', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      const roomName = roomOf(socket);
      const room = roomName && rooms.get(roomName);
      cb(room ? producerList(room, socket.id) : []);
    });

    socket.on('sfu:consume', async ({ transportId, producerId, rtpCapabilities } = {}, cb) => {
      const roomName = roomOf(socket);
      const room = roomName && rooms.get(roomName);
      const peer = room?.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) return fail(cb, 'unknown transport');
      if (!room.router.canConsume({ producerId, rtpCapabilities })) return fail(cb, 'cannot consume');
      try {
        // Start paused; the client resumes once its transport is connected and the element is wired,
        // so the first keyframe isn't wasted on a not-yet-listening receiver.
        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => {
          peer.consumers.delete(consumer.id);
          socket.emit('sfu:consumer-closed', { consumerId: consumer.id });
        });
        cb({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:resume-consumer', async ({ consumerId } = {}, cb) => {
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) return fail(cb, 'unknown consumer');
      try { await consumer.resume(); if (typeof cb === 'function') cb({ ok: true }) }
      catch (err) { fail(cb, err.message) }
    });
  }

  return { enabled, bindSocket, removePeer };
}

module.exports = { createSfu };
