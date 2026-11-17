import React, { useCallback, useEffect, useRef, useState } from 'react'
import longPressProps from '../longPress'
import FloatingMenu from './FloatingMenu'

// GIF picker shown above the composer (opened from the GIF button next to Emoji).
//
// One library: LAN Party's own, kept on this server (server/services/gifLibrary.js). No third-party
// GIF service. The search box asks the server, which matches every word against each GIF's name
// and tags; results come a page at a time, and scrolling near the bottom fetches the next page.
//
// Callbacks (App.jsx), each resolving to what changed so the open grid can follow without a refetch:
//   onSearchGifs(q, before) -> { gifs, next }
//   onUploadGif(file)       -> the added gif (or the one already in the library), or null
//   onEditGif(gif)          -> the updated gif, or null
//   onDeleteGif(gif)        -> true when it was removed
// Right-click (long-press on touch) a GIF to edit or remove it: offered only on the ones you may
// change (`canManage`, decided by the server: whoever added it, and the instance owners).
export default function GifPicker({
  onSelectGif,
  onSearchGifs,
  onUploadGif,
  onEditGif,
  onDeleteGif,
  resolveSrc = (u) => u,
  onClose,
}) {
  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  // Portaled right-click menu node — exempt from the outside-click close (see FloatingMenu).
  const menuRef = useRef(null)
  const gifUploadRef = useRef(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [gifs, setGifs] = useState([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  // Right-click context menu on a GIF: { gif, x, y }.
  const [gifMenu, setGifMenu] = useState(null)
  // The next page's cursor and the in-flight guard live in refs so the scroll handler sees fresh
  // values; reqId discards a late reply to a query that has since changed.
  const nextRef = useRef(null)
  const loadingRef = useRef(false)
  const reqIdRef = useRef(0)

  // Close on outside click / Esc.
  useEffect(() => {
    const onDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return // clicking a menu option
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') { setGifMenu(null); onClose?.() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Search on a settled query, not on each keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(handle)
  }, [query])

  const fetchPage = useCallback(async (q, before, reqId) => {
    loadingRef.current = true
    setLoading(true)
    let page = { gifs: [], next: null }
    try { page = (await onSearchGifs?.(q, before)) || page } catch { /* keep empty */ }
    if (reqIdRef.current !== reqId) return
    setGifs((prev) => (before ? [...prev, ...page.gifs.filter((g) => !prev.some((p) => p.id === g.id))] : page.gifs))
    nextRef.current = page.next ?? null
    loadingRef.current = false
    setLoading(false)
    setLoaded(true)
  }, [onSearchGifs])

  // First page whenever the picker opens or the query changes.
  useEffect(() => {
    const reqId = ++reqIdRef.current
    nextRef.current = null
    fetchPage(debouncedQuery, null, reqId)
  }, [debouncedQuery, fetchPage])

  // Infinite scroll: the next page as the grid nears its end.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const onScroll = () => {
      if (loadingRef.current || nextRef.current == null) return
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 260) {
        fetchPage(debouncedQuery, nextRef.current, reqIdRef.current)
      }
    }
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [debouncedQuery, fetchPage])

  const handleGifUpload = async (event) => {
    const file = event.target.files?.[0]
    if (event.target) event.target.value = ''
    if (!file || !onUploadGif) return
    setBusy(true)
    try {
      const added = await onUploadGif(file)
      if (added) setGifs((prev) => [added, ...prev.filter((g) => g.id !== added.id)])
    } finally {
      setBusy(false)
    }
  }

  const openGifMenu = (e, gif) => {
    e.preventDefault()
    if (!gif.canManage) return
    setGifMenu({ gif, x: e.clientX, y: e.clientY }) // viewport coords; FloatingMenu clamps on screen
  }
  const editFromMenu = async () => {
    const gif = gifMenu?.gif
    setGifMenu(null)
    if (!gif) return
    const updated = await onEditGif?.(gif)
    if (updated) setGifs((prev) => prev.map((g) => (g.id === updated.id ? updated : g)))
  }
  const deleteFromMenu = async () => {
    const gif = gifMenu?.gif
    setGifMenu(null)
    if (!gif) return
    if (await onDeleteGif?.(gif)) setGifs((prev) => prev.filter((g) => g.id !== gif.id))
  }

  const describe = (g) => {
    const tags = Array.isArray(g.tags) && g.tags.length ? ` · ${g.tags.map((t) => `#${t}`).join(' ')}` : ''
    return `${g.name || 'GIF'}${tags}${g.canManage ? ' — right-click to edit or remove' : ''}`
  }

  return (
    <div className="emoji-picker gif-picker" ref={rootRef} onClick={() => setGifMenu(null)}>
      <div className="emoji-picker-scroll" ref={scrollRef}>
        <div className="emoji-group">
          <div className="gif-custom-head">
            <input
              className="gif-search"
              placeholder="Search GIFs by name or tag"
              aria-label="Search GIFs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <button type="button" className="emoji-upload-btn" title="Add a GIF to the library" aria-label="Add a GIF" disabled={busy} onClick={() => gifUploadRef.current?.click()}>{busy ? '…' : '+'}</button>
          </div>
          {gifs.length === 0 ? (
            <div className="emoji-empty">
              {!loaded || loading ? 'Loading…'
                : debouncedQuery ? 'No GIFs match your search.'
                  : 'No GIFs yet. Click + to add one, or right-click an image in chat and choose "Add to GIF library".'}
            </div>
          ) : (
            <div className="gif-grid">
              {gifs.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="gif-cell"
                  title={describe(g)}
                  onClick={() => onSelectGif?.(g)}
                  onContextMenu={(e) => openGifMenu(e, g)}
                  {...longPressProps((e) => openGifMenu(e, g))}
                >
                  <img src={resolveSrc(g.url)} alt={g.name || 'GIF'} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {loading && gifs.length > 0 && <div className="emoji-empty">Loading…</div>}
          {/* The library includes Google's animated Noto Emoji, which are CC BY 4.0: they need a credit. */}
          <div className="gif-credits">
            Animated emoji: <a href="https://googlefonts.github.io/noto-emoji-animation/" target="_blank" rel="noopener noreferrer">Noto Emoji</a> by Google,{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
          </div>
        </div>
      </div>

      {gifMenu && (
        <FloatingMenu x={gifMenu.x} y={gifMenu.y} className="emoji-context-menu" menuRef={menuRef}>
          <button type="button" onClick={editFromMenu}>Edit name and tags</button>
          <button type="button" className="danger" onClick={deleteFromMenu}>Remove GIF</button>
        </FloatingMenu>
      )}

      <input ref={gifUploadRef} type="file" accept="image/gif,image/png,image/jpeg,image/webp,image/avif" className="file-input" onChange={handleGifUpload} />
    </div>
  )
}
