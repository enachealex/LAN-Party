import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Soundboard names are kept short so they fit on a tile (see .sb-pad-name in styles.css).
const SOUND_NAME_MAX = 12

// Modern pad-grid soundboard shown above the composer.
// Click a pad to fire the clip (broadcast to the channel); + adds a clip; right-click removes one.
export default function Soundboard({
  sounds = [],
  playingIds = [],
  volume = 0.8,
  onSetVolume,
  onPlay,
  onUpload,
  onRename,
  onDelete,
  onClose,
}) {
  const rootRef = useRef(null)
  const uploadRef = useRef(null)
  const menuRef = useRef(null)
  const [query, setQuery] = useState('')
  // Right-click context menu on a pad: { id, name, x, y } in viewport coords (rendered in a portal).
  const [menu, setMenu] = useState(null)
  // Inline rename state: { id, name } while renaming a pad.
  const [renaming, setRenaming] = useState(null)
  // A file awaiting a custom name before upload: { file, name }.
  const [pendingUpload, setPendingUpload] = useState(null)

  // Close on outside click / Esc.
  useEffect(() => {
    const onDown = (e) => {
      // Clicks on the portalled context menu count as "inside" so selecting an item doesn't close the board.
      if (menuRef.current && menuRef.current.contains(e.target)) return
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') { setMenu(null); onClose?.() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sounds
    return sounds.filter((s) => (s.name || '').toLowerCase().includes(q))
  }, [sounds, query])

  // Picking a file opens a naming prompt (the user must give it a short custom name).
  const handleUpload = (event) => {
    const file = event.target.files?.[0]
    if (file) {
      const suggested = (file.name || 'sound').replace(/\.[^.]+$/, '').slice(0, SOUND_NAME_MAX)
      setPendingUpload({ file, name: suggested })
    }
    if (event.target) event.target.value = ''
  }
  const confirmUpload = () => {
    const next = (pendingUpload?.name || '').trim()
    if (pendingUpload && next) onUpload?.(pendingUpload.file, next.slice(0, SOUND_NAME_MAX))
    setPendingUpload(null)
  }

  const openMenu = (e, sound) => {
    e.preventDefault()
    // Viewport coords, clamped so the menu never spills off the right/bottom edges.
    const x = Math.min(e.clientX, window.innerWidth - 160)
    const y = Math.min(e.clientY, window.innerHeight - 130)
    setMenu({ id: sound.id, name: sound.name || 'Sound', x, y })
  }
  const playFromMenu = () => {
    if (menu) onPlay?.(sounds.find((s) => s.id === menu.id))
    setMenu(null)
  }
  const startRename = () => {
    if (menu) setRenaming({ id: menu.id, name: menu.name })
    setMenu(null)
  }
  const confirmRename = () => {
    const next = (renaming?.name || '').trim()
    if (renaming && next) onRename?.(renaming.id, next.slice(0, SOUND_NAME_MAX))
    setRenaming(null)
  }
  const deleteFromMenu = () => {
    if (menu) onDelete?.(menu.id)
    setMenu(null)
  }

  return (
    <div className="soundboard" ref={rootRef} onClick={() => setMenu(null)}>
      <div className="sb-head">
        <input
          className="gif-search sb-search"
          placeholder="Search sounds"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="gif-add-btn" title="Add a sound" aria-label="Add a sound" onClick={() => uploadRef.current?.click()}>+</button>
      </div>

      <div className="sb-volume">
        <span aria-hidden="true">🔈</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(e) => onSetVolume?.(Number(e.target.value))}
          aria-label="Soundboard volume"
        />
        <span aria-hidden="true">🔊</span>
      </div>

      <div className="sb-scroll">
        {filtered.length === 0 ? (
          <div className="gif-empty">{sounds.length === 0 ? 'No sounds yet. Click + to add one to the shared soundboard.' : 'No sounds match your search.'}</div>
        ) : (
          <div className="sb-grid">
            {filtered.map((s) => {
              const playing = playingIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`sb-pad${playing ? ' playing' : ''}`}
                  style={{ '--pad-color': s.color || '#4b7bec' }}
                  title={`${s.name || 'Sound'} — right-click for options`}
                  onClick={() => onPlay?.(s)}
                  onContextMenu={(e) => openMenu(e, s)}
                >
                  <span className="sb-pad-name">{s.name || 'Sound'}</span>
                  <span className="sb-eq" aria-hidden="true">
                    <i></i><i></i><i></i><i></i>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {menu && createPortal(
        <div ref={menuRef} className="emoji-context-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 2000 }} role="menu">
          <button type="button" onClick={playFromMenu}>Play</button>
          <button type="button" onClick={startRename}>Rename</button>
          <button type="button" className="danger" onClick={deleteFromMenu}>Remove</button>
        </div>,
        document.body
      )}

      {pendingUpload && (
        <div className="emoji-name-prompt" onClick={(e) => e.stopPropagation()}>
          <div className="emoji-name-prompt-inner">
            <div className="emoji-name-fields">
              <label>Name this sound <span className="sb-name-count">{pendingUpload.name.length}/{SOUND_NAME_MAX}</span></label>
              <div className="emoji-name-input">
                <input
                  autoFocus
                  value={pendingUpload.name}
                  onChange={(e) => setPendingUpload((p) => ({ ...p, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmUpload()
                    else if (e.key === 'Escape') setPendingUpload(null)
                  }}
                  placeholder="Sound name"
                  maxLength={SOUND_NAME_MAX}
                />
              </div>
              <div className="emoji-name-actions">
                <button type="button" className="ghost" onClick={() => setPendingUpload(null)}>Cancel</button>
                <button type="button" className="primary" onClick={confirmUpload} disabled={!pendingUpload.name.trim()}>Add sound</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="emoji-name-prompt" onClick={(e) => e.stopPropagation()}>
          <div className="emoji-name-prompt-inner">
            <div className="emoji-name-fields">
              <label>Rename sound <span className="sb-name-count">{renaming.name.length}/{SOUND_NAME_MAX}</span></label>
              <div className="emoji-name-input">
                <input
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming((r) => ({ ...r, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmRename()
                    else if (e.key === 'Escape') setRenaming(null)
                  }}
                  placeholder="Sound name"
                  maxLength={SOUND_NAME_MAX}
                />
              </div>
              <div className="emoji-name-actions">
                <button type="button" className="ghost" onClick={() => setRenaming(null)}>Cancel</button>
                <button type="button" className="primary" onClick={confirmRename} disabled={!renaming.name.trim()}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input ref={uploadRef} type="file" accept="audio/*" className="file-input" onChange={handleUpload} />
    </div>
  )
}
