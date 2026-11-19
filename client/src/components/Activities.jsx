import React, { useEffect, useRef, useState } from 'react'
import AppActivity from './AppActivity'

// Built-in, self-contained activities. Whatever's active is shared with everyone in the voice
// channel and kept in sync by the server — no launch/invite dance. Add a new activity by adding an
// entry here + a view below + a reducer branch on the server.
export const ACTIVITY_TYPES = [
  { id: 'movie', label: 'Vault Player', icon: '🍿', hint: 'Watch a film together, in sync, via Vault Player' },
  { id: 'sketch', label: 'Sketch & Guess', icon: '✏️', hint: 'Draw the word — friends race to guess it' },
  { id: 'watch', label: 'Watch Together', icon: '🎬', hint: 'Watch a YouTube video in sync' },
  { id: 'whiteboard', label: 'Whiteboard', icon: '🎨', hint: 'Draw on a shared canvas' },
  { id: 'poll', label: 'Quick Poll', icon: '📊', hint: 'Ask the group a question' },
  { id: 'ttt', label: 'Tic-Tac-Toe', icon: '⭕', hint: 'Two play, others watch' },
]

// Same expression as App.jsx (not imported to avoid a cycle): same-origin in prod, :3000 in dev.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '')

// Pull an 11-char YouTube id out of a URL (or accept a bare id).
function ytId(input) {
  if (!input) return null
  const s = String(input).trim()
  if (/^[\w-]{11}$/.test(s)) return s
  const m = s.match(/(?:youtu\.be\/|[?&]v=|embed\/|shorts\/)([\w-]{11})/)
  return m ? m[1] : null
}

// onClose ends the activity for everyone in it; onExit takes just you back to the call.
export default function ActivityPanel({ activity, me, onEvent, onClose, onExit, askPrompt, appHost }) {
  if (!activity) return null
  const { type, state, by } = activity
  // An uploaded app is not one of the built-ins above: it has its own panel (a Join card first,
  // then the sandboxed frame), in AppActivity. Keyed per run (the server names each one) so a
  // different app, or the same one started again, begins at the card instead of inheriting the last
  // one's "joined" — and whoever started it is auto-joined again, as the server already has them.
  if (type === 'app') {
    if (!appHost || !state) return null
    return <AppActivity key={state.run || `${state.appId}:${by}`} activity={activity} me={me} onEvent={onEvent} onClose={onClose} onExit={onExit} {...appHost} autoJoin={appHost.startedAppId === state.appId && by === me} description={appHost.descriptionFor?.(state.appId) || ''} />
  }
  const meta = ACTIVITY_TYPES.find((a) => a.id === type)
  return (
    <div className="activity-panel">
      <div className="activity-head">
        <span className="activity-head-title">{meta?.icon} {meta?.label} <span className="activity-by">· started by {by}</span></span>
        <span className="app-activity-head-actions">
          {onExit && <button type="button" className="app-activity-leave" onClick={onExit} title="Back to the call. It keeps running for the others in it.">Leave</button>}
          <button type="button" className="activity-close" onClick={onClose} title={`End ${meta?.label || 'this'} for everyone in it`} aria-label="End for everyone in it">✕ End</button>
        </span>
      </div>
      <div className="activity-body">
        {type === 'movie' && <MovieNight state={state} onEvent={onEvent} />}
        {type === 'watch' && <WatchTogether state={state} onEvent={onEvent} />}
        {type === 'whiteboard' && <Whiteboard state={state} onEvent={onEvent} />}
        {type === 'poll' && <PollActivity state={state} me={me} onEvent={onEvent} />}
        {type === 'ttt' && <TicTacToe state={state} me={me} onEvent={onEvent} />}
        {type === 'sketch' && <SketchGuess state={state} me={me} onEvent={onEvent} />}
      </div>
    </div>
  )
}

