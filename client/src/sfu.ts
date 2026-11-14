// Client side of the voice-room SFU (mediasoup). One session per joined voice room: the local mic
// (and at most one video track — camera OR screen, mirroring the mesh) is produced once to the
// server, and every remote participant's media is consumed into a single MediaStream per peer
// socket id — the exact shape the existing UI (remoteStreams keyed by peer id) already renders.
//
// SfuSession.create() resolves null when the server has no SFU for this room (disabled, worker
// dead, old server) — the caller then uses the P2P mesh exactly as before.
//
// A session is one of two ways a participant can be reached. Participants in mesh mode are reached
// over direct connections instead (voiceLinks.ts has the rule, App.jsx the connections); the
// session reports who is publishing to the server so the two never overlap.
import { Device } from 'mediasoup-client'
import type { types as ms } from 'mediasoup-client'
import type { Socket } from 'socket.io-client'
import { EMPTY_STATS, summarizeStats } from './voiceLinks'
import type { LinkState, LinkStats } from './voiceLinks'

interface SfuCallbacks {
  /** A remote peer's stream exists (fires once per peer; tracks are added/removed in place). */
  onPeerStream: (peerSocketId: string, stream: MediaStream) => void
  /** A remote peer's stream is gone (all their producers closed). */
  onPeerGone: (peerSocketId: string) => void
  /** A peer started or stopped publishing to the server (or the first listing just arrived). */
  onPeerProducers?: (peerSocketId: string) => void
  /** A transport that HAD connected has failed: the media path is gone and will not come back. */
  onTransportFailed?: () => void
}

interface ProducerInfo { producerId: string; peerSocketId: string; kind: 'audio' | 'video' }

// socket.io request/ack as a promise; server answers { error } on failure.
function request<T = any>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 10000)
    socket.emit(event, payload, (answer: any) => {
      clearTimeout(timer)
      if (answer && answer.error) reject(new Error(answer.error))
      else resolve(answer)
    })
  })
}

export class SfuSession {
  private socket: Socket
  private device: Device
  private sendTransport: ms.Transport | null = null
  private recvTransport: ms.Transport | null = null
  private audioProducer: ms.Producer | null = null
  private videoProducer: ms.Producer | null = null
  private consumers = new Map<string, { consumer: ms.Consumer; peerSocketId: string }>()
  private peerStreams = new Map<string, MediaStream>()
  // Who is publishing what on the server, whether or not this client consumes it.
  private producers = new Map<string, string>() // producer id -> peer socket id
  // Producers a consumer exists for, or is being made for. The listing fetched on connect and a
  // "new producer" event can both name the same producer; consumed twice, that person is heard twice.
  private wanted = new Set<string>()
  private callbacks: SfuCallbacks
  private closed = false
  private everConnected = false
  private cleanupSocketHandlers: () => void
  // Woken on every transport connectionstatechange (and on close) so waitUntilConnected can re-check.
  private stateWaiters = new Set<() => void>()
  /** True once the server's list of producers has been read: "not publishing" then means it. */
  catalogueKnown = false

