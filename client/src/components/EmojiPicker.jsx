import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Grid } from '@giphy/react-components'
import { EMOJI_GROUPS, SKIN_TONES, applySkinTone } from '../emojiData'

// Icon shown in the shortcut strip for each standard group (first representative emoji).
const GROUP_ICON = {
  'Smileys & People': '😀',
  'Gestures & Body': '✋',
  'People': '🧑',
  'Animals & Nature': '🐶',
  'Food & Drink': '🍔',
  'Activities & Objects': '⚽',
  'Symbols': '❤️',
}

// Emoji picker shown above the composer.
// Tabs: Emoji (standard set), Personal (your saved/uploaded), Server (per-server custom).
// Standard tone-capable emojis honor a per-emoji skin tone (right-click to change).
export default function EmojiPicker({
  personalEmojis = [],
  serverEmojiGroups = [],
  gifs = [],
  skinTones = {},
  onSelectEmoji,
  onSelectCustom,
  onSelectGif,
  onFetchGiphy,
  onGiphyStatus,
  onSetSkinTone,
  onUploadPersonal,
  onUploadServer,
  onUploadGif,
  onDeletePersonal,
  onDeleteServer,
  onDeleteGif,
  resolveSrc = (u) => u,
  onClose,
}) {
  const rootRef = useRef(null)
  const scrollRef = useRef(null)
  const uploadRef = useRef(null)
  const gifUploadRef = useRef(null)
  const sectionRefs = useRef({})
  // Upload target: { scope: 'personal' } or { scope: 'server', serverId }.
  const uploadTargetRef = useRef({ scope: 'personal' })
  const [tab, setTab] = useState('emoji') // 'emoji' | 'personal' | 'server' | 'gif'
  const [gifQuery, setGifQuery] = useState('')
  // GIF tab has two sections: 'giphy' (search the Giphy library) and 'custom' (uploaded library).
  const [gifSection, setGifSection] = useState('giphy')
  const [giphyQuery, setGiphyQuery] = useState('')
  const [debouncedGiphyQuery, setDebouncedGiphyQuery] = useState('')
  const [giphyConfigured, setGiphyConfigured] = useState(null) // null = unknown, true/false once checked
  const [gridWidth, setGridWidth] = useState(320)
  const giphyGridWrapRef = useRef(null)
  // Right-click skin-tone menu: { base, x, y } anchored to the clicked emoji.
  const [toneMenu, setToneMenu] = useState(null)
  // Right-click context menu on a custom emoji: { name, scope, serverId, x, y }.
  const [customMenu, setCustomMenu] = useState(null)
  // A file awaiting a name before upload: { file, target, name }.
  const [pendingUpload, setPendingUpload] = useState(null)
  const [pendingPreview, setPendingPreview] = useState(null)

  // Object URL for previewing the staged emoji image; revoked on change/unmount.
  useEffect(() => {
    if (!pendingUpload?.file) { setPendingPreview(null); return }
    const url = URL.createObjectURL(pendingUpload.file)
    setPendingPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingUpload?.file])

  // Close on outside click / Esc.
  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') { setToneMenu(null); onClose?.() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const tonedEmoji = (item) => {
    if (!item.tone) return item.e
    const toneKey = skinTones[item.e] || 'default'
    const tone = SKIN_TONES.find((t) => t.key === toneKey) || SKIN_TONES[0]
    return applySkinTone(item.e, tone.modifier)
  }

  const openToneMenu = (e, item) => {
    e.preventDefault()
    if (!item.tone) return
    const rect = rootRef.current.getBoundingClientRect()
    setToneMenu({ base: item.e, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const chooseTone = (toneKey) => {
    if (toneMenu) onSetSkinTone?.(toneMenu.base, toneKey)
    setToneMenu(null)
  }

  const triggerUpload = (target) => {
    uploadTargetRef.current = target
    uploadRef.current?.click()
  }
  // Default suggested name from the filename (lowercased, slugified).
  const suggestName = (filename) =>
    (filename || 'emoji').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'emoji'
  const handleUpload = (event) => {
    const file = event.target.files?.[0]
    if (file) {
      setPendingUpload({ file, target: uploadTargetRef.current, name: suggestName(file.name) })
    }
    if (event.target) event.target.value = ''
  }
  const confirmUpload = () => {
    if (!pendingUpload) return
    const name = suggestName(pendingUpload.name)
    const { file, target } = pendingUpload
    if (target.scope === 'server') onUploadServer?.(target.serverId, file, name)
    else onUploadPersonal?.(file, name)
    setPendingUpload(null)
  }

  const openCustomMenu = (e, name, scope, serverId) => {
    e.preventDefault()
    const rect = rootRef.current.getBoundingClientRect()
    setCustomMenu({ name, scope, serverId, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const openGifMenu = (e, id) => {
    e.preventDefault()
    const rect = rootRef.current.getBoundingClientRect()
    setCustomMenu({ scope: 'gif', id, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const deleteFromMenu = () => {
    if (!customMenu) return
    if (customMenu.scope === 'gif') onDeleteGif?.(customMenu.id)
    else if (customMenu.scope === 'server') onDeleteServer?.(customMenu.serverId, customMenu.name)
    else onDeletePersonal?.(customMenu.name)
    setCustomMenu(null)
  }

  // GIF tab helpers.
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
    if (tab !== 'gif' || gifSection !== 'giphy' || giphyConfigured !== null || !onGiphyStatus) return
    let cancelled = false
    onGiphyStatus().then((ok) => { if (!cancelled) setGiphyConfigured(!!ok) })
    return () => { cancelled = true }
  }, [tab, gifSection, giphyConfigured, onGiphyStatus])

  // Size the Giphy Grid to its container width.
  useEffect(() => {
    if (tab !== 'gif' || gifSection !== 'giphy' || giphyConfigured !== true) return
    const el = giphyGridWrapRef.current
    if (el && el.clientWidth) setGridWidth(el.clientWidth)
  }, [tab, gifSection, giphyConfigured])

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

  const scrollToSection = (id) => {
    const el = sectionRefs.current[id]
    const scroller = scrollRef.current
    if (el && scroller) scroller.scrollTop = el.offsetTop - scroller.offsetTop
  }

  // Shortcut strip entries depend on the active tab.
  const shortcuts = useMemo(() => {
    if (tab === 'emoji') return EMOJI_GROUPS.map((g) => ({ id: `g:${g.name}`, label: g.name, icon: GROUP_ICON[g.name] || '🙂' }))
    if (tab === 'server') return serverEmojiGroups.map((s) => ({ id: `s:${s.serverId}`, label: s.serverName, icon: s.serverName.slice(0, 1).toUpperCase() }))
    return []
  }, [tab, serverEmojiGroups])

  const setSectionRef = (id) => (el) => { if (el) sectionRefs.current[id] = el }

  const renderCustomGrid = (emojis, emptyText, scope, serverId) => (
    <div className="emoji-grid">
      {emojis.length === 0 && <div className="emoji-empty">{emptyText}</div>}
      {emojis.map((c) => (
        <button
          key={c.name}
          type="button"
          className="emoji-cell emoji-cell-custom"
          title={`:${c.name}: — right-click to delete`}
          onClick={() => onSelectCustom?.(c)}
          onContextMenu={(e) => openCustomMenu(e, c.name, scope, serverId)}
        >
          <img src={resolveSrc(c.url)} alt={`:${c.name}:`} />
        </button>
      ))}
    </div>
  )

  return (
    <div className="emoji-picker" ref={rootRef} onClick={() => { setToneMenu(null); setCustomMenu(null) }}>
      <div className="emoji-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'emoji'} className={`emoji-tab${tab === 'emoji' ? ' active' : ''}`} onClick={() => setTab('emoji')}>Emoji</button>
        <button type="button" role="tab" aria-selected={tab === 'personal'} className={`emoji-tab${tab === 'personal' ? ' active' : ''}`} onClick={() => setTab('personal')}>Personal</button>
        <button type="button" role="tab" aria-selected={tab === 'server'} className={`emoji-tab${tab === 'server' ? ' active' : ''}`} onClick={() => setTab('server')}>Server</button>
        <button type="button" role="tab" aria-selected={tab === 'gif'} className={`emoji-tab${tab === 'gif' ? ' active' : ''}`} onClick={() => setTab('gif')}>GIF</button>
      </div>

      {shortcuts.length > 0 && (
        <div className="emoji-shortcuts">
          {shortcuts.map((s) => (
            <button key={s.id} type="button" className="emoji-shortcut" title={s.label} onClick={() => scrollToSection(s.id)}>
              {s.icon}
            </button>
          ))}
        </div>
      )}

      <div className="emoji-picker-scroll" ref={scrollRef}>
        {tab === 'emoji' && EMOJI_GROUPS.map((group) => (
          <div className="emoji-group" key={group.name} ref={setSectionRef(`g:${group.name}`)}>
            <div className="emoji-group-header"><span>{group.name}</span></div>
            <div className="emoji-grid">
              {group.emojis.map((item) => (
                <button
                  key={item.e}
                  type="button"
                  className={`emoji-cell${item.tone ? ' emoji-cell-tone' : ''}`}
                  title={item.tone ? 'Right-click to change skin tone' : undefined}
                  onClick={() => onSelectEmoji?.(tonedEmoji(item))}
                  onContextMenu={(e) => openToneMenu(e, item)}
                >
                  {tonedEmoji(item)}
                </button>
              ))}
            </div>
          </div>
        ))}

        {tab === 'personal' && (
          <div className="emoji-group">
            <div className="emoji-group-header">
              <span>Personal</span>
              <button type="button" className="emoji-upload-btn" title="Upload a personal emoji" aria-label="Upload a personal emoji" onClick={() => triggerUpload({ scope: 'personal' })}>+</button>
            </div>
            {renderCustomGrid(personalEmojis, 'No personal emojis yet. Click + to add one.', 'personal')}
          </div>
        )}

        {tab === 'server' && (
          serverEmojiGroups.length === 0
            ? <div className="emoji-empty" style={{ padding: 16 }}>You aren't in any servers with emoji support.</div>
            : serverEmojiGroups.map((srv) => (
                <div className="emoji-group" key={srv.serverId} ref={setSectionRef(`s:${srv.serverId}`)}>
                  <div className="emoji-group-header">
                    <span>{srv.serverName}</span>
                    <button type="button" className="emoji-upload-btn" title={`Upload an emoji to ${srv.serverName}`} aria-label="Upload a server emoji" onClick={() => triggerUpload({ scope: 'server', serverId: srv.serverId })}>+</button>
                  </div>
                  {renderCustomGrid(srv.emojis, 'No server emojis yet. Click + to add one.', 'server', srv.serverId)}
                </div>
              ))
        )}

        {tab === 'gif' && (
          <div className="emoji-group">
            <div className="gif-sections">
              <button type="button" className={`gif-section-tab${gifSection === 'giphy' ? ' active' : ''}`} onClick={() => setGifSection('giphy')}>Giphy</button>
              <button type="button" className={`gif-section-tab${gifSection === 'custom' ? ' active' : ''}`} onClick={() => setGifSection('custom')}>Custom</button>
            </div>

            {gifSection === 'giphy' && (
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

            {gifSection === 'custom' && (
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
        )}
      </div>

      {toneMenu && (
        <div className="emoji-tone-menu" style={{ left: toneMenu.x, top: toneMenu.y }} role="menu">
          {SKIN_TONES.map((tone) => (
            <button key={tone.key} type="button" className="emoji-tone-option" onClick={() => chooseTone(tone.key)} title={tone.label}>
              {applySkinTone(toneMenu.base, tone.modifier)}
            </button>
          ))}
        </div>
      )}

      {customMenu && (
        <div className="emoji-context-menu" style={{ left: customMenu.x, top: customMenu.y }} role="menu">
          <button type="button" className="danger" onClick={deleteFromMenu}>{customMenu.scope === 'gif' ? 'Remove GIF' : 'Delete emoji'}</button>
        </div>
      )}

      {pendingUpload && (
        <div className="emoji-name-prompt" onClick={(e) => e.stopPropagation()}>
          <div className="emoji-name-prompt-inner">
            <img className="emoji-name-preview" src={pendingPreview} alt="New emoji" />
            <div className="emoji-name-fields">
              <label>Emoji name</label>
              <div className="emoji-name-input">
                <span>:</span>
                <input
                  autoFocus
                  value={pendingUpload.name}
                  onChange={(e) => setPendingUpload((p) => ({ ...p, name: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmUpload()
                    else if (e.key === 'Escape') setPendingUpload(null)
                  }}
                  placeholder="my_emoji"
                />
                <span>:</span>
              </div>
              <div className="emoji-name-actions">
                <button type="button" className="ghost" onClick={() => setPendingUpload(null)}>Cancel</button>
                <button type="button" className="primary" onClick={confirmUpload} disabled={!suggestName(pendingUpload.name)}>Add</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input ref={uploadRef} type="file" accept="image/*" className="file-input" onChange={handleUpload} />
      <input ref={gifUploadRef} type="file" accept="image/gif,image/*" className="file-input" onChange={handleGifUpload} />
    </div>
  )
}