// ---- Watch Together (synced YouTube) ----
function WatchTogether({ state, onEvent }) {
  const [url, setUrl] = useState('')
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const applyingRef = useRef(false)
  const curVideoRef = useRef(null)

  useEffect(() => {
    if (!window.YT && !document.getElementById('yt-iframe-api')) {
      const s = document.createElement('script'); s.id = 'yt-iframe-api'; s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s)
    }
  }, [])

  // Apply the shared state to the local player (guarded so it doesn't echo back as a new event).
  const applyRemote = () => {
    const p = playerRef.current
    if (!p || !p.getPlayerState) return
    applyingRef.current = true
    try {
      if (state.videoId && curVideoRef.current !== state.videoId) {
        curVideoRef.current = state.videoId
        p.loadVideoById(state.videoId, state.time || 0)
      } else {
        const cur = p.getCurrentTime ? p.getCurrentTime() : 0
        if (Math.abs(cur - (state.time || 0)) > 2.5) p.seekTo(state.time || 0, true)
        if (state.playing) p.playVideo(); else p.pauseVideo()
      }
    } catch (e) { /* ignore */ }
    setTimeout(() => { applyingRef.current = false }, 800)
  }

  // Build the player once we have a video (React never reconciles the YT iframe: it lives in a child
  // div we create imperatively inside a stable container).
  useEffect(() => {
    if (!state.videoId) return
    let cancelled = false
    const build = () => {
      if (cancelled) return
      if (!window.YT || !window.YT.Player || !containerRef.current) { setTimeout(build, 200); return }
      if (playerRef.current) { applyRemote(); return }
      const holder = document.createElement('div')
      containerRef.current.appendChild(holder)
      playerRef.current = new window.YT.Player(holder, {
        videoId: state.videoId,
        width: '100%', height: '100%',
        playerVars: { autoplay: state.playing ? 1 : 0, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { curVideoRef.current = state.videoId; applyRemote() },
          onStateChange: (e) => {
            if (applyingRef.current) return
            const p = playerRef.current
            const t = p && p.getCurrentTime ? p.getCurrentTime() : 0
            const S = window.YT.PlayerState
            if (e.data === S.PLAYING) onEvent({ kind: 'play', time: t })
            else if (e.data === S.PAUSED) onEvent({ kind: 'pause', time: t })
          },
        },
      })
    }
    build()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.videoId])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { applyRemote() }, [state.videoId, state.playing, state.ts])

  const load = () => { const id = ytId(url); if (id) { onEvent({ kind: 'load', videoId: id }); setUrl('') } }

  return (
    <div className="watch-activity">
      <div className="watch-main">
        {state.videoId ? <div className="watch-player" ref={containerRef} /> : <div className="watch-empty">Load a YouTube video from the Watch panel — play, pause, and seek stay in sync for everyone.</div>}
      </div>
      <div className="watch-side">
        <div className="watch-side-title">Load a video</div>
        <input className="watch-input" placeholder="Paste a YouTube link…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load() }} />
        <button type="button" className="watch-load" onClick={load} disabled={!ytId(url)}>Load for everyone</button>
        <div className="watch-side-hint">
          Works with watch, youtu.be, and Shorts links.
          {state.videoId ? ' Loading a new link replaces what the room is watching.' : ''}
        </div>
      </div>
    </div>
  )
}

