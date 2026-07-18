import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Grid } from '@giphy/react-components'

// GIF picker shown above the composer (opened from the GIF button next to Emoji).
// Sections: 'giphy' (search the Giphy library) and 'custom' (the shared uploaded library).
export default function GifPicker({
  gifs = [],
  onSelectGif,
  onFetchGiphy,
  onGiphyStatus,
  onUploadGif,
  onDeleteGif,
  resolveSrc = (u) => u,
  onClose,
}) {
  const rootRef = useRef(null)
  const gifUploadRef = useRef(null)
  const giphyGridWrapRef = useRef(null)
  const [section, setSection] = useState('giphy')
  const [gifQuery, setGifQuery] = useState('')
  const [giphyQuery, setGiphyQuery] = useState('')
  const [debouncedGiphyQuery, setDebouncedGiphyQuery] = useState('')
  const [giphyConfigured, setGiphyConfigured] = useState(null) // null = unknown, true/false once checked
  const [gridWidth, setGridWidth] = useState(320)
  // Right-click context menu on a custom GIF: { id, x, y }.
  const [gifMenu, setGifMenu] = useState(null)

  // Close on outside click / Esc.
  useEffect(() => {
    const onDown = (e) => {
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

  // Debounce the Giphy search box (drives the <Grid> remount + fetch).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedGiphyQuery(giphyQuery.trim()), 400)
    return () => clearTimeout(handle)
  }, [giphyQuery])

  // Check whether Giphy is configured (has a server-side key) when the section is first opened.
  useEffect(() => {
    if (section !== 'giphy' || giphyConfigured !== null || !onGiphyStatus) return
    let cancelled = false
    onGiphyStatus().then((ok) => { if (!cancelled) setGiphyConfigured(!!ok) })
    return () => { cancelled = true }
  }, [section, giphyConfigured, onGiphyStatus])

  // Size the Giphy Grid to its container width.
  useEffect(() => {
    if (section !== 'giphy' || giphyConfigured !== true) return
    const el = giphyGridWrapRef.current
    if (el && el.clientWidth) setGridWidth(el.clientWidth)
  }, [section, giphyConfigured])

  // Fetch through our server proxy (keeps the API key server-side). Memoized per query so
  // the Grid only refetches on a new search, not on unrelated re-renders.
  const fetchGiphyGifs = useCallback(
    (offset) => onFetchGiphy?.(debouncedGiphyQuery, offset),
    [onFetchGiphy, debouncedGiphyQuery]
  )
  const handleGifUpload = (event) => {
    const file = event.target.files?.[0]
    if (file) onUploadGif?.(file, (file.name || 'gif').replace(/\.[^.]+$/, ''))
    if (event.target) event.target.value = ''
  }

  const openGifMenu = (e, id) => {
    e.preventDefault()
    const rect = rootRef.current.getBoundingClientRect()
    setGifMenu({ id, x: e.clientX - rect.left, y: e.clientY - rect.top })
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
            <button type="button" className={`gif-section-tab${section === 'giphy' ? ' active' : ''}`} onClick={() => setSection('giphy')}>Giphy</button>
            <button type="button" className={`gif-section-tab${section === 'custom' ? ' active' : ''}`} onClick={() => setSection('custom')}>Custom</button>
          </div>

          {section === 'giphy' && (
            <>
              <input
                className="gif-search"
                placeholder="Search Giphy"
                value={giphyQuery}
                onChange={(e) => setGiphyQuery(e.target.value)}
              />
              {giphyConfigured === false ? (
                <div className="emoji-empty">Giphy isn't configured yet. Add a Giphy API key on the server to enable it.</div>
              ) : giphyConfigured === null ? (
                <div className="emoji-empty">Loading…</div>
              ) : (
                <div className="giphy-grid-wrap" ref={giphyGridWrapRef}>
                  <Grid
                    key={debouncedGiphyQuery}
                    width={gridWidth}
                    columns={3}
                    gutter={6}
                    fetchGifs={fetchGiphyGifs}
                    noLink
                    hideAttribution={false}
                    onGifClick={(gif, e) => {
                      e.preventDefault()
                      const url = gif.images?.original?.url || gif.images?.downsized_medium?.url || ''
                      onSelectGif?.({ url, name: gif.title || 'gif', type: 'image/gif' })
                    }}
                  />
                  <div className="giphy-attribution">Powered by GIPHY</div>
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
        <div className="emoji-context-menu" style={{ left: gifMenu.x, top: gifMenu.y }} role="menu">
          <button type="button" className="danger" onClick={deleteFromMenu}>Remove GIF</button>
        </div>
      )}

      <input ref={gifUploadRef} type="file" accept="image/gif,image/*" className="file-input" onChange={handleGifUpload} />
    </div>
  )
}
