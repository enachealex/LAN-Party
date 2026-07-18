import { useEffect, useRef, useState } from 'react'

// Rendered inside the transparent, always-on-top Electron overlay window (loaded via /app/?overlay=1).
// Receives the call's remote video from the main window over a loopback WebRTC connection, relayed by
// the main process through window.overlayBridge (exposed by overlay-preload.js).
export default function CallOverlay() {
  const vidRef = useRef(null)
  const pcRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [solid, setSolid] = useState(false)

  useEffect(() => {
    const b = window.overlayBridge
    if (!b) return
    const makePc = () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.onicecandidate = (e) => { if (e.candidate) b.send({ type: 'candidate', candidate: e.candidate }) }
      pc.ontrack = (e) => { if (vidRef.current) vidRef.current.srcObject = e.streams[0]; setConnected(true) }
      pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) setConnected(false) }
      pcRef.current = pc
      return pc
    }
    b.onSignal(async (msg) => {
      if (!msg) return
      try {
        if (msg.type === 'offer') {
          const pc = pcRef.current || makePc()
          await pc.setRemoteDescription(msg.sdp)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          b.send({ type: 'answer', sdp: pc.localDescription })
        } else if (msg.type === 'candidate' && pcRef.current) {
          try { await pcRef.current.addIceCandidate(msg.candidate) } catch (_) {}
        } else if (msg.type === 'reset') {
          try { pcRef.current?.close() } catch (_) {}
          pcRef.current = null
          if (vidRef.current) vidRef.current.srcObject = null
          setConnected(false)
        }
      } catch (e) { console.warn('overlay signal error', e) }
    })
    b.send({ type: 'ready' }) // tell the main renderer to send its offer
    return () => { try { pcRef.current?.close() } catch (_) {} }
  }, [])

  const b = window.overlayBridge
  // Drag the bottom-right handle → the main process resizes the frameless window.
  const startResize = (e) => {
    e.preventDefault()
    let lx = e.screenX, ly = e.screenY
    const mv = (ev) => { b?.resizeBy(ev.screenX - lx, ev.screenY - ly); lx = ev.screenX; ly = ev.screenY }
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={`calloverlay ${solid ? 'solid' : ''}`}>
      <video ref={vidRef} autoPlay playsInline className="calloverlay-vid" />
      {!connected && <div className="calloverlay-ph">Connecting to your call…</div>}
      <div className="calloverlay-bar">
        <span className="calloverlay-title">🔴 LAN Party</span>
        <span className="calloverlay-btns">
          <button className="calloverlay-btn" title="Toggle transparency" onClick={() => setSolid((s) => !s)}>◐</button>
          <button className="calloverlay-btn" title="Back to app" onClick={() => b?.restore()}>⤢</button>
          <button className="calloverlay-btn close" title="Close" onClick={() => b?.close()}>✕</button>
        </span>
      </div>
      <div className="calloverlay-resize" onMouseDown={startResize} title="Resize" />
    </div>
  )
}