// ---- Whiteboard (shared canvas) ----
const WB_COLORS = ['#ff5252', '#ffb300', '#ffee58', '#66bb6a', '#29b6f6', '#7e57c2', '#ffffff', '#111111']
function Whiteboard({ state, onEvent }) {
  const canvasRef = useRef(null)
  const drawnRef = useRef(0)
  const drawingRef = useRef(false)
  const lastRef = useRef(null)
  const lastEmit = useRef(0)
  const [color, setColor] = useState('#ff5252')
  const [size, setSize] = useState(0.008)
  const [erase, setErase] = useState(false)

  const drawSeg = (ctx, seg, W, H) => {
    if (!seg || !seg.from || !seg.to) return
    ctx.globalCompositeOperation = seg.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = seg.color || '#fff'
    ctx.lineWidth = Math.max(1, (seg.size || 0.008) * W)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(seg.from.x * W, seg.from.y * H); ctx.lineTo(seg.to.x * W, seg.to.y * H); ctx.stroke()
  }
  // Draw incrementally from the shared stroke list (echo-only: we never draw locally, so the board
  // stays identical for everyone). A shorter list than we've drawn means someone hit Clear.
  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d'); const W = c.width, H = c.height
    const strokes = state.strokes || []
    if (strokes.length < drawnRef.current) { ctx.clearRect(0, 0, W, H); drawnRef.current = 0 }
    for (let i = drawnRef.current; i < strokes.length; i++) drawSeg(ctx, strokes[i], W, H)
    drawnRef.current = strokes.length
  }, [state.strokes])

  const pt = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  const down = (e) => { e.preventDefault(); canvasRef.current.setPointerCapture?.(e.pointerId); drawingRef.current = true; lastRef.current = pt(e) }
  const move = (e) => {
    if (!drawingRef.current) return
    const now = performance.now()
    if (now - lastEmit.current < 20) return // throttle to keep socket traffic sane
    lastEmit.current = now
    const cur = pt(e)
    onEvent({ kind: 'stroke', seg: { from: lastRef.current, to: cur, color, size, erase } })
    lastRef.current = cur
  }
  const up = () => { drawingRef.current = false; lastRef.current = null }

  return (
    <div className="wb-activity">
      <div className="wb-toolbar">
        {WB_COLORS.map((c) => (<button key={c} type="button" className={`wb-color${color === c && !erase ? ' active' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => { setColor(c); setErase(false) }} />))}
        {[['S', 0.004], ['M', 0.008], ['L', 0.016]].map(([l, v]) => (<button key={l} type="button" className={`wb-size${size === v && !erase ? ' active' : ''}`} onClick={() => { setSize(v) }}>{l}</button>))}
        <button type="button" className={`wb-tool${erase ? ' active' : ''}`} onClick={() => setErase((v) => !v)}>Eraser</button>
        <button type="button" className="wb-tool" onClick={() => onEvent({ kind: 'clear' })}>Clear</button>
      </div>
      <div className="wb-stage">
        <canvas ref={canvasRef} width={1280} height={720} className="wb-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      </div>
    </div>
  )
}

// ---- Quick Poll ----
// ---- Movie Night (Vault Movies watch party) ----
// The film itself plays in everyone's Vault Movies desktop app — LAN Party carries the room
// so the whole call can hop in with one click while voice chat stays here.
const VAULT_PUBLIC_HOST = 'party.thejumpvault.com'
const VAULT_DOWNLOAD = 'https://github.com/enachealex/Vault-Player/releases/latest/download/VideoPlayer-win-Setup.exe'

// Accept a bare room code, an invite link (https://…/join/MOVIE-XXXX?server=…), or a
// vaultmovies:// launch link. Returns { code, server } or null.
function parseMovieInvite(input) {
  const s = String(input || '').trim()
  if (!s) return null
  const code = (s.match(/MOVIE-[A-Za-z0-9]{4}/i) || [])[0]
  if (!code) return null
  const server = (s.match(/[?&]server=([^&\s]+)/i) || [])[1]
  return { code: code.toUpperCase(), server: server ? decodeURIComponent(server) : null }
}

// Where the relay lives. The invite may carry a full URL, a public hostname, or a bare LAN
// address (which runs plain http on 5555).
function relayBase(server) {
  const s = String(server || '').trim().replace(/\/+$/, '')
  if (!s) return `https://${VAULT_PUBLIC_HOST}`
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+$/.test(s)) return `https://${s}`
  return `http://${s}:5555` // bare IP: a host's own relay
}

function MovieNight({ state, onEvent }) {
  const [invite, setInvite] = useState('')
  const [title, setTitle] = useState('')
  const [info, setInfo] = useState(null)
  const [infoErr, setInfoErr] = useState('')
  const [joined, setJoined] = useState(false) // playback needs a click before audio is allowed
  const videoRef = useRef(null)
  const skewRef = useRef(0) // our clock minus the relay's

  const base = state.code ? relayBase(state.server) : null
  // A https page cannot fetch or stream from a plain-http LAN relay.
  const mixedBlocked = !!base && window.location.protocol === 'https:' && base.startsWith('http:')

  // Poll the room: is it web-playable, and where is the host right now?
  useEffect(() => {
    if (!state.code || !base || mixedBlocked) return undefined
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(`${base}/room/${encodeURIComponent(state.code)}`, { cache: 'no-store' })
        if (!alive) return
        if (!r.ok) {
          setInfo(null)
          setInfoErr(r.status === 404 ? 'That room has ended.' : 'Could not reach the room.')
          return
        }
        const j = await r.json()
        if (!alive) return
        if (j.serverNowMs) skewRef.current = Date.now() - j.serverNowMs
        setInfo(j)
        setInfoErr('')
      } catch {
        if (alive) setInfoErr('Could not reach the room.')
      }
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [state.code, base, mixedBlocked])

  // Follow the host's clock. The beacon is stamped on the host's machine, so the
  // relay's own time (minus our skew) is what makes the arithmetic honest.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !joined || !info?.webPlayable || info.positionMs == null) return
    const nowOnRelay = Date.now() - skewRef.current
    const elapsed = info.playing && info.atUnixMs ? Math.max(0, nowOnRelay - info.atUnixMs) : 0
    const target = (info.positionMs + elapsed) / 1000
    if (Number.isFinite(target) && Math.abs(v.currentTime - target) > 2) v.currentTime = target
    if (info.playing && v.paused) v.play().catch(() => {})
    if (!info.playing && !v.paused) v.pause()
  }, [info, joined])

  if (!state.code) {
    const parsed = parseMovieInvite(invite)
    return (
      <div className="movie-activity">
        <div className="poll-setup">
          <div className="poll-setup-title">Share your Vault Movies room</div>
          <div className="movie-hint">
            Host a Watch Party in Vault Movies, hit <b>Invite link</b> (or copy the room code),
            and paste it here — everyone in the call gets a one-click Join.
          </div>
          <input className="poll-q" placeholder="Invite link or room code (MOVIE-XXXX)" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <input className="poll-q" placeholder="What are you watching? (optional)" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="button" className="poll-create" disabled={!parsed} onClick={() => onEvent({ kind: 'set', code: parsed.code, server: parsed.server, title: title.trim() })}>Start movie night</button>
        </div>
      </div>
    )
  }
  const server = state.server || VAULT_PUBLIC_HOST
  const launch = `vaultmovies://join?code=${encodeURIComponent(state.code)}&server=${encodeURIComponent(server)}`

  // Hand Vault Player a short-lived SSO assertion so the user lands already signed in as their LAN
  // Party identity. Minted on CLICK, not on mount: the assertion only lives 60s, so fetching it
  // early would usually hand over an expired one. Never the LAN Party session token itself.
  const openInVaultPlayer = async (e) => {
    e.preventDefault()
    let url = launch
    try {
      const t = localStorage.getItem('lanparty_token') || ''
      const r = await fetch(`${SERVER_URL}/integrations/vault/sso-token`, {
        method: 'POST', headers: { Authorization: `Bearer ${t}` },
      })
      if (r.ok) {
        const { token } = await r.json()
        if (token) url += `&sso=${encodeURIComponent(token)}`
      }
      // A 503 just means SSO isn't configured — fall through and open without it.
    } catch (_) { /* offline or blocked: the plain deep link still works */ }
    window.location.href = url
  }
  const heading = info?.title || state.title || 'Movie night'

  // Watchable right here: stream it from the relay and follow the host.
  if (info?.webPlayable && !mixedBlocked) {
    return (
      <div className="movie-activity playing">
        <div className="movie-player">
          <video
            ref={videoRef}
            className="movie-video"
            src={`${base}/stream/${encodeURIComponent(state.code)}`}
            playsInline
            controls={false}
            preload="auto"
          />
          {!joined && (
            <button type="button" className="movie-gate" onClick={() => { setJoined(true); videoRef.current?.play().catch(() => {}) }}>
              <span className="movie-gate-emoji">🍿</span>
              <span className="movie-gate-title">{heading}</span>
              <span className="movie-gate-cta">Click to watch with everyone</span>
            </button>
          )}
        </div>
        <div className="movie-playbar">
          <span className="movie-playbar-title">{heading}</span>
          <span className="movie-playbar-sync">
            {info.playing === false ? 'Paused by the host' : `In sync with ${info.host || 'the host'}`}
          </span>
          <a className="movie-playbar-app" href={launch} onClick={openInVaultPlayer}>Open in the app instead</a>
          <button type="button" className="movie-change" onClick={() => onEvent({ kind: 'clear' })}>Change room</button>
        </div>
      </div>
    )
  }

  // Everything else — HEVC, MKV, DTS, a streaming title, or a http-only LAN relay
  // on an https page. Transcoding these would cost the host real CPU, so the app,
  // which decodes them natively, is the right place to watch.
  const needsApp = mixedBlocked
    ? 'This room is hosted on a local network address, which a web page can’t stream from.'
    : info?.service
      ? `Playing on ${info.service} — everyone opens it in their own app.`
      : info?.webReason || 'This film needs the Vault Player app.'

  return (
    <div className="movie-activity">
      <div className="movie-card">
        <div className="movie-emoji">🍿</div>
        <div className="movie-title">{heading}</div>
        <div className="movie-code">{state.code}</div>
        <div className="movie-needsapp">
          {infoErr || (info ? needsApp : 'Checking the room…')}
        </div>
        <a className="movie-join" href={launch} onClick={openInVaultPlayer}>Open in Vault Player</a>
        <div className="movie-foot">
          <a className="movie-get" href={VAULT_DOWNLOAD} target="_blank" rel="noreferrer">Don&apos;t have Vault Movies?</a>
          <button type="button" className="movie-change" onClick={() => onEvent({ kind: 'clear' })}>Change room</button>
        </div>
      </div>
    </div>
  )
}

function PollActivity({ state, me, onEvent }) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState(['', ''])
  const hasPoll = state.options && state.options.length > 0
  if (!hasPoll) {
    const valid = q.trim() && opts.filter((o) => o.trim()).length >= 2
    return (
      <div className="poll-activity">
        <div className="poll-setup">
          <div className="poll-setup-title">Create a poll</div>
          <input className="poll-q" placeholder="Ask a question…" value={q} maxLength={140} onChange={(e) => setQ(e.target.value)} />
          {opts.map((o, i) => (
            <input key={i} className="poll-opt-in" placeholder={`Option ${i + 1}`} value={o} maxLength={60} onChange={(e) => setOpts((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
          ))}
          {opts.length < 6 && <button type="button" className="poll-addopt" onClick={() => setOpts((a) => [...a, ''])}>+ Add option</button>}
          <button type="button" className="poll-create" disabled={!valid} onClick={() => onEvent({ kind: 'create', question: q.trim(), options: opts.map((o) => o.trim()).filter(Boolean) })}>Start poll</button>
        </div>
      </div>
    )
  }
  const total = state.options.reduce((n, o) => n + o.votes.length, 0)
  const myVote = state.options.findIndex((o) => o.votes.includes(me))
  return (
    <div className="poll-activity">
      <div className="poll-question">{state.question}</div>
      <div className="poll-options">
        {state.options.map((o, i) => {
          const pct = total ? Math.round((o.votes.length / total) * 100) : 0
          return (
            <button key={i} type="button" className={`poll-option${myVote === i ? ' mine' : ''}`} disabled={state.closed} onClick={() => onEvent({ kind: 'vote', index: i })}>
              <span className="poll-fill" style={{ width: pct + '%' }} />
              <span className="poll-option-text">{o.text}</span>
              <span className="poll-option-count">{o.votes.length} · {pct}%</span>
            </button>
          )
        })}
      </div>
      <div className="poll-foot">
        <span>{total} vote{total === 1 ? '' : 's'}{state.closed ? ' · closed' : ''}</span>
        {!state.closed && <button type="button" className="poll-close" onClick={() => onEvent({ kind: 'close' })}>Close poll</button>}
      </div>
    </div>
  )
}

// ---- Sketch & Guess (skribbl-style party game) ----
// The server owns the game: it picks the word (only the drawer receives it — everyone else gets a
// redacted state with just the mask), validates who may draw, and scores guesses.
function SketchGuess({ state, me, onEvent }) {
  const canvasRef = useRef(null)
  const drawnRef = useRef(0)
  const drawingRef = useRef(false)
  const lastRef = useRef(null)
  const lastEmit = useRef(0)
  const guessesEndRef = useRef(null)
  const [color, setColor] = useState('#111111')
  const [size, setSize] = useState(0.008)
  const [guess, setGuess] = useState('')

  const drawer = state.players.length ? state.players[state.turnIdx % state.players.length].name : null
  const isDrawer = state.phase === 'play' && drawer === me
  const seated = state.players.some((p) => p.name === me)
  const solvedIt = state.solvedBy.includes(me)
  const ranked = [...state.players].sort((a, b) => b.score - a.score)

  const drawSeg = (ctx, seg, W, H) => {
    if (!seg || !seg.from || !seg.to) return
    ctx.globalCompositeOperation = seg.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = seg.color || '#111'
    ctx.lineWidth = Math.max(1, (seg.size || 0.008) * W)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(seg.from.x * W, seg.from.y * H); ctx.lineTo(seg.to.x * W, seg.to.y * H); ctx.stroke()
  }
  // Echo-drawn from shared state (identical for everyone); shorter list = new turn/clear.
  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d'); const W = c.width, H = c.height
    const strokes = state.strokes || []
    if (strokes.length < drawnRef.current) { ctx.clearRect(0, 0, W, H); drawnRef.current = 0 }
    for (let i = drawnRef.current; i < strokes.length; i++) drawSeg(ctx, strokes[i], W, H)
    drawnRef.current = strokes.length
  }, [state.strokes])
  useEffect(() => { guessesEndRef.current?.scrollIntoView?.({ block: 'end' }) }, [state.guesses])

  const pt = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  const down = (e) => { if (!isDrawer) return; e.preventDefault(); canvasRef.current.setPointerCapture?.(e.pointerId); drawingRef.current = true; lastRef.current = pt(e) }
  const move = (e) => {
    if (!drawingRef.current || !isDrawer) return
    const now = performance.now()
    if (now - lastEmit.current < 20) return
    lastEmit.current = now
    const cur = pt(e)
    onEvent({ kind: 'stroke', seg: { from: lastRef.current, to: cur, color, size } })
    lastRef.current = cur
  }
  const up = () => { drawingRef.current = false; lastRef.current = null }
  const sendGuess = () => { const g = guess.trim(); if (g) { onEvent({ kind: 'guess', text: g }); setGuess('') } }

  if (state.phase === 'lobby') {
    return (
      <div className="sketch-lobby">
        <div className="sketch-lobby-title">✏️ Sketch &amp; Guess</div>
        <div className="sketch-lobby-sub">Take turns drawing a secret word while everyone races to guess it. Guess fast for the points — everyone draws twice.</div>
        <div className="sketch-seats">
          {state.players.map((p) => (<span key={p.name} className="sketch-seat">{p.name}</span>))}
          {state.players.length === 0 && <span className="sketch-seat empty">No players yet</span>}
        </div>
        <div className="sketch-lobby-actions">
          {!seated && <button type="button" className="sketch-btn" onClick={() => onEvent({ kind: 'join' })}>🎮 Take a seat</button>}
          {seated && state.players.length >= 2 && <button type="button" className="sketch-btn go" onClick={() => onEvent({ kind: 'start' })}>▶ Start game</button>}
          {seated && state.players.length < 2 && <span className="sketch-note">Waiting for at least 2 players…</span>}
        </div>
      </div>
    )
  }

  if (state.phase === 'end') {
    return (
      <div className="sketch-lobby">
        <div className="sketch-lobby-title">🏆 Final scores</div>
        <div className="sketch-scoreboard">
          {ranked.map((p, i) => (
            <div key={p.name} className={`sketch-score-row${i === 0 ? ' winner' : ''}`}>
              <span>{i === 0 ? '👑 ' : `${i + 1}. `}{p.name}</span><span>{p.score}</span>
            </div>
          ))}
        </div>
        <div className="sketch-lobby-actions">
          <button type="button" className="sketch-btn go" onClick={() => onEvent({ kind: 'reset' })}>🔁 Play again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="sketch-game">
      <div className="sketch-topbar">
        <span className="sketch-round">Turn {Math.min(state.turnIdx + 1, state.totalTurns)}/{state.totalTurns}</span>
        <span className="sketch-word">{isDrawer ? `Draw: ${state.word}` : (state.wordMask || '').split('').join(' ')}</span>
        <span className="sketch-drawer">🖌️ {drawer}{isDrawer ? ' (you)' : ''}</span>
      </div>
      {state.lastResult && <div className="sketch-result">{state.lastResult}</div>}
      <div className="sketch-main">
        <div className="sketch-canvas-wrap">
          {isDrawer && (
            <div className="sketch-tools">
              {['#111111', '#e0574d', '#2b6cff', '#1f9d55', '#f0a020', '#7e57c2'].map((c) => (
                <button key={c} type="button" className={`wb-color${color === c ? ' active' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => setColor(c)} />
              ))}
              {[['S', 0.004], ['M', 0.008], ['L', 0.016]].map(([l, v]) => (
                <button key={l} type="button" className={`wb-size${size === v ? ' active' : ''}`} onClick={() => setSize(v)}>{l}</button>
              ))}
              <button type="button" className="wb-tool" onClick={() => onEvent({ kind: 'clear' })}>Clear</button>
              <button type="button" className="wb-tool" onClick={() => onEvent({ kind: 'skip' })}>Skip word</button>
            </div>
          )}
          <div className="wb-stage sketch-stage">
            <canvas ref={canvasRef} width={1280} height={720} className="wb-canvas" style={{ cursor: isDrawer ? 'crosshair' : 'default' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
          </div>
        </div>
        <div className="sketch-side">
          <div className="sketch-players">
            {ranked.map((p) => (
              <div key={p.name} className={`sketch-player${p.name === drawer ? ' drawing' : ''}${state.solvedBy.includes(p.name) ? ' solved' : ''}`}>
                <span>{p.name === drawer ? '🖌️ ' : state.solvedBy.includes(p.name) ? '✅ ' : ''}{p.name}</span><span>{p.score}</span>
              </div>
            ))}
          </div>
          <div className="sketch-guesses">
            {state.guesses.map((g, i) => (
              <div key={i} className={`sketch-guess${g.correct ? ' correct' : ''}`}>
                <strong>{g.by}</strong> {g.correct ? 'guessed the word! 🎉' : g.text}
              </div>
            ))}
            <div ref={guessesEndRef} />
          </div>
          {!isDrawer && seated && (
            <div className="sketch-guess-bar">
              <input className="sketch-guess-input" placeholder={solvedIt ? 'You got it! 🎉' : 'Type your guess…'} disabled={solvedIt} value={guess} maxLength={60} onChange={(e) => setGuess(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendGuess() }} />
              <button type="button" className="sketch-btn" disabled={solvedIt} onClick={sendGuess}>Guess</button>
            </div>
          )}
          {!seated && <div className="sketch-note">👀 Spectating — join the next game from the lobby.</div>}
        </div>
      </div>
    </div>
  )
}

// ---- Tic-Tac-Toe ----
function TicTacToe({ state, me, onEvent }) {
  const isX = state.players.X === me
  const isO = state.players.O === me
  const joined = isX || isO
  const myMark = isX ? 'X' : isO ? 'O' : null
  const seatsOpen = !state.players.X || !state.players.O
  const myTurn = joined && state.winner == null && myMark === state.turn
  const scores = state.scores || {}
  const draws = state.draws || 0
  const winnerName = state.winner && state.winner !== 'draw' ? state.players[state.winner] : null
  const status = state.winner === 'draw' ? "It's a draw!"
    : state.winner ? `${winnerName || state.winner} wins! 🎉`
    : !state.players.X || !state.players.O ? 'Waiting for players…'
    : `${state.turn}'s turn`
  const bothSeated = state.players.X && state.players.O
  const xScore = scores[state.players.X] || 0
  const oScore = scores[state.players.O] || 0
  return (
    <div className="ttt-activity">
      <div className="ttt-status">{status}</div>
      <div className="ttt-players">{state.players.X || '—'} (X) vs {state.players.O || '—'} (O)</div>
      {bothSeated && (
        <div className="ttt-scoreboard" title="Wins this session">
          <span className={`ttt-score${xScore > oScore ? ' leading' : ''}`}><b>{state.players.X}</b> {xScore}</span>
          <span className="ttt-score ttt-score-draws">🤝 {draws}</span>
          <span className={`ttt-score${oScore > xScore ? ' leading' : ''}`}>{oScore} <b>{state.players.O}</b></span>
        </div>
      )}
      <div className="ttt-board">
        {state.board.map((c, i) => (
          <button key={i} type="button" className={`ttt-cell${c ? ' filled' : ''}`} disabled={!myTurn || !!c || state.winner != null} onClick={() => onEvent({ kind: 'move', i })}>{c}</button>
        ))}
      </div>
      <div className="ttt-foot">
        {!joined && seatsOpen && <button type="button" className="ttt-btn" onClick={() => onEvent({ kind: 'join' })}>Take a seat</button>}
        {!joined && !seatsOpen && <span className="ttt-note">👀 Spectating</span>}
        {joined && <span className="ttt-note">You are {myMark}</span>}
        {state.winner != null && <button type="button" className="ttt-btn" onClick={() => onEvent({ kind: 'reset' })}>Play again</button>}
      </div>
    </div>
  )
}
