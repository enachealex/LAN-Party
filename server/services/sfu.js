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
const { isPublicAddress } = require('./sfuAddress');

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 800 },
  },
];

// How long an sfu:* request waits for a voice:join of the same socket that is still being decided.
// A join is two database reads; this only has to outlast a slow disk, not a stuck one.
const JOIN_WAIT_MS = 5000;

// Connection check (sfu:probe-*): a transport that carries no media and exists only so a browser
// can find out whether it reaches the media port. Each one is a real port binding in the worker, so
// they are few, short-lived and counted per account.
const PROBE_TTL_MS = 20_000;
const PROBE_MAX_LIVE = 2; // one over UDP and one over TCP, side by side
const PROBE_WINDOW_MS = 60_000;
const PROBE_MAX_PER_WINDOW = 6;

function lanIPv4s() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// Wait for `promise`, but not for ever, and never throw: whatever became of the join, the caller
// goes on to read the room for itself.
function settled(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([Promise.resolve(promise).catch(() => {}), timeout]).finally(() => clearTimeout(timer));
}

function createSfu({ io }) {
  const PORT = parseInt(process.env.SFU_PORT || '40000', 10);
  const disabled = process.env.SFU_DISABLED === '1';
  const announced = (process.env.SFU_ANNOUNCED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const announcedAddresses = announced.length ? announced : lanIPv4s();

  let mediasoup = null;
  try { mediasoup = require('mediasoup'); } catch (_) { /* not installed → SFU off */ }

  let workerPromise = null;
  let webRtcServer = null;
  let broken = false;
  const rooms = new Map(); // room name -> { router, peers: Map<socketId, peerState> }
  let probeRouterPromise = null;
  const probes = new Map(); // socket id -> Map<transport id, { transport, timer }>
  const probeStarts = new Map(); // account -> { count, resetAt }

  async function startWorker() {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    worker.on('died', () => {
      // A dead worker takes every room with it. Mark the SFU broken (clients joining later get the
      // mesh) rather than crash the whole app server.
      console.error('[sfu] mediasoup worker died — SFU disabled until restart');
      broken = true;
      workerPromise = null;
      webRtcServer = null;
      probeRouterPromise = null;
      rooms.clear();
      for (const live of probes.values()) for (const p of live.values()) clearTimeout(p.timer);
      probes.clear();
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
    try {
      webRtcServer = await worker.createWebRtcServer({ listenInfos });
    } catch (err) {
      // The port is taken. Without this the worker process stayed behind with nothing to do.
      try { worker.close(); } catch (_) { /* already gone */ }
      throw err;
    }
    console.log(`[sfu] ready from port ${PORT} (udp/tcp), announcing: ${announcedAddresses.join(', ') || '(none)'}`);
    return worker;
  }

  // One worker, however many callers ask at once. Two rooms opening in the same moment (or a room
  // and a connection check) each used to start a worker of their own, and the second one's port
  // binding failed — which marked the whole SFU broken.
  function getWorker() {
    if (!workerPromise) {
      workerPromise = startWorker().catch((err) => { workerPromise = null; throw err; });
    }
    return workerPromise;
  }

  function enabled() { return !!mediasoup && !disabled && !broken; }

  // Can a call actually be carried right now? enabled() only says nothing has gone wrong YET; this
  // starts the worker to find out, exactly as the first join would.
  async function ready() {
    if (!enabled()) return false;
    try { await getWorker(); return true; } catch (err) {
      console.error('[sfu] worker failed to start:', err.message);
      broken = true; // e.g. media port already bound — don't retry on every request
      return false;
    }
  }

  // What an operator or a client's connection check may know. No addresses: whether one of them is
  // public is the useful fact, and the address itself is nobody's business.
  function info() {
    return {
      enabled: !!mediasoup && !disabled,
      ports: announcedAddresses.length ? announcedAddresses.map((_, i) => PORT + i) : [PORT],
      publicAddressAnnounced: announcedAddresses.some(isPublicAddress),
    };
  }

  async function getRoom(name) {
    let room = rooms.get(name);
    if (room) return room;
    const w = await getWorker();
    // Two requests for a room that does not exist yet both get here; the first one's router wins.
    room = rooms.get(name);
    if (room) return room;
    const router = await w.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = rooms.get(name);
    if (room) { try { router.close() } catch (_) { /* already closed */ } return room; }
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
  // room their media is gone. Called on voice:leave, on disconnect, and when a participant says it
  // has switched to direct connections (its producers would otherwise sit there, silent).
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

  // ---- Connection check ----
  // Its own router, in no voice room: a check must work before any call exists, and must never be
  // able to produce into or consume from one.
  function getProbeRouter() {
    if (!probeRouterPromise) {
      probeRouterPromise = getWorker()
        .then((w) => w.createRouter({ mediaCodecs: MEDIA_CODECS }))
        .catch((err) => { probeRouterPromise = null; throw err; });
    }
    return probeRouterPromise;
  }

  function closeProbe(socketId, transportId) {
    const live = probes.get(socketId);
    const probe = live && live.get(transportId);
    if (!probe) return;
    clearTimeout(probe.timer);
    try { probe.transport.close() } catch (_) { /* already closed */ }
    live.delete(transportId);
    if (live.size === 0) probes.delete(socketId);
  }

  function closeProbes(socketId) {
    for (const transportId of [...(probes.get(socketId)?.keys() || [])]) closeProbe(socketId, transportId);
  }

  function probeAllowed(account) {
    const now = Date.now();
    if (probeStarts.size > 1000) for (const [k, v] of probeStarts) if (v.resetAt <= now) probeStarts.delete(k);
    let bucket = probeStarts.get(account);
    if (!bucket || bucket.resetAt <= now) { bucket = { count: 0, resetAt: now + PROBE_WINDOW_MS }; probeStarts.set(account, bucket); }
    bucket.count += 1;
    return bucket.count <= PROBE_MAX_PER_WINDOW;
  }

  // Wire the per-socket signaling. `roomOf(socket)` returns the voice room this socket is in (the
  // caller owns room membership); handlers verify it so a socket can't produce into a room it left.
  // `mayUseVoice(serverId)` is the membership gate — sfu:caps names a server/channel explicitly, so
  // without it an ungated socket could probe (and spin up a router for) any room it could name.
  //
  // `pendingJoin()` returns a promise while a voice:join of this socket is still being decided, and
  // null otherwise. A client sends voice:join and its first sfu:* request back to back; the join
  // reads the database before the socket enters the room, so the request that followed it was
  // handled first, found no room, and was told "sfu unavailable" — every time, which is why no
  // call ever used the SFU. Each handler that reads the room now lets such a join finish first.
  // With no join in flight nothing is awaited, so the order of everything else is what it was.
  //
  // `probeAs` is the account a connection check is counted against; null (not signed in) gets none.
  function bindSocket(socket, roomOf, mayUseVoice = async () => true, { pendingJoin = () => null, probeAs = null } = {}) {
    const fail = (cb, msg) => { if (typeof cb === 'function') cb({ error: msg }) };

    // Capability probe + router caps. Answering null (not an error) = "use the mesh". The client
    // probes with an explicit room BEFORE emitting voice:join, so its mode is settled before any
    // mesh signaling (voice:peers) can arrive; every later handler still requires real membership.
    socket.on('sfu:caps', async (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!enabled()) return cb(null);
      const explicit = payload && payload.serverId && payload.channelId
        ? `voice:${payload.serverId}:${payload.channelId}` : null;
      // An explicitly named server must be one this socket is a member of. Answering null (not an
      // error) keeps the client's mesh fallback working for a genuine non-member.
      if (explicit && !(await mayUseVoice(payload.serverId))) return cb(null);
      if (!explicit) { const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS); }
      const roomName = explicit || roomOf(socket);
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
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
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
        // Left (or was taken out) while the transport was being made: it belongs to nobody now.
        if (roomOf(socket) !== roomName) { try { transport.close() } catch (_) { /* already closed */ } return fail(cb, 'sfu unavailable'); }
        getPeer(room, socket.id).transports.set(transport.id, transport);
        if (typeof cb !== 'function') return;
        cb({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:connect-transport', async ({ transportId, dtlsParameters } = {}, cb) => {
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) return fail(cb, 'unknown transport');
      try { await transport.connect({ dtlsParameters }); if (typeof cb === 'function') cb({ ok: true }) }
      catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:produce', async ({ transportId, kind, rtpParameters, appData } = {}, cb) => {
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
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
        if (typeof cb === 'function') cb({ id: producer.id });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:close-producer', async ({ producerId } = {}) => {
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!producer) return;
      try { producer.close() } catch (_) { /* already closed */ }
      peer.producers.delete(producerId);
      socket.to(roomName).emit('sfu:producer-closed', { producerId, peerSocketId: socket.id });
    });

    socket.on('sfu:producers', async (_payload, cb) => {
      if (typeof cb !== 'function') return;
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
      const roomName = roomOf(socket);
      const room = roomName && rooms.get(roomName);
      cb(room ? producerList(room, socket.id) : []);
    });

    socket.on('sfu:consume', async ({ transportId, producerId, rtpCapabilities } = {}, cb) => {
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
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
        if (typeof cb !== 'function') return;
        cb({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:resume-consumer', async ({ consumerId } = {}, cb) => {
      const joining = pendingJoin(); if (joining) await settled(joining, JOIN_WAIT_MS);
      const roomName = roomOf(socket);
      const peer = roomName && rooms.get(roomName)?.peers.get(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) return fail(cb, 'unknown consumer');
      try { await consumer.resume(); if (typeof cb === 'function') cb({ ok: true }) }
      catch (err) { fail(cb, err.message) }
    });

    // ---- Connection check: "can this browser reach the media port?", asked outside any call ----
    // A transport limited to ONE protocol, so the client learns about UDP and TCP separately. The
    // error is a code, not a sentence: the client turns it into its own words.
    socket.on('sfu:probe-start', async ({ protocol } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!probeAs) return cb({ error: 'not-allowed' });
      if (protocol !== 'udp' && protocol !== 'tcp') return cb({ error: 'bad-protocol' });
      if (!probeAllowed(probeAs)) return cb({ error: 'rate-limited' });
      if (!(await ready())) return cb({ error: 'sfu-off' });
      try {
        const router = await getProbeRouter();
        const transport = await router.createWebRtcTransport({
          webRtcServer,
          enableUdp: protocol === 'udp',
          enableTcp: protocol === 'tcp',
        });
        if (!socket.connected) { try { transport.close() } catch (_) { /* already closed */ } return; }
        let live = probes.get(socket.id);
        if (!live) { live = new Map(); probes.set(socket.id, live); }
        // Starting a third lets go of the oldest: a client that never says "stop" cannot pile them up.
        while (live.size >= PROBE_MAX_LIVE) closeProbe(socket.id, live.keys().next().value);
        const timer = setTimeout(() => closeProbe(socket.id, transport.id), PROBE_TTL_MS);
        timer.unref();
        live.set(transport.id, { transport, timer });
        cb({
          routerRtpCapabilities: router.rtpCapabilities,
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error('[sfu] connection check failed:', err.message);
        cb({ error: 'failed' });
      }
    });

    socket.on('sfu:probe-connect', async ({ transportId, dtlsParameters } = {}, cb) => {
      const probe = probes.get(socket.id)?.get(transportId);
      if (!probe) return fail(cb, 'unknown transport');
      try { await probe.transport.connect({ dtlsParameters }); if (typeof cb === 'function') cb({ ok: true }) }
      catch (err) { fail(cb, err.message) }
    });

    socket.on('sfu:probe-stop', ({ transportId } = {}) => closeProbe(socket.id, transportId));

    socket.on('disconnect', () => closeProbes(socket.id));
  }

  return { enabled, ready, info, announcedAddresses: () => [...announcedAddresses], bindSocket, removePeer };
}

module.exports = { createSfu };