  private constructor(socket: Socket, device: Device, callbacks: SfuCallbacks) {
    this.socket = socket
    this.device = device
    this.callbacks = callbacks

    const onNewProducer = (info: ProducerInfo) => {
      this.noteProducer(info)
      void this.consume(info).catch((e) => console.warn('sfu consume failed', e))
    }
    const onProducerClosed = ({ producerId, peerSocketId }: { producerId: string; peerSocketId: string }) => {
      this.wanted.delete(producerId)
      for (const [consumerId, entry] of this.consumers) {
        if (entry.consumer.producerId === producerId) this.dropConsumer(consumerId)
      }
      if (this.producers.delete(producerId)) this.callbacks.onPeerProducers?.(peerSocketId)
    }
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) => this.dropConsumer(consumerId)
    socket.on('sfu:new-producer', onNewProducer)
    socket.on('sfu:producer-closed', onProducerClosed)
    socket.on('sfu:consumer-closed', onConsumerClosed)
    this.cleanupSocketHandlers = () => {
      socket.off('sfu:new-producer', onNewProducer)
      socket.off('sfu:producer-closed', onProducerClosed)
      socket.off('sfu:consumer-closed', onConsumerClosed)
    }
  }

  /**
   * Probe the server for this room; null → the server has no SFU (it is switched off), use the
   * mesh. Anything else that goes wrong throws, so the caller can say what it was.
   */
  static async create(socket: Socket, room: { serverId: string; channelId: string }, callbacks: SfuCallbacks): Promise<SfuSession | null> {
    const caps = await request<{ routerRtpCapabilities: ms.RtpCapabilities } | null>(socket, 'sfu:caps', room)
    if (!caps) return null
    const device = new Device()
    await device.load({ routerRtpCapabilities: caps.routerRtpCapabilities })
    return new SfuSession(socket, device, callbacks)
  }

  private wake(): void { for (const w of [...this.stateWaiters]) w() }

  private noteProducer(info: ProducerInfo): void {
    if (this.producers.get(info.producerId) === info.peerSocketId) return
    this.producers.set(info.producerId, info.peerSocketId)
    this.callbacks.onPeerProducers?.(info.peerSocketId)
  }

  /** Is this peer publishing anything to the server right now? */
  hasProducers(peerSocketId: string): boolean {
    for (const owner of this.producers.values()) if (owner === peerSocketId) return true
    return false
  }

  /**
   * Resolve true once a transport's ICE/DTLS actually connects (media path works), false if none
   * connect within timeoutMs or one fails outright. The caller uses a false result to tear the SFU
   * down and fall back to the P2P mesh — the SFU has no server-side fallback, so an unreachable
   * media port (e.g. a remote user behind an un-forwarded router) would otherwise mean dead audio.
   * Either transport reaching 'connected' proves the path (both use the same server candidates).
   */
  waitUntilConnected(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const states = () => [this.sendTransport?.connectionState, this.recvTransport?.connectionState]
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.stateWaiters.delete(check)
        resolve(ok)
      }
      const check = () => {
        if (this.closed) return finish(false)
        const s = states()
        if (s.includes('connected')) return finish(true)
        if (s.some((v) => v === 'failed')) return finish(false)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.stateWaiters.add(check)
      check() // in case a transport is already connected/failed
    })
  }

  /**
   * Create both transports. Call AFTER the server has confirmed voice:join (the roster arrived):
   * the server requires room membership for every request made here.
   */
  async connect(): Promise<void> {
    this.sendTransport = await this.createTransport('send')
    this.recvTransport = await this.createTransport('recv')
    // Late join: consume everything already being produced in the room.
    const existing = await request<ProducerInfo[]>(this.socket, 'sfu:producers', {})
    if (this.closed) return
    for (const info of existing) this.noteProducer(info)
    this.catalogueKnown = true
    for (const info of existing) await this.consume(info).catch((e) => console.warn('sfu consume failed', e))
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<ms.Transport> {
    const params = await request<any>(this.socket, 'sfu:create-transport', { direction })
    const transport = direction === 'send'
      ? this.device.createSendTransport(params)
      : this.device.createRecvTransport(params)
    // ICE/DTLS reachability signal. The 'connect' event below only proves the DTLS params were
    // exchanged over socket.io — it fires even when the media port is unreachable. Actual
    // connectivity shows up here, so this drives the caller's fall-back-to-mesh watchdog.
    transport.on('connectionstatechange', (state) => {
      if (state === 'connected') this.everConnected = true
      // Before the first connection the watchdog decides; after it, a failure is the path dying
      // mid-call (a network change), and nothing here would ever bring the audio back.
      else if (state === 'failed' && this.everConnected && !this.closed) this.callbacks.onTransportFailed?.()
      this.wake()
    })
    transport.on('connect', ({ dtlsParameters }, done, fail) => {
      request(this.socket, 'sfu:connect-transport', { transportId: transport.id, dtlsParameters }).then(() => done()).catch(fail)
    })
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
        request<{ id: string }>(this.socket, 'sfu:produce', { transportId: transport.id, kind, rtpParameters, appData })
          .then(({ id }) => done({ id })).catch(fail)
      })
    }
    return transport
  }

  // stopTracks:false on every producer. The tracks belong to the call, not to this session: the
  // same microphone track also feeds the direct connections, and it has to survive this session
  // being closed — which is exactly what happens when the call falls back to direct connections.
  // Left at the default, closing the session stopped the microphone for the rest of the call.
  async produceAudio(track: MediaStreamTrack): Promise<void> {
    if (!this.sendTransport || this.audioProducer) return
    this.audioProducer = await this.sendTransport.produce({ track, stopTracks: false, appData: { type: 'mic' } })
  }

  /** Swap the microphone (a device change) without renegotiating. */
  async replaceAudioTrack(track: MediaStreamTrack): Promise<void> {
    if (this.audioProducer) await this.audioProducer.replaceTrack({ track })
    else await this.produceAudio(track)
  }

  /** Set/replace/stop the single outgoing video track (camera or screen), mirroring the mesh. */
  async setVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    if (!this.sendTransport) return
    if (!track) {
      if (this.videoProducer) {
        const id = this.videoProducer.id
        this.videoProducer.close()
        this.videoProducer = null
        this.socket.emit('sfu:close-producer', { producerId: id })
      }
      return
    }
    if (this.videoProducer) {
      await this.videoProducer.replaceTrack({ track })
    } else {
      this.videoProducer = await this.sendTransport.produce({
        track,
        stopTracks: false,
        appData: { type: 'video' },
        encodings: [{ maxBitrate: 2_500_000 }],
      })
    }
  }

  /** Cap the outgoing video bitrate (screen-share quality menu). */
  setVideoBitrate(bitrate: number): void {
    const sender = this.videoProducer?.rtpSender
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings || !params.encodings.length) params.encodings = [{}]
    params.encodings[0].maxBitrate = bitrate
    sender.setParameters(params).catch(() => { /* transient */ })
  }

  private async consume(info: ProducerInfo): Promise<void> {
    if (this.closed || !this.recvTransport) return
    if (this.wanted.has(info.producerId)) return
    this.wanted.add(info.producerId)
    try {
      const data = await request<any>(this.socket, 'sfu:consume', {
        transportId: this.recvTransport.id,
        producerId: info.producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      })
      if (this.closed) return
      const consumer = await this.recvTransport.consume({
        id: data.id, producerId: data.producerId, kind: data.kind, rtpParameters: data.rtpParameters,
      })
      // The producer was closed while this was on its way: the "closed" event found no consumer to
      // drop, so drop it here, or its silent track would stay in the peer's stream for good.
      if (this.closed || !this.wanted.has(info.producerId)) { try { consumer.close() } catch { /* already closed */ } return }
      this.consumers.set(consumer.id, { consumer, peerSocketId: info.peerSocketId })

      let stream = this.peerStreams.get(info.peerSocketId)
      const isNew = !stream
      if (!stream) { stream = new MediaStream(); this.peerStreams.set(info.peerSocketId, stream) }
      stream.addTrack(consumer.track)
      if (isNew) this.callbacks.onPeerStream(info.peerSocketId, stream)

      // Server-side consumers start paused so the first keyframe isn't sent into the void.
      await request(this.socket, 'sfu:resume-consumer', { consumerId: consumer.id })
    } catch (err) {
      // Not consumed after all: a later announcement of the same producer may try again.
      if (![...this.consumers.values()].some((c) => c.consumer.producerId === info.producerId)) this.wanted.delete(info.producerId)
      throw err
    }
  }

  private dropConsumer(consumerId: string): void {
    const entry = this.consumers.get(consumerId)
    if (!entry) return
    this.consumers.delete(consumerId)
    this.wanted.delete(entry.consumer.producerId)
    try { entry.consumer.close() } catch { /* already closed */ }
    const stream = this.peerStreams.get(entry.peerSocketId)
    if (stream) {
      try { stream.removeTrack(entry.consumer.track) } catch { /* already gone */ }
      if (stream.getTracks().length === 0) {
        this.peerStreams.delete(entry.peerSocketId)
        this.callbacks.onPeerGone(entry.peerSocketId)
      }
    }
  }

  // ---- For the connection panel ----

  /** This client's own media path to the server. */
  serverState(): LinkState {
    const states = [this.sendTransport?.connectionState, this.recvTransport?.connectionState]
    if (states.includes('failed')) return 'failed'
    return states.includes('connected') ? 'connected' : 'connecting'
  }

  /** One participant as heard through the server: connected once their media is actually arriving here. */
  peerState(peerSocketId: string): LinkState {
    if (this.serverState() === 'failed') return 'failed'
    const consuming = [...this.consumers.values()].some((c) => c.peerSocketId === peerSocketId)
    return consuming && this.recvTransport?.connectionState === 'connected' ? 'connected' : 'connecting'
  }

  /** The candidate pair and round trip of the path to the server, and loss on what it sends us. */
  async stats(): Promise<LinkStats> {
    if (this.closed) return EMPTY_STATS
    const read = async (t: ms.Transport | null) => {
      try { return t && t.connectionState === 'connected' ? summarizeStats(await t.getStats()) : null } catch { return null }
    }
    const [send, recv] = await Promise.all([read(this.sendTransport), read(this.recvTransport)])
    const path = send?.candidateType ? send : recv
    return {
      candidateType: path?.candidateType ?? null,
      protocol: path?.protocol ?? null,
      rttMs: path?.rttMs ?? null,
      packetsLost: recv?.packetsLost ?? null,
      packetsReceived: recv?.packetsReceived ?? null,
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake() // release any pending waitUntilConnected → resolves false
    this.cleanupSocketHandlers()
    try { this.audioProducer?.close() } catch { /* noop */ }
    try { this.videoProducer?.close() } catch { /* noop */ }
    try { this.sendTransport?.close() } catch { /* noop */ }
    try { this.recvTransport?.close() } catch { /* noop */ }
    this.consumers.clear()
    this.peerStreams.clear()
    this.producers.clear()
    this.wanted.clear()
  }
}

