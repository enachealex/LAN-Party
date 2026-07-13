import React, { useEffect, useRef, useState } from 'react'

// Built-in, self-contained activities. Whatever's active is shared with everyone in the voice
// channel and kept in sync by the server — no launch/invite dance. Add a new activity by adding an
// entry here + a view below + a reducer branch on the server.
export const ACTIVITY_TYPES = [
  { id: 'sketch', label: 'Sketch & Guess', icon: '✏️', hint: 'Draw the word — friends race to guess it' },
  { id: 'watch', label: 'Watch Together', icon: '🎬', hint: 'Watch a YouTube video in sync' },
  { id: 'whiteboard', label: 'Whiteboard', icon: '🎨', hint: 'Draw on a shared canvas' },
  { id: 'poll', label: 'Quick Poll', icon: '📊', hint: 'Ask the group a question' },
  { id: 'ttt', label: 'Tic-Tac-Toe', icon: '⭕', hint: 'Two play, others watch' },
]

// Pull an 11-char YouTube id out of a URL (or accept a bare id).
function ytId(input) {
  if (!input) return null
  const s = String(input).trim()
  if (/^[\w-]{11}$/.test(s)) return s
  const m = s.match(/(?:youtu\.be\/|[?&]v=|embed\/|shorts\/)([\w-]{11})/)
  return m ? m[1] : null
}

export default function ActivityPanel({ activity, me, onEvent, onClose }) {
  if (!activity) return null
  const { type, state, by } = activity
  const meta = ACTIVITY_TYPES.find((a) => a.id === type)
  return (
    <div className="activity-panel">
      <div className="activity-head">
        <span className="activity-head-title">{meta?.icon} {meta?.label} <span className="activity-by">· started by {by}</span></span>
        <button type="button" className="activity-close" onClick={onClose} title="End this activity for everyone" aria-label="End activity">✕ End</button>
      </div>
      <div className="activity-body">
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
      <div className="watch-bar">
        <input className="watch-input" placeholder="Paste a YouTube link…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load() }} />
        <button type="button" className="watch-load" onClick={load}>Load</button>
      </div>
      {state.videoId ? <div className="watch-player" ref={containerRef} /> : <div className="watch-empty">Paste a YouTube link above to start watching together. Play, pause, and seek stay in sync for everyone.</div>}
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
  const status = state.winner === 'draw' ? "It's a draw!"
    : state.winner ? `${state.winner} wins! 🎉`
    : !state.players.X || !state.players.O ? 'Waiting for players…'
    : `${state.turn}'s turn`
  return (
    <div className="ttt-activity">
      <div className="ttt-status">{status}</div>
      <div className="ttt-players">{state.players.X || '—'} (X) vs {state.players.O || '—'} (O)</div>
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
