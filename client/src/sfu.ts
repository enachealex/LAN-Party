// Client side of the voice-room SFU (mediasoup). One session per joined voice room: the local mic
// (and at most one video track — camera OR screen, mirroring the mesh) is produced once to the
// server, and every remote participant's media is consumed into a single MediaStream per peer
// socket id — the exact shape the existing UI (remoteStreams keyed by peer id) already renders.
//
// SfuSession.create() resolves null when the server has no SFU for this room (disabled, worker
// dead, old server) — the caller then uses the P2P mesh exactly as before.
import { Device } from 'mediasoup-client'
import type { types as ms } from 'mediasoup-client'
import type { Socket } from 'socket.io-client'

interface SfuCallbacks {
  /** A remote peer's stream exists (fires once per peer; tracks are added/removed in place). */
  onPeerStream: (peerSocketId: string, stream: MediaStream) => void
  /** A remote peer's stream is gone (all their producers closed). */
  onPeerGone: (peerSocketId: string) => void
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
  private callbacks: SfuCallbacks
  private closed = false
  private cleanupSocketHandlers: () => void

  private constructor(socket: Socket, device: Device, callbacks: SfuCallbacks) {
    this.socket = socket
    this.device = device
    this.callbacks = callbacks

    const onNewProducer = (info: ProducerInfo) => { void this.consume(info) }
    const onProducerClosed = ({ producerId, peerSocketId }: { producerId: string; peerSocketId: string }) => {
      for (const [consumerId, entry] of this.consumers) {
        if (entry.consumer.producerId === producerId) this.dropConsumer(consumerId)
      }
      void peerSocketId
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

  /** Probe the server for this room; null → no SFU, use the mesh. */
  static async create(socket: Socket, room: { serverId: string; channelId: string }, callbacks: SfuCallbacks): Promise<SfuSession | null> {
    let caps: { routerRtpCapabilities: ms.RtpCapabilities } | null = null
    try { caps = await request(socket, 'sfu:caps', room) } catch { return null }
    if (!caps) return null
    const device = new Device()
    await device.load({ routerRtpCapabilities: caps.routerRtpCapabilities })
    return new SfuSession(socket, device, callbacks)
  }

  /** Create both transports. Called AFTER voice:join (the server requires room membership). */
  async connect(): Promise<void> {
    this.sendTransport = await this.createTransport('send')
    this.recvTransport = await this.createTransport('recv')
    // Late join: consume everything already being produced in the room.
    const existing = await request<ProducerInfo[]>(this.socket, 'sfu:producers', {})
    for (const info of existing) await this.consume(info).catch((e) => console.warn('sfu consume failed', e))
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<ms.Transport> {
    const params = await request<any>(this.socket, 'sfu:create-transport', { direction })
    const transport = direction === 'send'
      ? this.device.createSendTransport(params)
      : this.device.createRecvTransport(params)
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

  async produceAudio(track: MediaStreamTrack): Promise<void> {
    if (!this.sendTransport || this.audioProducer) return
    this.audioProducer = await this.sendTransport.produce({ track, appData: { type: 'mic' } })
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
    const data = await request<any>(this.socket, 'sfu:consume', {
      transportId: this.recvTransport.id,
      producerId: info.producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    })
    if (this.closed) return
    const consumer = await this.recvTransport.consume({
      id: data.id, producerId: data.producerId, kind: data.kind, rtpParameters: data.rtpParameters,
    })
    this.consumers.set(consumer.id, { consumer, peerSocketId: info.peerSocketId })

    let stream = this.peerStreams.get(info.peerSocketId)
    const isNew = !stream
    if (!stream) { stream = new MediaStream(); this.peerStreams.set(info.peerSocketId, stream) }
    stream.addTrack(consumer.track)
    if (isNew) this.callbacks.onPeerStream(info.peerSocketId, stream)

    // Server-side consumers start paused so the first keyframe isn't sent into the void.
    await request(this.socket, 'sfu:resume-consumer', { consumerId: consumer.id })
  }

  private dropConsumer(consumerId: string): void {
    const entry = this.consumers.get(consumerId)
    if (!entry) return
    this.consumers.delete(consumerId)
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

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cleanupSocketHandlers()
    try { this.audioProducer?.close() } catch { /* noop */ }
    try { this.videoProducer?.close() } catch { /* noop */ }
    try { this.sendTransport?.close() } catch { /* noop */ }
    try { this.recvTransport?.close() } catch { /* noop */ }
    this.consumers.clear()
    this.peerStreams.clear()
  }
}
