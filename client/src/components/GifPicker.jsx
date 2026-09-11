import React, { useEffect, useMemo, useRef, useState } from 'react'
import longPressProps from '../longPress'
import FloatingMenu from './FloatingMenu'

// GIF picker shown above the composer (opened from the GIF button next to Emoji).
// Sections: 'tenor' (search the Tenor library via our server proxy) and 'custom' (the shared
// uploaded library). Tenor GIFs render in our own grid — no third-party SDK — so we control
// layout, the hover-name tooltip, and click handling.
export default function GifPicker({
  gifs = [],
  onSelectGif,
  onFetchTenor,
  onTenorStatus,
  onUploadGif,
  onDeleteGif,
  resolveSrc = (u) => u,
  onClose,
}) {
  const rootRef = useRef(null)
  // Portaled right-click menu node — exempt from the outside-click close (see FloatingMenu).
  const menuRef = useRef(null)
  const gifUploadRef = useRef(null)
  const tenorGridWrapRef = useRef(null)
  const [section, setSection] = useState('tenor')
  const [gifQuery, setGifQuery] = useState('')
  const [tenorQuery, setTenorQuery] = useState('')
  const [debouncedTenorQuery, setDebouncedTenorQuery] = useState('')
  const [tenorConfigured, setTenorConfigured] = useState(null) // null = unknown, true/false once checked
  const [tenorResults, setTenorResults] = useState([])
  const [tenorLoading, setTenorLoading] = useState(false)
  // Right-click context menu on a custom GIF: { id, x, y }.
  const [gifMenu, setGifMenu] = useState(null)
  // Name tooltip shown after dwelling on a Tenor GIF: { text, left, top } relative to the picker.
  const [gifTooltip, setGifTooltip] = useState(null)
  const tooltipTimerRef = useRef(null)
  // Tenor's opaque next-page cursor and the in-flight guard, kept in refs so the scroll
  // handler always sees fresh values without re-subscribing. reqId discards stale responses
  // when the query changes mid-flight.
  const tenorNextRef = useRef('')
  const tenorLoadingRef = useRef(false)
  const tenorReqIdRef = useRef(0)

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

  const filteredGifs = useMemo(() => {
    const q = gifQuery.trim().toLowerCase()
    if (!q) return gifs
    return gifs.filter((g) => (g.name || '').toLowerCase().includes(q))
  }, [gifs, gifQuery])

  // Debounce the Tenor search box so we fetch on a settled query, not each keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTenorQuery(tenorQuery.trim()), 400)
    return () => clearTimeout(handle)
  }, [tenorQuery])

  // Check whether Tenor is configured (has a server-side key) when the section is first opened.
  useEffect(() => {
    if (section !== 'tenor' || tenorConfigured !== null || !onTenorStatus) return
    let cancelled = false
    onTenorStatus().then((ok) => { if (!cancelled) setTenorConfigured(!!ok) })
    return () => { cancelled = true }
  }, [section, tenorConfigured, onTenorStatus])

  // Fetch one page. pos='' starts a fresh result set; a cursor appends the next page. reqId
  // ties the response to the query that asked for it, so a late reply can't clobber a newer one.
  const fetchTenorPage = async (query, pos, reqId) => {
    tenorLoadingRef.current = true
    setTenorLoading(true)
    let payload = { results: [], next: '' }
    try { payload = (await onFetchTenor?.(query, pos)) || payload } catch { /* keep empty */ }
    if (tenorReqIdRef.current !== reqId) { tenorLoadingRef.current = false; return }
    setTenorResults((prev) => (pos ? [...prev, ...payload.results] : payload.results))
    tenorNextRef.current = payload.next || ''
    tenorLoadingRef.current = false
    setTenorLoading(false)
  }

  // Load the first page whenever the section opens or the (debounced) query changes.
  useEffect(() => {
    if (section !== 'tenor' || tenorConfigured !== true) return
    const reqId = ++tenorReqIdRef.current
    tenorNextRef.current = ''
    setTenorResults([])
    fetchTenorPage(debouncedTenorQuery, '', reqId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tenorConfigured, debouncedTenorQuery])

  // Infinite scroll: pull the next page as the user nears the bottom of the picker's scroller.
  useEffect(() => {
    if (section !== 'tenor' || tenorConfigured !== true) return
    const scroller = rootRef.current?.querySelector('.emoji-picker-scroll')
    if (!scroller) return
    const onScroll = () => {
      if (tenorLoadingRef.current || !tenorNextRef.current) return
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 260) {
        fetchTenorPage(debouncedTenorQuery, tenorNextRef.current, tenorReqIdRef.current)
      }
    }
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tenorConfigured, debouncedTenorQuery])

  // After dwelling on a Tenor GIF for ~2s, show its name as a small styled tooltip — the only
  // hover affordance on the grid. Delegated listeners on the grid wrapper; the name is the
  // cell image's alt text.
  useEffect(() => {
    if (section !== 'tenor' || tenorConfigured !== true) return
    const wrap = tenorGridWrapRef.current
    const root = rootRef.current
    if (!wrap || !root) return
    const hide = () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
      setGifTooltip(null)
    }
    const sameCell = (e, cell) => e.relatedTarget instanceof Node && cell.contains(e.relatedTarget)
    const onOver = (e) => {
      const cell = e.target.closest('.gif-cell')
      if (!cell || sameCell(e, cell)) return
      hide()
      tooltipTimerRef.current = setTimeout(() => {
        const text = (cell.querySelector('img')?.alt || '').trim()
        if (!text) return
        const cr = cell.getBoundingClientRect()
        const rr = root.getBoundingClientRect()
        // Center under the cell, clamped so the tooltip (max-width 200) stays inside the picker;
        // flip above the cell when there's no room below.
        const left = Math.max(108, Math.min(cr.left - rr.left + cr.width / 2, rr.width - 108))
        const below = cr.bottom - rr.top + 6
        const top = below + 28 > rr.height ? cr.top - rr.top - 30 : below
        setGifTooltip({ text, left, top })
      }, 2000)
    }
    const onOut = (e) => {
      const cell = e.target.closest('.gif-cell')
      if (cell && !sameCell(e, cell)) hide()
    }
    const scroller = root.querySelector('.emoji-picker-scroll')
    wrap.addEventListener('mouseover', onOver)
    wrap.addEventListener('mouseout', onOut)
    wrap.addEventListener('mousedown', hide)
    scroller?.addEventListener('scroll', hide)
    return () => {
      wrap.removeEventListener('mouseover', onOver)
      wrap.removeEventListener('mouseout', onOut)
      wrap.removeEventListener('mousedown', hide)
      scroller?.removeEventListener('scroll', hide)
      hide()
    }
  }, [section, tenorConfigured])

  const handleGifUpload = (event) => {
    const file = event.target.files?.[0]
    if (file) onUploadGif?.(file, (file.name || 'gif').replace(/\.[^.]+$/, ''))
    if (event.target) event.target.value = ''
  }

  const openGifMenu = (e, id) => {
    e.preventDefault()
    setGifMenu({ id, x: e.clientX, y: e.clientY }) // viewport coords; FloatingMenu clamps on screen
  }
  const deleteFromMenu = () => {
    if (gifMenu) onDeleteGif?.(gifMenu.id)
    setGifMenu(null)
  }

  return (
    <div className="emoji-picker gif-picker" ref={rootRef} onClick={() => setGifMenu(null)}>
      <div className="emoji-picker-scroll">
        <div className="emoji-group">
          <div className="gif-sections">
            <button type="button" className={`gif-section-tab${section === 'tenor' ? ' active' : ''}`} onClick={() => setSection('tenor')}>Tenor</button>
            <button type="button" className={`gif-section-tab${section === 'custom' ? ' active' : ''}`} onClick={() => setSection('custom')}>Custom</button>
          </div>

          {section === 'tenor' && (
            <>
              <input
                className="gif-search"
                placeholder="Search Tenor"
                value={tenorQuery}
                onChange={(e) => setTenorQuery(e.target.value)}
              />
              {tenorConfigured === false ? (
                <div className="emoji-empty">Tenor isn't configured yet. Add a Tenor API key on the server to enable it.</div>
              ) : tenorConfigured === null ? (
                <div className="emoji-empty">Loading…</div>
              ) : (
                <div className="giphy-grid-wrap" ref={tenorGridWrapRef}>
                  {tenorResults.length === 0 && !tenorLoading ? (
                    <div className="emoji-empty">{debouncedTenorQuery ? 'No GIFs match your search.' : 'No GIFs to show.'}</div>
                  ) : (
                    <div className="gif-grid">
                      {tenorResults.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          className="gif-cell"
                          onClick={() => onSelectGif?.({ url: g.url, name: g.description || 'gif', type: 'image/gif' })}
                        >
                          <img src={g.preview} alt={g.description || 'GIF'} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                  {tenorLoading && <div className="emoji-empty">Loading…</div>}
                  <div className="giphy-attribution">Powered by Tenor</div>
                </div>
              )}
            </>
          )}

          {section === 'custom' && (
            <>
              <div className="gif-custom-head">
                <input
                  className="gif-search"
                  placeholder="Search your GIFs"
                  value={gifQuery}
                  onChange={(e) => setGifQuery(e.target.value)}
                />
                <button type="button" className="emoji-upload-btn" title="Add a GIF to the library" aria-label="Add a GIF" onClick={() => gifUploadRef.current?.click()}>+</button>
              </div>
              {filteredGifs.length === 0 ? (
                <div className="emoji-empty">{gifs.length === 0 ? 'No GIFs yet. Click + to add one to the shared library.' : 'No GIFs match your search.'}</div>
              ) : (
                <div className="gif-grid">
                  {filteredGifs.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="gif-cell"
                      title={`${g.name || 'GIF'} — right-click to remove`}
                      onClick={() => onSelectGif?.(g)}
                      onContextMenu={(e) => openGifMenu(e, g.id)}
                      {...longPressProps((e) => openGifMenu(e, g.id))}
                    >
                      <img src={resolveSrc(g.url)} alt={g.name || 'GIF'} loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {gifMenu && (
        <FloatingMenu x={gifMenu.x} y={gifMenu.y} className="emoji-context-menu" menuRef={menuRef}>
          <button type="button" className="danger" onClick={deleteFromMenu}>Remove GIF</button>
        </FloatingMenu>
      )}

      {gifTooltip && (
        <div className="gif-name-tooltip" style={{ left: gifTooltip.left, top: gifTooltip.top }} role="tooltip">{gifTooltip.text}</div>
      )}

      <input ref={gifUploadRef} type="file" accept="image/gif,image/*" className="file-input" onChange={handleGifUpload} />
    </div>
  )
}