/** What one protocol's connection check found. */
export type ProbeOutcome = 'reachable' | 'unreachable' | 'sfu-off' | 'rate-limited' | 'error'

/**
 * "Can this browser reach the voice server's media port over this protocol?" — answered by really
 * connecting a WebRTC transport to it, outside any call. The server hands out a transport that
 * accepts only `protocol`; this side runs ICE and DTLS against it and reports whether that got
 * through. No microphone is opened and nothing is played: the track is silence from an
 * AudioContext, there only because a transport does not start connecting until it has something to
 * send, and the server never registers it (the 'produce' step is answered locally).
 */
export async function probeSfu(socket: Socket, protocol: 'udp' | 'tcp', timeoutMs = 7000): Promise<ProbeOutcome> {
  let params: any
  try {
    params = await request<any>(socket, 'sfu:probe-start', { protocol })
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    return code === 'sfu-off' || code === 'rate-limited' ? code : 'error'
  }
  let transport: ms.Transport | null = null
  let audio: AudioContext | null = null
  let track: MediaStreamTrack | null = null
  try {
    const device = new Device()
    await device.load({ routerRtpCapabilities: params.routerRtpCapabilities })
    transport = device.createSendTransport({
      id: params.id,
      iceParameters: params.iceParameters,
      iceCandidates: params.iceCandidates,
      dtlsParameters: params.dtlsParameters,
    })
    const probe = transport
    probe.on('connect', ({ dtlsParameters }, done, fail) => {
      request(socket, 'sfu:probe-connect', { transportId: probe.id, dtlsParameters }).then(() => done()).catch(fail)
    })
    probe.on('produce', (_params, done) => done({ id: `probe-${protocol}` }))
    const connected = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      probe.on('connectionstatechange', (state) => {
        if (state === 'connected') { clearTimeout(timer); resolve(true) }
        else if (state === 'failed') { clearTimeout(timer); resolve(false) }
      })
    })
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return 'error'
    audio = new AC()
    track = audio.createMediaStreamDestination().stream.getAudioTracks()[0]
    await probe.produce({ track, stopTracks: false })
    return (await connected) ? 'reachable' : 'unreachable'
  } catch (err) {
    console.warn('connection check failed', err)
    return 'error'
  } finally {
    try { transport?.close() } catch { /* already closed */ }
    try { track?.stop() } catch { /* already stopped */ }
    try { void audio?.close() } catch { /* already closed */ }
    socket.emit('sfu:probe-stop', { transportId: params.id })
  }
}
