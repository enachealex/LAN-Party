import React, { useEffect, useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Debounce utility
function useDebouncedEffect(effect, deps, delay) {
  useEffect(() => {
    const handler = setTimeout(() => effect(), delay)
    return () => clearTimeout(handler)
  }, [...(deps || []), delay])
}
import { io } from 'socket.io-client'
import AppLeftPane from './components/AppLeftPane'
import AddFriendModal from './components/AddFriendModal'
import NewChatModal from './components/NewChatModal'
import EmojiPicker from './components/EmojiPicker'
import Soundboard from './components/Soundboard'
import CollabCanvas from './components/CollabCanvas'
import ActivityPanel, { ACTIVITY_TYPES } from './components/Activities'
import { COLOR_SCHEMES, matchSchemeId } from './colorSchemes'
import ProfileAvatar from './components/ProfileAvatar'
import AppDirectoryModal from './components/AppDirectoryModal'
import { normalizeProfile, nameStyleToCss, AVATAR_OVERLAYS, BORDER_PRESETS, BORDER_STYLES, NAME_FONTS, NAME_STYLES } from './profileData'
import { WebcamEffectProcessor, effectsSupported } from './webcamEffects'

// API/socket origin. In dev, talk to the local server; in a production build, default to the
// same origin (the server serves the client), so it "just works" behind one domain. Override with
// VITE_SERVER_URL at build time to point at a separate API host.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '')
const VOICE_TILES_PER_PAGE = 8 // max participant tiles per gallery page before paging kicks in
const MAX_FILE_SIZE = 100 * 1024 * 1024
const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏']

// Screen-share quality presets: getDisplayMedia constraints + a sender bitrate cap.
const SCREEN_QUALITIES = [
  { id: '720p30', label: '720p · 30fps', width: 1280, height: 720, frameRate: 30, bitrate: 1500000 },
  { id: '1080p30', label: '1080p · 30fps', width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 },
  { id: '1080p60', label: '1080p · 60fps', width: 1920, height: 1080, frameRate: 60, bitrate: 4000000 },
  { id: 'source', label: 'Source · best', frameRate: 60, bitrate: 8000000 },
]

// Preset background "covers" for the webcam. Gradients are drawn programmatically (no assets,
// works offline, never taints the canvas); users can also upload a custom image.
const WEBCAM_BACKGROUNDS = [
  { id: 'bg-aurora', label: 'Aurora', colors: ['#5b247a', '#1bcedf'] },
  { id: 'bg-sunset', label: 'Sunset', colors: ['#ff512f', '#f09819'] },
  { id: 'bg-ocean', label: 'Ocean', colors: ['#2193b0', '#6dd5ed'] },
  { id: 'bg-forest', label: 'Forest', colors: ['#134e5e', '#71b280'] },
  { id: 'bg-berry', label: 'Berry', colors: ['#8e2de2', '#e94057'] },
  { id: 'bg-slate', label: 'Slate', colors: ['#232526', '#414345'] },
]

// Format raw stored reactions { emoji: [usernames] } for a viewer -> { emoji: { count, mine } }.
function formatReactions(raw, me) {
  const out = {}
  for (const [emoji, users] of Object.entries(raw || {})) {
    const list = Array.isArray(users) ? users : []
    if (list.length === 0) continue
    out[emoji] = { count: list.length, mine: me ? list.includes(me) : false }
  }
  return out
}
const VIEW_STATE_KEY = 'lanparty_view_state'

// Genre chips offered at signup (multi-select).
const GAME_GENRES = ['FPS / Shooter', 'MOBA', 'RPG', 'Strategy', 'Sports', 'Racing', 'Fighting', 'Party Games', 'Survival / Sandbox', 'Horror', 'MMO', 'Indie']

function formatFileSize(bytes = 0) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, index)
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function messageTimeValue(message) {
  return Number(message?.ts || message?.createdAt || message?.created_at || 0) || 0
}

function oldestMessagesFirst(messages = []) {
  return [...messages].sort((a, b) => messageTimeValue(a) - messageTimeValue(b))
}

function formatMessageTime(ts) {
  const value = Number(ts)
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  ).format(date)
}

function readSavedViewState() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || '{}')
  } catch {
    return {}
  }
}

function attachmentUrl(attachment) {
  if (!attachment?.url) return '#'
  return attachment.url.startsWith('http') ? attachment.url : `${SERVER_URL}${attachment.url}`
}

// Uploaded files are removed from the server 7 days after upload.
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Uploads are named `<timestamp>-<rand>-<name>`, so the upload time is embedded in the url.
// Returns null for anything that isn't a server upload (e.g. pasted external links never expire).
function attachmentUploadTs(attachment) {
  const match = /\/uploads\/(\d+)-/.exec(attachment?.url || '')
  return match ? Number(match[1]) : null
}
function isAttachmentExpired(attachment) {
  const ts = attachmentUploadTs(attachment)
  return ts != null && Date.now() - ts > FILE_TTL_MS
}

// Resolve an emoji image URL to absolute (relative /uploads/ urls need the server origin).
function emojiSrc(url) {
  if (!url) return ''
  return url.startsWith('http') || url.startsWith('blob:') || url.startsWith('data:') ? url : `${SERVER_URL}${url}`
}

// Media-type detection from mimetype, with a filename-extension fallback.
function attachmentExt(attachment) {
  const name = attachment?.name || attachment?.url || ''
  const match = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(name)
  return match ? match[1].toLowerCase() : ''
}
function isGifAttachment(attachment) {
  const type = (attachment?.type || '').toLowerCase()
  return type === 'image/gif' || attachmentExt(attachment) === 'gif'
}
function isImageAttachment(attachment) {
  const type = (attachment?.type || '').toLowerCase()
  if (type.startsWith('image/')) return true
  return ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff'].includes(attachmentExt(attachment))
}
function isVideoAttachment(attachment) {
  const type = (attachment?.type || '').toLowerCase()
  if (type.startsWith('video/')) return true
  return ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv'].includes(attachmentExt(attachment))
}
function isMediaAttachment(attachment) {
  return isImageAttachment(attachment) || isGifAttachment(attachment) || isVideoAttachment(attachment)
}
function mediaKind(attachment) {
  if (isVideoAttachment(attachment)) return 'video'
  if (isGifAttachment(attachment)) return 'gif'
  return 'image'
}

// If a message's text is a single bare http(s) URL pointing at media, turn it into a
// pseudo-attachment so it renders inline (and joins the lightbox). Returns null otherwise.
function mediaFromText(text) {
  const trimmed = (text || '').trim()
  if (!/^https?:\/\/\S+$/i.test(trimmed) || /\s/.test(trimmed)) return null
  let pathname = trimmed
  try {
    pathname = new URL(trimmed).pathname
  } catch {
    return null
  }
  const name = pathname.split('/').pop() || trimmed
  const probe = { url: trimmed, name }
  if (!isMediaAttachment(probe)) return null
  return probe
}

// Ordered list of every media item in a message array (attachments + media URLs) for lightbox cycling.
function collectMediaList(messages = []) {
  const list = []
  for (const m of messages) {
    const media = (m?.attachment && isMediaAttachment(m.attachment)) ? m.attachment : mediaFromText(m?.text)
    if (media && !isAttachmentExpired(media)) {
      list.push({ attachment: media, url: attachmentUrl(media), kind: mediaKind(media) })
    }
  }
  return list
}

// Fullscreen media viewer: expands to ~75% of the screen, cycles all media, closes on X / click-away / Esc.
function MediaLightbox({ items, index, onClose, onNavigate }) {
  const [entered, setEntered] = useState(false)
  const current = items?.[index]

  useEffect(() => {
    // Trigger the open animation on the next frame.
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') onNavigate(1)
      else if (e.key === 'ArrowLeft') onNavigate(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate])

  if (!current) return null
  const hasMultiple = items.length > 1

  return (
    <div className={`lightbox-overlay${entered ? ' open' : ''}`} onClick={onClose} role="dialog" aria-modal="true">
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close viewer">✕</button>
      {hasMultiple && (
        <button
          type="button"
          className="lightbox-arrow lightbox-arrow-left"
          onClick={(e) => { e.stopPropagation(); onNavigate(-1) }}
          aria-label="Previous media"
        >‹</button>
      )}
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {current.kind === 'video' ? (
          <video key={current.url} src={current.url} controls autoPlay className="lightbox-media" />
        ) : (
          <img key={current.url} src={current.url} alt={current.attachment?.name || 'Media'} className="lightbox-media" />
        )}
      </div>
      {hasMultiple && (
        <button
          type="button"
          className="lightbox-arrow lightbox-arrow-right"
          onClick={(e) => { e.stopPropagation(); onNavigate(1) }}
          aria-label="Next media"
        >›</button>
      )}
    </div>
  )
}

// Video miniplayer with a "Maximize" dropdown: theater (inline, grows in place),
// fill (full-app overlay) and native fullscreen.
function VideoPlayer({ attachment, onOpenMedia }) {
  const [maximize, setMaximize] = useState('normal') // 'normal' | 'theater' | 'fill'
  const [menuOpen, setMenuOpen] = useState(false)
  const videoRef = useRef(null)
  const url = attachmentUrl(attachment)

  const requestFullscreen = () => {
    setMenuOpen(false)
    const el = videoRef.current
    if (el?.requestFullscreen) el.requestFullscreen()
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen()
    else if (el?.webkitEnterFullscreen) el.webkitEnterFullscreen() // iOS Safari
  }
  const setMode = (mode) => {
    setMaximize((current) => (current === mode ? 'normal' : mode))
    setMenuOpen(false)
  }

  // Allow Esc to exit the fill overlay.
  useEffect(() => {
    if (maximize !== 'fill') return
    const onKey = (e) => { if (e.key === 'Escape') setMaximize('normal') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximize])

  const player = (
    <div className={`video-player video-player-${maximize}`} onClick={(e) => e.stopPropagation()}>
      <video ref={videoRef} src={url} controls preload="metadata" className="video-player-el" />
      <div className="video-player-controls">
        {onOpenMedia && (
          <button
            type="button"
            className="video-expand-btn"
            onClick={(e) => { e.stopPropagation(); onOpenMedia(attachment) }}
            aria-label="Open in viewer"
            title="Open in viewer"
          >⤢</button>
        )}
        <button
          type="button"
          className="video-maximize-btn"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="true"
          aria-expanded={menuOpen}
        >
          Maximize ▾
        </button>
        {menuOpen && (
          <div className="video-maximize-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => setMode('theater')}>
              {maximize === 'theater' ? '✓ ' : ''}Theater mode
            </button>
            <button type="button" role="menuitem" onClick={() => setMode('fill')}>
              {maximize === 'fill' ? '✓ ' : ''}Fill window
            </button>
            <button type="button" role="menuitem" onClick={requestFullscreen}>
              Fullscreen
            </button>
          </div>
        )}
      </div>
    </div>
  )

  if (maximize === 'fill') {
    return (
      <div className="video-fill-overlay" onClick={() => setMaximize('normal')}>
        <button type="button" className="video-fill-close" onClick={() => setMaximize('normal')} aria-label="Exit fill">✕</button>
        {player}
      </div>
    )
  }
  return player
}

function AttachmentCard({ attachment, onOpenMedia }) {
  if (!attachment) return null
  const url = attachmentUrl(attachment)

  // Files are deleted from the server 7 days after upload — show a note instead of a broken link.
  if (isAttachmentExpired(attachment)) {
    return (
      <div className="msg-attachment msg-attachment-expired" title="Uploaded files are removed 7 days after upload">
        <span className="msg-attachment-icon" aria-hidden="true">🗑️</span>
        <span className="msg-attachment-meta">
          <span className="msg-attachment-name">{attachment.name || 'Attachment'}</span>
          <span className="msg-attachment-size">File removed · uploads expire after 7 days</span>
        </span>
      </div>
    )
  }

  const openMedia = (event) => {
    if (!onOpenMedia) return
    event.preventDefault()
    event.stopPropagation()
    onOpenMedia(attachment)
  }

  if (isImageAttachment(attachment) || isGifAttachment(attachment)) {
    return (
      <a className="msg-attachment-image" href={url} target="_blank" rel="noreferrer" onClick={openMedia}>
        <img src={url} alt={attachment.name || (isGifAttachment(attachment) ? 'GIF' : 'Image')} loading="lazy" />
      </a>
    )
  }

  if (isVideoAttachment(attachment)) {
    return <VideoPlayer attachment={attachment} onOpenMedia={onOpenMedia} />
  }

  return (
    <a className="msg-attachment" href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
      <span className="msg-attachment-icon" aria-hidden="true">📎</span>
      <span className="msg-attachment-meta">
        <span className="msg-attachment-name">{attachment.name || 'Attachment'}</span>
        <span className="msg-attachment-size">{formatFileSize(attachment.size)}</span>
      </span>
    </a>
  )
}

// Matches runs of unicode emoji (incl. ZWJ sequences, modifiers, variation selectors).
const UNICODE_EMOJI_RE = /(\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}️⃣])*)+/gu

// Wrap unicode emoji runs in a sized span so they match custom-emoji size in chat.
function enlargeUnicodeEmoji(text, keyPrefix) {
  const out = []
  let last = 0
  let m
  let i = 0
  UNICODE_EMOJI_RE.lastIndex = 0
  while ((m = UNICODE_EMOJI_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<span key={`${keyPrefix}u${i++}`} className="msg-emoji">{m[0]}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length ? out : text
}

// Render message text, replacing :shortcode: tokens with custom emoji images and
// enlarging plain unicode emoji to match.
// `emojiMap` maps name -> url. `onSaveEmoji` lets the user right-click an emoji to save it.
function renderMessageText(text, emojiMap, onSaveEmoji) {
  if (!text) return null
  const parts = []
  const regex = /:([a-z0-9_]+):/gi
  let last = 0
  let match
  let key = 0
  const pushText = (chunk) => { if (chunk) parts.push(...[].concat(enlargeUnicodeEmoji(chunk, `t${key++}`))) }
  const hasCustom = emojiMap && Object.keys(emojiMap).length > 0
  while (hasCustom && (match = regex.exec(text)) !== null) {
    const url = emojiMap[match[1]]
    if (!url) continue
    if (match.index > last) pushText(text.slice(last, match.index))
    parts.push(
      <img
        key={`e${key++}`}
        className="msg-custom-emoji"
        src={emojiSrc(url)}
        alt={`:${match[1]}:`}
        title={`:${match[1]}:`}
        onContextMenu={(e) => { e.preventDefault(); onSaveEmoji?.({ name: match[1], url }) }}
      />
    )
    last = match.index + match[0].length
  }
  if (last < text.length) pushText(text.slice(last))
  return parts.length ? parts : text
}

function ChatMessage({ message, currentUser, onReact, activeReactionMessageId, setActiveReactionMessageId, onOpenMedia, emojiMap, onSaveEmoji, onEdit, onDelete, onCollab }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState(null) // { left, top } for the portal menu
  const [showTimestamp, setShowTimestamp] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const closeToolbarTimer = useRef(null)
  const moreBtnRef = useRef(null)
  const isOutgoing = message.author === currentUser
  const isToolbarActive = String(activeReactionMessageId) === String(message.id)
  const reactions = message.reactions || {}
  // A bare image/gif/video URL pasted as the message body is rendered inline as media.
  const textMedia = message.attachment ? null : mediaFromText(message.text)
  // True when the bubble's main content is media (no body text) so it can shrink-wrap tightly.
  // Reactions are allowed — they render below the media without widening the bubble.
  const hasMediaContent = Boolean(message.attachment) || Boolean(textMedia)
  const isMediaOnly = hasMediaContent && !(message.text && !textMedia)
  const timestamp = formatMessageTime(message.ts || message.createdAt || message.created_at)
  const toggleTimestamp = () => setShowTimestamp((visible) => !visible)
  const copyMessage = async () => {
    const copyText = message.text || (message.attachment ? attachmentUrl(message.attachment) : '')
    if (!copyText) return
    try {
      await navigator.clipboard.writeText(copyText)
    } catch (err) {
      console.warn('copy message failed', err)
    }
    setMenuOpen(false)
  }

  // Only your own text messages (no attachment) can be edited; you can delete any of your own.
  const canEdit = Boolean(onEdit) && isOutgoing && Boolean(message.text) && !message.attachment
  const canDelete = Boolean(onDelete) && isOutgoing
  const handleDelete = () => { onDelete?.(message.id); setMenuOpen(false) }
  // A static image in this message can be opened for collaborative editing.
  const collabImage = (message.attachment && isImageAttachment(message.attachment) && !isGifAttachment(message.attachment)) ? message.attachment
    : (textMedia && isImageAttachment(textMedia) && !isGifAttachment(textMedia)) ? textMedia : null
  const handleCollab = () => { if (collabImage) onCollab?.(attachmentUrl(collabImage)); setMenuOpen(false) }
  const startEdit = () => {
    setEditText(message.text || '')
    setEditing(true)
    setMenuOpen(false)
  }
  const cancelEdit = () => setEditing(false)
  const saveEdit = () => {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== message.text) onEdit?.(message.id, trimmed)
    setEditing(false)
  }

  useEffect(() => () => {
    if (closeToolbarTimer.current) clearTimeout(closeToolbarTimer.current)
  }, [])

  const showToolbar = () => {
    if (closeToolbarTimer.current) clearTimeout(closeToolbarTimer.current)
    setActiveReactionMessageId?.(message.id)
  }

  const hideToolbarSoon = () => {
    if (closeToolbarTimer.current) clearTimeout(closeToolbarTimer.current)
    closeToolbarTimer.current = setTimeout(() => {
      setActiveReactionMessageId?.((current) => (String(current) === String(message.id) ? null : current))
      setMenuOpen(false)
    }, 150)
  }

  // Open the action menu as a fixed-position portal anchored to the "..." button,
  // flipping up/left when near the viewport edges so it never gets clipped.
  const MENU_W = 170
  const MENU_H = 124
  const toggleMenu = () => {
    if (menuOpen) { setMenuOpen(false); return }
    const btn = moreBtnRef.current
    if (!btn) { setMenuOpen(true); return }
    const r = btn.getBoundingClientRect()
    const margin = 8
    let left = isOutgoing ? r.right - MENU_W : r.left
    left = Math.max(margin, Math.min(left, window.innerWidth - MENU_W - margin))
    const top = (r.bottom + MENU_H + margin > window.innerHeight)
      ? r.top - MENU_H - 4   // flip above when not enough room below
      : r.bottom + 4
    setMenuPos({ left, top: Math.max(margin, top) })
    setMenuOpen(true)
  }

  // Right-click anywhere on the message (incl. an image) opens the action menu at the cursor.
  const openContextMenu = (event) => {
    event.preventDefault()
    const margin = 8
    const left = Math.max(margin, Math.min(event.clientX, window.innerWidth - MENU_W - margin))
    const top = Math.max(margin, Math.min(event.clientY, window.innerHeight - MENU_H - margin))
    setMenuPos({ left, top })
    setMenuOpen(true)
    showToolbar()
  }

  return (
    <div className={`msg-row ${isOutgoing ? 'outgoing' : 'incoming'}`}>
      <div
        className={`msg-stack ${isToolbarActive ? 'toolbar-open' : ''}`}
        onMouseEnter={showToolbar}
        onMouseLeave={hideToolbarSoon}
        onFocus={showToolbar}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) hideToolbarSoon()
        }}
      >
        <div className="msg-teams-toolbar" role="toolbar" aria-label="Message reactions" onMouseEnter={showToolbar}>
          {MESSAGE_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="msg-reaction-btn" onClick={() => onReact?.(message.id, emoji)} aria-label={`React with ${emoji}`}>
              {emoji}
            </button>
          ))}
          <button
            ref={moreBtnRef}
            type="button"
            className="msg-more-btn"
            onClick={() => { showToolbar(); toggleMenu() }}
            aria-label="More message actions"
          >
            ...
          </button>
        </div>
        {menuOpen && menuPos && createPortal(
          <div
            className="msg-action-menu"
            role="menu"
            style={{ left: menuPos.left, top: menuPos.top }}
            onMouseEnter={showToolbar}
            onMouseLeave={hideToolbarSoon}
          >
            {canEdit && <button type="button" role="menuitem" onClick={startEdit}>Edit</button>}
            {collabImage && onCollab && <button type="button" role="menuitem" onClick={handleCollab}>Edit together</button>}
            <button type="button" role="menuitem">Forward</button>
            <button type="button" role="menuitem" onClick={copyMessage}>Copy</button>
            <button type="button" role="menuitem">Pin</button>
            {canDelete && <button type="button" role="menuitem" className="danger" onClick={handleDelete}>Delete</button>}
          </div>,
          document.body
        )}
        <div
          role="button"
          tabIndex={0}
          className={`msg-bubble${isMediaOnly ? ' msg-bubble-media' : ''}`}
          onClick={toggleTimestamp}
          onContextMenu={openContextMenu}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleTimestamp()
            }
          }}
          aria-pressed={showTimestamp}
        >
          {!isOutgoing && <div className="msg-author">{message.author}</div>}
          {editing ? (
            <div className="msg-edit" onClick={(e) => e.stopPropagation()}>
              <textarea
                className="msg-edit-input"
                value={editText}
                autoFocus
                rows={1}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                }}
              />
              <div className="msg-edit-hint">escape to <button type="button" onClick={cancelEdit}>cancel</button> · enter to <button type="button" onClick={saveEdit}>save</button></div>
            </div>
          ) : (
            message.text && !textMedia && (
              <div className="msg-text">
                {renderMessageText(message.text, emojiMap, onSaveEmoji)}
                {message.edited && <span className="msg-edited"> (edited)</span>}
              </div>
            )
          )}
          {textMedia && <AttachmentCard attachment={textMedia} onOpenMedia={onOpenMedia} />}
          <AttachmentCard attachment={message.attachment} onOpenMedia={onOpenMedia} />
          {Object.keys(reactions).length > 0 && (
            <div className="msg-reactions" aria-label="Message reactions">
              {Object.entries(reactions).map(([emoji, data]) => (
                <button key={emoji} type="button" className={`msg-reaction-count ${data.mine ? 'mine' : ''}`} onClick={(event) => { event.stopPropagation(); onReact?.(message.id, emoji) }}>
                  <span>{emoji}</span>
                  <span>{data.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {showTimestamp && timestamp && <div className="msg-time">{timestamp}</div>}
      </div>
    </div>
  )
}

function RemoteAudio({ stream }) {
  const ref = useRef()
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream
  }, [stream])
  return <audio ref={ref} autoPlay playsInline />
}

// A single participant tile: shows their camera video when a live video track is present,
// otherwise an avatar initial. The <video> element also plays the stream's audio.
function VideoTile({ stream, label, muted, isScreen, onExpand, sinkId }) {
  const ref = useRef()
  const [hasVideo, setHasVideo] = useState(false)
  // React doesn't reliably update the <video> `muted` DOM property on re-render, so set it imperatively.
  useEffect(() => { if (ref.current) ref.current.muted = !!muted }, [muted])
  // Route this tile's audio to the user's chosen output device (speaker selection).
  useEffect(() => {
    if (sinkId && ref.current && typeof ref.current.setSinkId === 'function') ref.current.setSinkId(sinkId).catch(() => {})
  }, [sinkId, stream])
  useEffect(() => {
    if (ref.current) { ref.current.srcObject = stream || null; if (stream) ref.current.play().catch(() => {}) }
    if (!stream) { setHasVideo(false); return }
    const update = () => setHasVideo(stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted))
    // A video track added later (e.g. a peer turns their camera on after connecting) arrives via
    // 'addtrack' and is often initially muted until RTP flows — so we must (re)attach the mute/unmute
    // listeners to whatever tracks currently exist, not just the ones present on first render.
    const attach = () => stream.getVideoTracks().forEach((t) => { t.onmute = update; t.onunmute = update; t.onended = update })
    const onTrackChange = () => { attach(); update() }
    attach()
    update()
    stream.addEventListener('addtrack', onTrackChange)
    stream.addEventListener('removetrack', onTrackChange)
    return () => {
      stream.removeEventListener('addtrack', onTrackChange)
      stream.removeEventListener('removetrack', onTrackChange)
    }
  }, [stream])
  return (
    <div className={`video-tile${hasVideo ? ' has-video' : ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {!hasVideo && <div className="video-tile-avatar">{(label || '?').trim().slice(0, 1).toUpperCase()}</div>}
      <div className="video-tile-label">{label}</div>
      {isScreen && hasVideo && onExpand && (
        <button type="button" className="video-tile-expand" title="View full screen" aria-label="View full screen" onClick={(e) => { e.stopPropagation(); onExpand(stream, label) }}>⛶</button>
      )}
    </div>
  )
}

// Self-preview shown in the "turn on camera" popup (mirrored, like a selfie). Falls back to a
// placeholder while the camera is being acquired or if permission is denied.
function PreviewVideo({ stream }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream || null
    if (stream) el.play().catch(() => {}) // autoPlay isn't always honored for srcObject
  }, [stream])
  return (
    <div className="voice-preview">
      {stream ? <video ref={ref} autoPlay playsInline muted className="voice-preview-video" /> : <div className="voice-preview-empty">Starting camera…</div>}
    </div>
  )
}

// Full-screen viewer for a shared screen (its own <video> bound to the same MediaStream).
function FullscreenVideo({ stream }) {
  const ref = useRef()
  useEffect(() => { if (ref.current) ref.current.srcObject = stream || null }, [stream])
  return <video ref={ref} autoPlay playsInline className="screen-fullscreen-video" />
}

function PaperclipIcon() {
  return <span style={{fontSize:22,lineHeight:1}}>📎</span>
}

function SendIcon() {
  return <span style={{transform:'rotate(45deg)'}}>➤</span>
}

// Generic control-bar glyphs (24x24) for the voice call bar.
const svgProps = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
function CamOnIcon() { return (<svg {...svgProps}><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>) }
function CamOffIcon() { return (<svg {...svgProps}><path d="M16 16v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2m4 0h5a2 2 0 0 1 2 2v3l4-3v9" /><line x1="1" y1="1" x2="23" y2="23" /></svg>) }
function ScreenShareIcon() { return (<svg {...svgProps}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>) }
function MicOnIcon() { return (<svg {...svgProps}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></svg>) }
function MicOffIcon() { return (<svg {...svgProps}><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5 2M15 9.34V5a3 3 0 0 0-5.94-.6" /><path d="M17 12a5 5 0 0 1-.54 2.27M5 10a7 7 0 0 0 11 5.66M12 19v3" /></svg>) }
function SoundboardIcon() { return (<svg {...svgProps}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></svg>) }
// Activities launcher glyph (party popper).
function ActivitiesIcon() { return (<span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden="true">🎉</span>) }
// Sparkles/wand for the webcam-effects (background blur & covers) menu.
function EffectsIcon() { return (<svg {...svgProps}><path d="M12 3l1.6 4.2L18 8.8l-4.4 1.6L12 15l-1.6-4.6L6 8.8l4.4-1.6L12 3z" /><path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 20l-.7-2.3L16.4 17l1.9-1.1L19 14z" /></svg>) }
// White phone handset (like 📞) for the Leave button.
function HangupIcon() { return (<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.24 1.02l-2.2 2.2z" /></svg>) }

export default function App() {
  const [socket, setSocket] = useState(null)
  const [name, setName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [connected, setConnected] = useState(false)
  const [serverState, setServerState] = useState(null)
  const [activeChannel, setActiveChannel] = useState('general')
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [localStream, setLocalStream] = useState(null)
  const peersRef = useRef({})
  const [remoteStreams, setRemoteStreams] = useState({})
  const [inVoice, setInVoice] = useState(false)
  const [videoOn, setVideoOn] = useState(false) // is the local camera on
  const [screenSharing, setScreenSharing] = useState(false) // is the local screen being shared
  const [screenQuality, setScreenQuality] = useState('1080p30') // selected screen-share quality
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  const [voiceChannelId, setVoiceChannelId] = useState(null) // which voice channel we're connected to
  const [peerNames, setPeerNames] = useState({}) // socketId -> display name for voice tiles
  const [screenSharingPeers, setScreenSharingPeers] = useState({}) // socketId -> is screen sharing
  const [fullscreenStream, setFullscreenStream] = useState(null) // { stream, label } when viewing a screen full-screen
  // Webcam effects (background blur / cover). effectId: 'none'|'blur'|'strongblur'|'custom'|<bg preset id>.
  const [webcamEffect, setWebcamEffect] = useState('none')
  const [customBgUrl, setCustomBgUrl] = useState(null) // object URL for an uploaded background cover
  const [bgCoverId, setBgCoverId] = useState('bg-slate') // which background cover "Hide me" fills with
  const [showEffectsMenu, setShowEffectsMenu] = useState(false)
  const [effectsError, setEffectsError] = useState(null) // set when effects can't load (e.g. offline)
  const effectsRef = useRef(null)      // WebcamEffectProcessor instance
  const rawCamStreamRef = useRef(null) // unprocessed getUserMedia camera stream (kept alive for effects)
  // Camera device picker + live self-preview shown in the "turn on camera" popup.
  const [videoDevices, setVideoDevices] = useState([]) // [{ deviceId, label }]
  const [selectedCameraId, setSelectedCameraId] = useState(null)
  const [previewStream, setPreviewStream] = useState(null)
  const outputTrackRef = useRef(null) // the current camera output track (raw clone or processed), shared by preview + live
  // Collaborative image editing: active session { sessionId, imageUrl } + a pending invite from a peer.
  const [collab, setCollab] = useState(null)
  const [collabInvite, setCollabInvite] = useState(null)
  const collabCanvasRef = useRef(null)
  const [voiceRailTarget, setVoiceRailTarget] = useState(null) // 'home' | server id when in voice
  // Refs mirror socket + local stream so WebRTC callbacks never read stale closure state.
  const socketRef = useRef(null)
  const localStreamRef = useRef(null)
  // ICE servers for WebRTC (STUN + optional TURN), fetched from the server so TURN works across
  // networks in production. Defaults to public STUN until the fetch resolves.
  const iceConfigRef = useRef([{ urls: 'stun:stun.l.google.com:19302' }])
  const [showMembersPanel, setShowMembersPanel] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showInstallPanel, setShowInstallPanel] = useState(false)
  // Public app directory modal.
  const [showAppDirectory, setShowAppDirectory] = useState(false)
  const [publicApps, setPublicApps] = useState([])
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [settingsTab, setSettingsTab] = useState('profile') // 'profile' | 'appearance' | 'messages'
  // Whether the profile customization controls (picture/border/overlay/name style) are expanded.
  const [showProfileEditor, setShowProfileEditor] = useState(false)
  // Direction new messages flow: 'bottom' (anchor to bottom, default) or 'top' (fill from top down).
  const [messageFlow, setMessageFlow] = useState('bottom')
  // The user's customizable profile (avatar, decorations, bio, tags, name styling).
  const [profile, setProfile] = useState(() => normalizeProfile())
  // Draft profile being edited in the settings modal (committed on Save).
  const [editingProfile, setEditingProfile] = useState(null)
  const [customTagInput, setCustomTagInput] = useState('')
  const profileAvatarInputRef = useRef(null)
  const [userSettings, setUserSettings] = useState(null)
  const [editingSettings, setEditingSettings] = useState(null)
  const [token, setToken] = useState(null)
  // Authentication state
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  // Whether the initial session-restore check has completed. If a token exists we hold the
  // login modal back until /auth/me resolves, so it doesn't flash on refresh for signed-in users.
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem('lanparty_token'))
  const [authMode, setAuthMode] = useState('login') // 'login' | 'register'
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [regUsername, setRegUsername] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [forgotOpen, setForgotOpen] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotMessage, setForgotMessage] = useState(null)
  const [rememberMe, setRememberMe] = useState(false)
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false)
  const [userStatus, setUserStatus] = useState('available')
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  // Audio device selection (mic input + speaker output). Enumerated only after the user is in a call.
  const [audioInputs, setAudioInputs] = useState([])
  const [audioOutputs, setAudioOutputs] = useState([])
  const [selectedMicId, setSelectedMicId] = useState(null)
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(null)
  const [showAudioMenu, setShowAudioMenu] = useState(false)
  // Watch/Discover: who is currently streaming (camera/screen) across the app.
  const [discoverStreams, setDiscoverStreams] = useState([])
  const [showDiscover, setShowDiscover] = useState(false)
  // External streaming (Twitch/YouTube/Kik): my announcement + the announce form + in-app viewer.
  const [myExternalStream, setMyExternalStream] = useState(null) // { platform, channel, title, game }
  const [showAnnounceForm, setShowAnnounceForm] = useState(false)
  const [announceForm, setAnnounceForm] = useState({ platform: 'twitch', channel: '', title: '', game: '' })
  const [externalViewer, setExternalViewer] = useState(null) // stream entry being watched in-app
  // Activities: the shared activity for the current voice room (null when none), + the launcher.
  const [activity, setActivity] = useState(null)
  const [showActivityMenu, setShowActivityMenu] = useState(false)
  // Wraps for the call-bar popovers, so an outside click can close whichever is open.
  const audioMenuRef = useRef(null)
  const effectsMenuRef = useRef(null)
  const qualityMenuRef = useRef(null)
  const activityMenuRef = useRef(null)
  // Responsive voice grid: columns/rows computed to fit ALL tiles in view (shrink as people join).
  const videoStageRef = useRef(null)
  const [voiceGrid, setVoiceGrid] = useState({ cols: 1, rows: 1 })
  const [voicePage, setVoicePage] = useState(0) // gallery page when there are more than VOICE_TILES_PER_PAGE tiles
  // Teams-style pre-join screen: configure camera/effect/mic/speaker before entering the call.
  const [showPreJoin, setShowPreJoin] = useState(false)
  const [preJoinChannelId, setPreJoinChannelId] = useState('voice1')
  const [preJoinCamOn, setPreJoinCamOn] = useState(false)
  const [preJoinMuted, setPreJoinMuted] = useState(false)
  const preJoinMicStreamRef = useRef(null) // mic acquired during pre-join (transferred to the call on join)
  const micMeterRef = useRef(null)     // the meter mask element (updated directly to avoid re-renders)
  const micAnalyserRef = useRef(null)  // { ctx, src, rafId, stopped } for the live mic level meter
  const [regUsernameError, setRegUsernameError] = useState(null)
  const [regUsernameAvailable, setRegUsernameAvailable] = useState(null)
  const [regUsernameChecking, setRegUsernameChecking] = useState(false)
  const [regEmailAvailable, setRegEmailAvailable] = useState(null)
  const [regEmailChecking, setRegEmailChecking] = useState(false)
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [showRegPassword, setShowRegPassword] = useState(false)
  const [showRegPasswordConfirm, setShowRegPasswordConfirm] = useState(false)
  const [regEmailError, setRegEmailError] = useState(null)
  // Gaming profile asked at signup: favorite genres + games played in the past 2 weeks.
  const [regGenres, setRegGenres] = useState([])
  const [regCurrentGames, setRegCurrentGames] = useState('')
  const [leftNav, setLeftNav] = useState('friends')
  const [selectedServerId, setSelectedServerId] = useState('home')
  // Real servers from the DB (the rail renders these — no more mock tiles).
  const [serversList, setServersList] = useState([])
  // Mirrors activeChannel so socket callbacks (bound once) never read stale closures.
  // (selectedServerIdRef already exists below and is kept in sync the same way.)
  const activeChannelRef = useRef('general')
  // The server a voice call belongs to — captured at join time so browsing other servers mid-call
  // doesn't re-target voice/soundboard/activity emits.
  const voiceServerIdRef = useRef('demo')
  const preJoinServerIdRef = useRef('demo')
  const [friends, setFriends] = useState([])
  const [pendingFriendRequests, setPendingFriendRequests] = useState([])
  const [pendingFriendCount, setPendingFriendCount] = useState(0)
  const [outgoingFriendRequests, setOutgoingFriendRequests] = useState([])
  const [showAddFriendModal, setShowAddFriendModal] = useState(false)
  const [addFriendUsername, setAddFriendUsername] = useState('')
  const [addFriendError, setAddFriendError] = useState(null)
  const [addFriendLoading, setAddFriendLoading] = useState(false)
  const [addFriendUserExists, setAddFriendUserExists] = useState(null)
  const [addFriendIsSelf, setAddFriendIsSelf] = useState(false)
  const [addFriendUserChecking, setAddFriendUserChecking] = useState(false)
  const [selectedFriendId, setSelectedFriendId] = useState(null)
  const [selectedDmId, setSelectedDmId] = useState(null)
  const [selectedGroupId, setSelectedGroupId] = useState(null)
  const [homeChat, setHomeChat] = useState(null) // { type, id, name, peerUsername? }
  const [homeMessages, setHomeMessages] = useState({})
  const [dmConversations, setDmConversations] = useState([])
  const [groupChats, setGroupChats] = useState([])
  const [totalUnreadMessages, setTotalUnreadMessages] = useState(0)
  const [unreadByChatId, setUnreadByChatId] = useState({})
  const [groupUnread, setGroupUnread] = useState({})
  // Emoji picker: open state, the user's custom emojis, and per-emoji skin-tone choices.
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [customEmojis, setCustomEmojis] = useState([]) // personal: [{ name, url }]
  const [emojiSkinTones, setEmojiSkinTones] = useState({}) // { '👍': 'dark', ... }
  const [serverEmojis, setServerEmojis] = useState({}) // { [serverId]: [{ name, url }] }
  // Shared GIF library (surfaced as a tab inside the emoji board): list of [{ id, name, url, type }].
  const [gifLibrary, setGifLibrary] = useState([])
  // Soundboard: open state, shared clip library, playback volume, and currently-playing pad ids.
  const [showSoundboard, setShowSoundboard] = useState(false)
  const [soundLibrary, setSoundLibrary] = useState([])
  const [soundVolume, setSoundVolume] = useState(0.8)
  const [playingSoundIds, setPlayingSoundIds] = useState([])
  const soundVolumeRef = useRef(0.8)
  // The single currently-playing clip: { audio, id }. Only one sound plays at a time.
  const currentSoundRef = useRef(null)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [newChatSelectedIds, setNewChatSelectedIds] = useState([])
  const [newChatGroupName, setNewChatGroupName] = useState('')
  const [pendingFile, setPendingFile] = useState(null)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState(null)
  const [lightbox, setLightbox] = useState(null) // { items: [...], index }
  const [uploadError, setUploadError] = useState(null)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [activeReactionMessageId, setActiveReactionMessageId] = useState(null)
  const fileInputRef = useRef(null)
  const homeChatRef = useRef(null)
  const selectedServerIdRef = useRef('home')
  const chatHistoryLoadSeqRef = useRef({})
  const restoredViewRef = useRef(false)
  const viewPersistenceReadyRef = useRef(false)
  const messagesListRef = useRef(null)
  // Number of unread messages captured when a chat is opened, so we can land the
  // scroll on the first unread message instead of the bottom. Cleared once applied.
  const pendingUnreadScrollRef = useRef(0)
  // Tracks which chat the scroll position has already been initialized for.
  const scrollInitKeyRef = useRef(null)

  // Keep an object URL for previewing the pending file in the composer; revoke on change/unmount.
  useEffect(() => {
    if (!pendingFile || !(pendingFile instanceof File)) {
      setPendingPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingFile)
    setPendingPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingFile])

  const chatStorageKey = (id) => String(id)
  const activeHomeMessageCount = homeChat ? homeMessages[chatStorageKey(homeChat.id)]?.length || 0 : 0

  useEffect(() => {
    homeChatRef.current = homeChat
  }, [homeChat])

  // Identity of the currently-open chat (channel or home chat).
  const activeChatKey = homeChat ? `home:${homeChat.id}` : `channel:${selectedServerId}:${activeChannel}`
  const activeMessageCount = homeChat ? activeHomeMessageCount : messages.length

  useEffect(() => {
    const list = messagesListRef.current
    if (!list || activeMessageCount === 0) return
    const isNewChat = scrollInitKeyRef.current !== activeChatKey

    if (isNewChat) {
      // First render for this chat: land on the first unread message, or the bottom.
      scrollInitKeyRef.current = activeChatKey
      const unread = pendingUnreadScrollRef.current
      pendingUnreadScrollRef.current = 0
      if (unread > 0 && unread < activeMessageCount) {
        // Position the first unread message at the top of the viewport.
        const firstUnreadIndex = activeMessageCount - unread
        const target = list.children[firstUnreadIndex]
        if (target) {
          list.scrollTop = Math.max(0, target.offsetTop - list.offsetTop)
          return
        }
      }
      list.scrollTop = list.scrollHeight
      return
    }

    // Same chat, a message arrived: keep pinned to the bottom only if already near it.
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    if (distanceFromBottom < 120) list.scrollTop = list.scrollHeight
  }, [activeChatKey, activeMessageCount])

  useEffect(() => {
    setActiveReactionMessageId(null)
  }, [selectedServerId, activeChannel, homeChat?.id])

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId
  }, [selectedServerId])

  useEffect(() => {
    if (!isAuthenticated || !viewPersistenceReadyRef.current) return
    const viewState = {
      username: name,
      leftNav,
      selectedServerId,
      activeChannel,
      selectedFriendId,
      selectedDmId,
      selectedGroupId,
      homeChat: homeChat
        ? {
            type: homeChat.type,
            id: homeChat.id,
            name: homeChat.name,
            peerUsername: homeChat.peerUsername,
          }
        : null,
    }
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(viewState))
  }, [isAuthenticated, name, leftNav, selectedServerId, activeChannel, selectedFriendId, selectedDmId, selectedGroupId, homeChat])
  // Advisory availability check: only trust an explicit true/false from the server.
  // Anything else (error, offline, unexpected shape) leaves state as "unknown" (null) and
  // never blocks registration — the server re-validates uniqueness on submit.
  const runAvailabilityCheck = async (payload) => {
    try {
      const res = await fetch(`${SERVER_URL}/auth/check-availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return {};
      return await res.json();
    } catch {
      return {};
    }
  };

  // Debounced username availability check
  useDebouncedEffect(() => {
    if (!regUsername.trim()) {
      setRegUsernameAvailable(null);
      setRegUsernameError(null);
      setRegUsernameChecking(false);
      return;
    }
    setRegUsernameChecking(true);
    runAvailabilityCheck({ username: regUsername }).then((data) => {
      setRegUsernameAvailable(data.username === true ? true : data.username === false ? false : null);
      setRegUsernameError(data.username === false ? 'Username already exists' : null);
      setRegUsernameChecking(false);
    });
  }, [regUsername], 500);

  // Debounced email availability check (only for syntactically-valid emails)
  useDebouncedEffect(() => {
    const email = regEmail.trim();
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      setRegEmailAvailable(null);
      setRegEmailError(null);
      setRegEmailChecking(false);
      return;
    }
    setRegEmailChecking(true);
    runAvailabilityCheck({ email }).then((data) => {
      setRegEmailAvailable(data.email === true ? true : data.email === false ? false : null);
      setRegEmailError(data.email === false ? 'Email already exists' : null);
      setRegEmailChecking(false);
    });
  }, [regEmail], 500);

  // Password strength validator: returns null if valid, otherwise an error string
  const validatePassword = (pw) => {
    if (!pw || typeof pw !== 'string') return 'Password is required'
    if (pw.length < 8) return 'Password must be at least 8 characters long'
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) {
      return 'Password must include at least one uppercase letter, one lowercase letter, one number, and one special character.'
    }
    return null
  }

  // Score password for strength meter (0-5)
  const scorePassword = (pw) => {
    if (!pw || typeof pw !== 'string') return 0
    let score = 0
    if (pw.length >= 8) score++
    if (/[a-z]/.test(pw)) score++
    if (/[A-Z]/.test(pw)) score++
    if (/\d/.test(pw)) score++
    if (/[^A-Za-z0-9]/.test(pw)) score++
    return score
  }

  const strengthLabel = (score) => {
    switch (score) {
      case 0: return ''
      case 1: return 'Very weak'
      case 2: return 'Weak'
      case 3: return 'So-so'
      case 4: return 'Good'
      case 5: return 'Great'
      default: return ''
    }
  }

  const strengthColors = ['#ff4d4f','#ff8a4d','#ffde59','#7bd389','#34d399']

  useEffect(() => {
    return () => {
      if (socket) socket.disconnect()
      if (localStream) localStream.getTracks().forEach(t => t.stop())
    }
  }, [])

  // Try to restore session from token
  useEffect(() => {
    const t = localStorage.getItem('lanparty_token')
    if (!t) { setAuthChecked(true); return }
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/auth/me`, { headers: { 'Authorization': `Bearer ${t}` } })
        if (!res.ok) { localStorage.removeItem('lanparty_token'); return }
        const data = await res.json()
        setToken(t)
        setIsAuthenticated(true)
        setName(data.user.username)
        setUserEmail(data.user.email || '')
        setUserSettings(data.user.settings)
        applySettings(data.user.settings)
        // sync and connect
        try {
          const syncRes = await fetch(`${SERVER_URL}/user/sync`, { headers: { 'Authorization': `Bearer ${t}` } })
          if (syncRes.ok) {
            const sync = await syncRes.json()
            if (sync.servers && sync.servers.demo) {
              setServerState({ server: sync.servers.demo, members: [] })
              setMessages(oldestMessagesFirst(sync.servers.demo.messages?.general || []))
            }
          }
        } catch (err) { console.warn('Auto-sync failed', err) }
        connect(data.user.username, t)
        const [loadedFriends, loadedConversations] = await Promise.all([
          loadFriendsData(t),
          loadMessagesData(t),
        ])
        restoreSavedView({ username: data.user.username, friendsList: loadedFriends, conversations: loadedConversations, groups: groupChats, authToken: t })
      } catch (err) {
        console.warn('Restore session failed', err)
        localStorage.removeItem('lanparty_token')
      } finally {
        setAuthChecked(true)
      }
    })()
  }, [])

  useEffect(() => {
    const handler = (e) => {
      // capture the beforeinstallprompt event to trigger later
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const applyUnreadState = (totalUnread, byPeerList = [], conversations = []) => {
    setTotalUnreadMessages(totalUnread || 0)
    const map = {}
    for (const row of byPeerList) {
      if (row.unreadCount > 0) map[String(row.peerId)] = row.unreadCount
    }
    for (const c of conversations) {
      if (c.unreadCount > 0) map[String(c.id)] = c.unreadCount
    }
    setUnreadByChatId(map)
  }

  const loadMessagesData = async (authToken) => {
    const t = authToken || token
    if (!t) return
    const headers = { Authorization: `Bearer ${t}` }
    try {
      const res = await fetch(`${SERVER_URL}/messages/conversations`, { headers })
      if (!res.ok) return
      const data = await res.json()
      const conversations = data.conversations || []
      setDmConversations(conversations)
      applyUnreadState(
        data.totalUnread,
        conversations.filter((c) => c.unreadCount > 0).map((c) => ({
          peerId: c.id,
          unreadCount: c.unreadCount,
        })),
        conversations
      )
      return conversations
    } catch (err) {
      console.warn('loadMessagesData failed', err)
    }
    return []
  }

  const applyFriendPresence = (username, status) => {
    const patch = (list) =>
      list.map((f) => (f.name === username ? { ...f, status } : f))
    setFriends((prev) => patch(prev))
    setDmConversations((prev) => patch(prev))
  }

  const saveUserPresence = async (status) => {
    setUserStatus(status)
    if (!token) return
    try {
      await fetch(`${SERVER_URL}/user/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      })
    } catch (err) {
      console.warn('saveUserPresence failed', err)
    }
  }

  const loadFriendsData = async (authToken) => {
    const t = authToken || token
    if (!t) return []
    const headers = { Authorization: `Bearer ${t}` }
    let loadedFriends = []
    try {
      const [friendsRes, requestsRes, outgoingRes] = await Promise.all([
        fetch(`${SERVER_URL}/friends`, { headers }),
        fetch(`${SERVER_URL}/friends/requests/incoming`, { headers }),
        fetch(`${SERVER_URL}/friends/requests/outgoing`, { headers }),
      ])
      if (friendsRes.ok) {
        const data = await friendsRes.json()
        loadedFriends = data.friends || []
        setFriends(loadedFriends)
      }
      if (requestsRes.ok) {
        const data = await requestsRes.json()
        const requests = data.requests || []
        setPendingFriendRequests(requests)
        setPendingFriendCount(requests.length)
      }
      if (outgoingRes.ok) {
        const data = await outgoingRes.json()
        setOutgoingFriendRequests(data.requests || [])
      }
    } catch (err) {
      console.warn('loadFriendsData failed', err)
    }
    return loadedFriends
  }

  const restoreSavedView = ({ username, friendsList = [], conversations = [], groups = [], authToken } = {}) => {
    if (restoredViewRef.current) return
    const saved = readSavedViewState()
    restoredViewRef.current = true
    viewPersistenceReadyRef.current = true
    if (!saved || Object.keys(saved).length === 0) return
    if (saved.username && username && saved.username !== username) return

    if (saved.leftNav) setLeftNav(saved.leftNav)
    if (saved.activeChannel) setActiveChannel(saved.activeChannel)
    if (saved.selectedServerId) {
      // Migrate old mock rail ids (s1..s5) from previous versions: s1 was LAN Party ('demo').
      const sid = saved.selectedServerId
      setSelectedServerId(/^s[2-5]$/.test(sid) ? 'home' : (sid === 's1' ? 'demo' : sid))
    }

    const savedChat = saved.homeChat
    if (!savedChat || saved.selectedServerId !== 'home') return

    setSelectedServerId('home')
    if (saved.leftNav) setLeftNav(saved.leftNav)

    if (savedChat.type === 'dm') {
      const dm = conversations.find((item) => String(item.id) === String(savedChat.id))
      const chat = dm || savedChat
      setSelectedDmId(chat.id)
      setSelectedFriendId(null)
      setSelectedGroupId(null)
      setHomeChat({
        type: 'dm',
        id: chatStorageKey(chat.id),
        name: chat.name || savedChat.name,
        peerUsername: chat.peerUsername || savedChat.peerUsername || savedChat.name,
      })
      loadHomeChatHistory(chat.peerUsername || savedChat.peerUsername || savedChat.name, chatStorageKey(chat.id), authToken)
      return
    }

    if (savedChat.type === 'friend') {
      const friend = friendsList.find((item) => String(item.id) === String(savedChat.id))
      const chat = friend || savedChat
      setSelectedFriendId(chat.id)
      setSelectedDmId(null)
      setSelectedGroupId(null)
      setHomeChat({
        type: 'friend',
        id: chatStorageKey(chat.id),
        name: chat.name || savedChat.name,
        peerUsername: chat.peerUsername || chat.name || savedChat.peerUsername,
      })
      loadHomeChatHistory(chat.peerUsername || chat.name || savedChat.peerUsername, chatStorageKey(chat.id), authToken)
      return
    }

    if (savedChat.type === 'group') {
      const group = groups.find((item) => String(item.id) === String(savedChat.id)) || savedChat
      setGroupChats((prev) => {
        if (prev.some((item) => String(item.id) === String(group.id))) return prev
        return [{ ...group, preview: group.preview || 'Group chat' }, ...prev]
      })
      setSelectedGroupId(group.id)
      setSelectedFriendId(null)
      setSelectedDmId(null)
      setHomeChat({ type: 'group', id: group.id, name: group.name || savedChat.name })
    }
  }

  const cancelOutgoingFriendRequest = async (requestId) => {
    if (!token) return
    try {
      const res = await fetch(`${SERVER_URL}/friends/requests/${requestId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to cancel')
      }
      await loadFriendsData()
    } catch (err) {
      console.warn('cancelOutgoingFriendRequest', err)
    }
  }

  useEffect(() => {
    if (!showAddFriendModal || !token) return undefined
    const u = addFriendUsername.trim()
    if (!u) {
      setAddFriendUserExists(null)
      setAddFriendIsSelf(false)
      setAddFriendUserChecking(false)
      return undefined
    }
    setAddFriendUserChecking(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${SERVER_URL}/friends/check-user?username=${encodeURIComponent(u)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        const data = await res.json()
        if (res.ok) {
          setAddFriendUserExists(data.exists)
          setAddFriendIsSelf(!!data.self)
        } else {
          setAddFriendUserExists(null)
          setAddFriendIsSelf(false)
        }
      } catch {
        setAddFriendUserExists(null)
        setAddFriendIsSelf(false)
      } finally {
        setAddFriendUserChecking(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [addFriendUsername, showAddFriendModal, token])

  const openAddFriendModal = () => {
    setAddFriendUsername('')
    setAddFriendError(null)
    setAddFriendUserExists(null)
    setAddFriendIsSelf(false)
    setShowAddFriendModal(true)
  }

  const closeAddFriendModal = () => {
    setShowAddFriendModal(false)
    setAddFriendUsername('')
    setAddFriendError(null)
    setAddFriendUserExists(null)
    setAddFriendIsSelf(false)
  }

  const sendFriendRequest = async () => {
    const u = addFriendUsername.trim()
    if (!u || !token) return
    setAddFriendLoading(true)
    setAddFriendError(null)
    try {
      const res = await fetch(`${SERVER_URL}/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: u }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send request')
      closeAddFriendModal()
      await loadFriendsData()
    } catch (err) {
      setAddFriendError(err.message)
    } finally {
      setAddFriendLoading(false)
    }
  }

  const acceptFriendRequest = async (requestId) => {
    if (!token) return
    try {
      const res = await fetch(`${SERVER_URL}/friends/requests/${requestId}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to accept')
      }
      await loadFriendsData()
    } catch (err) {
      console.warn('acceptFriendRequest', err)
    }
  }

  const declineFriendRequest = async (requestId) => {
    if (!token) return
    try {
      const res = await fetch(`${SERVER_URL}/friends/requests/${requestId}/decline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to decline')
      }
      await loadFriendsData()
    } catch (err) {
      console.warn('declineFriendRequest', err)
    }
  }

  const openSettings = () => {
    const root = getComputedStyle(document.documentElement)
    const defaults = userSettings || {
      railColor: root.getPropertyValue('--rail-bg').trim() || '#7a0d0d',
      sidebarColor: root.getPropertyValue('--sidebar-bg').trim() || '#0f1418',
      panelColor: root.getPropertyValue('--panel-bg').trim() || '#111417',
      headerColor: root.getPropertyValue('--header-bg').trim() || '#7a0d0d',
      accentStart: root.getPropertyValue('--accent-start').trim() || '#2bc3ff',
      accentEnd: root.getPropertyValue('--accent-end').trim() || '#0b86ff',
      fontColor: root.getPropertyValue('--text').trim() || '#edf6ff',
      leftTileColor: root.getPropertyValue('--left-tile-bg').trim() || '#1f2933'
    }
    setEditingSettings(defaults)
    setEditingProfile(normalizeProfile(profile))
    setCustomTagInput('')
    setShowSettingsPanel(true)
  }

  const saveSettings = async () => {
    if (!name || !token) return
    try {
      const res = await fetch(`${SERVER_URL}/user/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ settings: editingSettings }) })
      const data = await res.json()
      if (res.ok) {
        setUserSettings(data.settings)
        applySettings(data.settings)
        setShowSettingsPanel(false)
      } else {
        console.warn('Save failed', data)
      }
    } catch (err) { console.warn(err) }
  }

  // Change how new messages flow (bottom-anchored vs top-down) and persist for this user only.
  const selectMessageFlow = (flow) => {
    if (flow !== 'top' && flow !== 'bottom') return
    setMessageFlow(flow)
    patchUserSettings({ messageFlow: flow })
  }

  // ---- Gaming profile (genres + games played lately), edited alongside profile settings ----
  const editingGaming = (editingSettings && editingSettings.gamingProfile) || { genres: [], currentGames: '' }
  const updateGamingProfile = (patch) => setEditingSettings((s) => ({ ...(s || {}), gamingProfile: { ...((s && s.gamingProfile) || {}), ...patch, updatedAt: Date.now() } }))
  const toggleEditGenre = (g) => setEditingSettings((s) => {
    const cur = (s && s.gamingProfile && s.gamingProfile.genres) || []
    const genres = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]
    return { ...(s || {}), gamingProfile: { ...((s && s.gamingProfile) || {}), genres, updatedAt: Date.now() } }
  })

  // ---- Profile customization ----
  const updateProfileDraft = (patch) => setEditingProfile((p) => ({ ...(p || {}), ...patch }))
  const updateProfileBorder = (patch) => setEditingProfile((p) => ({ ...(p || {}), border: { ...(p?.border || {}), ...patch } }))

  const uploadProfileAvatar = async (file) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !file) return
    if (!file.type.startsWith('image/')) { setUploadError('Profile picture must be an image.'); return }
    if (file.size > MAX_FILE_SIZE) { setUploadError('File is larger than 100 MB.'); return }
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      updateProfileDraft({ avatarUrl: data.attachment.url })
    } catch (err) {
      setUploadError(err.message)
    }
  }

  // Set avatar from a pasted image URL.
  const setAvatarFromUrl = (url) => {
    const trimmed = (url || '').trim()
    if (!/^https?:\/\/\S+$/i.test(trimmed)) { setUploadError('Enter a valid image URL.'); return }
    setUploadError(null)
    updateProfileDraft({ avatarUrl: trimmed })
  }

  const addCustomTag = () => {
    const label = customTagInput.trim().slice(0, 16)
    if (!label) return
    setEditingProfile((p) => {
      const tags = p?.tags || []
      if (tags.some((t) => t.type === 'custom' && t.label.toLowerCase() === label.toLowerCase())) return p
      return { ...p, tags: [...tags, { type: 'custom', label }] }
    })
    setCustomTagInput('')
  }
  const toggleServerTag = (label) => {
    setEditingProfile((p) => {
      const tags = p?.tags || []
      const exists = tags.some((t) => t.type === 'server' && t.label === label)
      return { ...p, tags: exists ? tags.filter((t) => !(t.type === 'server' && t.label === label)) : [...tags, { type: 'server', label }] }
    })
  }
  const removeTag = (tag) => setEditingProfile((p) => ({ ...p, tags: (p?.tags || []).filter((t) => !(t.type === tag.type && t.label === tag.label)) }))

  // Commit the edited profile: live state + persisted settings (including the gaming profile,
  // which lives in editingSettings). Refresh userSettings so Discover emits use fresh genres.
  const saveProfile = () => {
    const normalized = normalizeProfile(editingProfile)
    setProfile(normalized)
    const gaming = editingSettings?.gamingProfile
    const patch = gaming ? { profile: normalized, gamingProfile: gaming } : { profile: normalized }
    patchUserSettings(patch)
    setUserSettings((prev) => ({ ...(prev || {}), ...patch }))
  }

  // Apply a preset color scheme: update live CSS vars, local state, and persist (merging so
  // unrelated settings like custom emojis are preserved).
  const selectScheme = (scheme) => {
    if (!scheme) return
    const next = { ...(editingSettings || {}), ...scheme.colors }
    setEditingSettings(next)
    setUserSettings((prev) => ({ ...(prev || {}), ...scheme.colors }))
    applySettings(next)
    patchUserSettings(scheme.colors)
  }

  const resetSettings = () => {
    setEditingSettings({
      railColor: '#7a0d0d', sidebarColor: '#0f1418', panelColor: '#111417', headerColor: '#7a0d0d', accentStart: '#2bc3ff', accentEnd: '#0b86ff', fontColor: '#edf6ff', leftTileColor: '#1f2933'
    })
  }

  const clearRegisterForm = () => {
    setRegUsername('')
    setRegEmail('')
    setRegPassword('')
    setRegPasswordConfirm('')
    setRegGenres([])
    setRegCurrentGames('')
    setAuthError(null)
    setForgotMessage(null)
    setRegUsernameError(null)
    setRegEmailError(null)
    setShowRegPassword(false)
    setShowRegPasswordConfirm(false)
  }

  const markConversationRead = async (peerUsername, authToken) => {
    const t = authToken || token
    if (!t || !peerUsername) return
    try {
      await fetch(`${SERVER_URL}/messages/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ withUsername: peerUsername }),
      })
      await loadMessagesData(t)
    } catch (err) {
      console.warn('markConversationRead failed', err)
    }
  }

  const appendHomeMessage = (chatKey, message) => {
    const key = chatStorageKey(chatKey)
    if (!message?.id) return
    setHomeMessages((prev) => {
      const existing = prev[key] || []
      if (existing.some((m) => m.id === message.id)) return prev
      return { ...prev, [key]: oldestMessagesFirst([...existing, message]) }
    })
  }

  const updateDmConversationPreview = (chatId, peerUsername, message, unreadCount) => {
    if (!message) return
    setDmConversations((prev) =>
      prev.map((conversation) => {
        const matchesId = chatId && String(conversation.id) === String(chatId)
        const matchesPeer = peerUsername && conversation.peerUsername === peerUsername
        if (!matchesId && !matchesPeer) return conversation
        return {
          ...conversation,
          unreadCount: unreadCount ?? conversation.unreadCount ?? 0,
          lastMessage: {
            text: message.text || (message.attachment ? 'Sent an attachment' : ''),
            author: message.author,
            createdAt: message.ts || Date.now(),
          },
        }
      })
    )
  }

  const updateGroupConversationPreview = (groupId, message) => {
    if (!groupId || !message) return
    setGroupChats((prev) =>
      prev.map((group) => {
        if (String(group.id) !== String(groupId)) return group
        return {
          ...group,
          preview: message.text || (message.attachment ? 'Sent an attachment' : group.preview),
          lastMessage: {
            text: message.text || (message.attachment ? 'Sent an attachment' : ''),
            author: message.author,
            createdAt: message.ts || Date.now(),
          },
        }
      })
    )
  }

  const loadHomeChatHistory = async (peerUsername, chatKey, authToken) => {
    const t = authToken || token
    if (!t || !peerUsername) return
    const key = chatStorageKey(chatKey)
    const seq = (chatHistoryLoadSeqRef.current[key] || 0) + 1
    chatHistoryLoadSeqRef.current[key] = seq
    try {
      const res = await fetch(
        `${SERVER_URL}/messages/with/${encodeURIComponent(peerUsername)}?markRead=1`,
        { headers: { Authorization: `Bearer ${t}` } }
      )
      if (!res.ok) return
      if (chatHistoryLoadSeqRef.current[key] !== seq) return
      const data = await res.json()
      const messages = (data.messages || []).map((m, i) => ({
        ...m,
        id: m.id ?? `${key}-${m.ts}-${i}`,
      }))
      setHomeMessages((prev) => ({ ...prev, [key]: oldestMessagesFirst(messages) }))
      await loadMessagesData(t)
    } catch (err) {
      console.warn('loadHomeChatHistory failed', err)
    }
  }

  const totalUnreadWithGroups = totalUnreadMessages + Object.values(groupUnread).reduce((a, b) => a + b, 0)

  // Apply user settings to CSS variables
  const applySettings = (settings) => {
    if (!settings) return
    const root = document.documentElement.style
    root.setProperty('--rail-bg', settings.railColor || '#7a0d0d')
    root.setProperty('--sidebar-bg', settings.sidebarColor || '#0e1317')
    root.setProperty('--panel-bg', settings.panelColor || '#0f1418')
    root.setProperty('--header-bg', settings.headerColor || settings.railColor || '#7a0d0d')
    root.setProperty('--accent-start', settings.accentStart || '#2bc3ff')
    root.setProperty('--accent-end', settings.accentEnd || '#0b86ff')
    root.setProperty('--text', settings.fontColor || '#e6eef8')
    root.setProperty('--left-tile-bg', settings.leftTileColor || '#1f2933')
    if (Array.isArray(settings.customEmojis)) setCustomEmojis(settings.customEmojis)
    if (settings.emojiSkinTones && typeof settings.emojiSkinTones === 'object') setEmojiSkinTones(settings.emojiSkinTones)
    if (settings.messageFlow === 'top' || settings.messageFlow === 'bottom') setMessageFlow(settings.messageFlow)
    if (settings.profile && typeof settings.profile === 'object') setProfile(normalizeProfile(settings.profile))
  }

  const connect = (userName, t) => {
    if (socket) {
      try { socket.disconnect(); } catch (e) {}
    }
    const authToken = t || token || localStorage.getItem('lanparty_token')
    const s = io(SERVER_URL, { auth: { token: authToken } })
    setSocket(s)
    socketRef.current = s
    s.on('connect', () => {
      const nick = userName || name || 'Guest'
      setName(nick)
      // Join the current server (restored view) or the default one.
      const sid = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
      s.emit('join', { serverId: sid, name: nick })
      setConnected(true)
      loadFriendsData(authToken)
      loadMessagesData(authToken)
      loadServers()
    })
    s.on('friend:pending-updated', () => loadFriendsData(authToken))
    s.on('friend:list-updated', () => { loadFriendsData(authToken); loadMessagesData(authToken) })
    s.on('friend:presence-updated', ({ username, status }) => {
      applyFriendPresence(username, status)
    })
    s.on('dm:unread-updated', ({ totalUnread, byPeer }) => {
      applyUnreadState(totalUnread, byPeer || [])
      setDmConversations((prev) =>
        prev.map((c) => {
          const row = (byPeer || []).find((p) => String(p.peerId) === String(c.id))
          return { ...c, unreadCount: row ? row.unreadCount : 0 }
        })
      )
      loadMessagesData(authToken)
    })
    s.on('dm:message', ({ fromUsername, fromUserId, message }) => {
      const chatKey = chatStorageKey(fromUserId)
      appendHomeMessage(chatKey, message)
      updateDmConversationPreview(fromUserId, fromUsername, message)
      if (
        homeChatRef.current?.peerUsername === fromUsername &&
        selectedServerIdRef.current === 'home'
      ) {
        markConversationRead(fromUsername, authToken)
      } else {
        loadMessagesData(authToken)
      }
    })
    s.on('server:state', (data) => {
      // dedupe members on client as well: prefer username, and mark current socket id when present
      const raw = (data.members || [])
      const map = new Map()
      for (const m of raw) {
        const key = m.username || m.name || m.id
        if (!map.has(key)) {
          map.set(key, m)
        } else {
          const existing = map.get(key)
          // prefer entry that matches our socket id (you), otherwise keep latest
          if (m.id === s.id) map.set(key, m)
          else if (existing.id === s.id) map.set(key, existing)
          else map.set(key, m)
        }
      }
      const members = Array.from(map.values())
      setServerState({ server: data.server, members })
    })
    // messages:init is `{ serverId, channelId, messages }` (older array shape still accepted).
    s.on('messages:init', (payload) => {
      const msgs = Array.isArray(payload) ? payload : (payload && payload.messages) || []
      setMessages(oldestMessagesFirst(msgs))
    })
    s.on('channel:joined', ({ channelId } = {}) => { if (channelId) setActiveChannel(channelId) })
    s.on('message', (msg) => {
      // Drop messages that aren't for the server+channel currently on screen (rooms should already
      // guarantee this; the tag check is belt & braces against any stale room membership).
      if (msg && msg.serverId && msg.channelId) {
        const viewServer = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
        if (msg.serverId !== viewServer || msg.channelId !== activeChannelRef.current) return
      }
      setMessages(prev => {
        if (prev.some((m) => m.id === msg.id)) return prev
        return oldestMessagesFirst([...prev, msg])
      })
    })
    // A server was created/removed somewhere — refresh the rail.
    s.on('servers:updated', () => { loadServers() })

    // Persisted reaction changed — apply the authoritative counts (mine computed for this user).
    s.on('reaction:updated', ({ scope, messageId, reactions }) => {
      const formatted = formatReactions(reactions, userName)
      if (scope === 'dm') {
        setHomeMessages((prev) => {
          let changed = false
          const next = {}
          for (const key of Object.keys(prev)) {
            next[key] = prev[key].map((m) => {
              if (String(m.id) === String(messageId)) { changed = true; return { ...m, reactions: formatted } }
              return m
            })
          }
          return changed ? next : prev
        })
      } else {
        setMessages((prev) => prev.map((m) => (String(m.id) === String(messageId) ? { ...m, reactions: formatted } : m)))
      }
    })

    // A channel message was deleted by its author — remove it for everyone.
    s.on('message:deleted', ({ id }) => setMessages((prev) => prev.filter((m) => String(m.id) !== String(id))))
    // A DM was deleted — drop that message id from any conversation it appears in.
    s.on('dm:message-deleted', ({ id }) => setHomeMessages((prev) => {
      let changed = false
      const next = {}
      for (const key of Object.keys(prev)) {
        const arr = prev[key]
        const filtered = arr.filter((m) => String(m.id) !== String(id))
        if (filtered.length !== arr.length) changed = true
        next[key] = filtered
      }
      return changed ? next : prev
    }))

    // Someone in the channel fired a soundboard clip — play it locally (replacing any current one).
    s.on('soundboard:play', ({ soundId, url }) => playSoundUrl(url, soundId))
    s.on('soundboard:stop', () => stopCurrentSound())

    // voice events — I (the newcomer) create a peer for each existing member; adding my tracks
    // triggers onnegotiationneeded, which sends the offer. Existing peers answer via voice:signal.
    s.on('voice:peers', (peers) => {
      setPeerNames((prev) => ({ ...prev, ...Object.fromEntries(peers.map((p) => [p.id, p.name])) }))
      for (const p of peers) createPeer(p.id)
      setInVoice(true)
    })
    s.on('voice:peer-joined', ({ id, name: peerName }) => {
      // The newcomer offers to us; we create our peer when their offer arrives (handleSignal).
      if (id) setPeerNames((prev) => ({ ...prev, [id]: peerName }))
    })
    s.on('voice:signal', ({ from, signal }) => { handleSignal(from, signal) })
    s.on('voice:peer-left', ({ id }) => { removePeer(id); setPeerNames((prev) => { const c = { ...prev }; delete c[id]; return c }); setScreenSharingPeers((prev) => { const c = { ...prev }; delete c[id]; return c }) })
    s.on('voice:screenshare-state', ({ id, sharing }) => setScreenSharingPeers((prev) => ({ ...prev, [id]: sharing })))
    // Watch/Discover: the server pushes the full list of who's live whenever it changes.
    s.on('discover:update', (list) => setDiscoverStreams(Array.isArray(list) ? list : []))
    s.emit('discover:list')
    // Activities: the server pushes the current shared activity for our voice room (or null).
    s.on('activity:update', (a) => setActivity(a && typeof a === 'object' ? a : null))
    // Fetch WebRTC ICE servers (STUN + any configured TURN) so calls connect across networks.
    fetch(`${SERVER_URL}/webrtc/ice`).then((r) => r.json()).then((d) => { if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceConfigRef.current = d.iceServers }).catch(() => {})

    // Collaborative image editing
    s.on('collab:invite', ({ sessionId, imageUrl, by }) => setCollabInvite({ sessionId, imageUrl, by }))
    s.on('collab:state', ({ segments }) => collabCanvasRef.current?.loadSegments(segments || []))
    s.on('collab:draw', ({ segment }) => collabCanvasRef.current?.drawSegment(segment))
    s.on('collab:clear', () => collabCanvasRef.current?.clearCanvas())
  }

  // Auth handlers
  const handleLogin = async (e) => {
    e && e.preventDefault && e.preventDefault()
    setAuthLoading(true)
    setAuthError(null)
    try {
      const res = await fetch(`${SERVER_URL}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword, remember: rememberMe })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Login failed')
      // success: store token and user
      setIsAuthenticated(true)
      setName(data.user.username)
      setUserEmail(data.user.email || '')
      setToken(data.token)
      localStorage.setItem('lanparty_token', data.token)
      localStorage.setItem('lanparty_user', data.user.username)

      // apply user settings
      if (data.user.settings) {
        setUserSettings(data.user.settings)
        applySettings(data.user.settings)
      }

      // sync messaging data for user (use token)
      try {
        const syncRes = await fetch(`${SERVER_URL}/user/sync`, { headers: { 'Authorization': `Bearer ${data.token}` } })
        if (syncRes.ok) {
          const sync = await syncRes.json()
          if (sync.servers && sync.servers.demo) {
            setServerState({ server: sync.servers.demo, members: [] })
            setMessages(oldestMessagesFirst(sync.servers.demo.messages?.general || []))
          }
        }
      } catch (err) {
        console.warn('Sync failed', err)
      }

      // finally connect sockets with token
      connect(data.user.username, data.token)
      const [loadedFriends, loadedConversations] = await Promise.all([
        loadFriendsData(data.token),
        loadMessagesData(data.token),
      ])
      restoreSavedView({ username: data.user.username, friendsList: loadedFriends, conversations: loadedConversations, groups: groupChats, authToken: data.token })
    } catch (err) {
      setAuthError(err.message)
    } finally { setAuthLoading(false) }
  }

  const handleRegister = async (e) => {
    e && e.preventDefault && e.preventDefault();
    setAuthError(null);
    // Fast, definite client-side checks. The server re-validates everything (required fields,
    // password rules, email format, uniqueness) and is the source of truth — so we never
    // hard-block on the advisory availability lookups, which could be pending/offline.
    if (!regUsername.trim() || !regEmail.trim() || !regPassword || !regPasswordConfirm) {
      setAuthError('Please fill in all fields.'); return;
    }
    if (!/\S+@\S+\.\S+/.test(regEmail)) { setAuthError('Please enter a valid email address.'); return; }
    if (regPassword !== regPasswordConfirm) { setAuthError('Passwords do not match'); return; }
    const passErr = validatePassword(regPassword)
    if (passErr) { setAuthError(passErr); return; }
    // If a prior lookup already told us it's taken, surface it inline without a round-trip.
    if (regUsernameAvailable === false) { setRegUsernameError('Username already exists'); return; }
    if (regEmailAvailable === false) { setRegEmailError('Email already exists'); return; }
    setAuthLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: regUsername, email: regEmail, password: regPassword, passwordConfirm: regPasswordConfirm, genres: regGenres, currentGames: regCurrentGames })
      })
      const data = await res.json()
      if (!res.ok) {
        // server may return field-specific errors
        if (data.field === 'username') { setRegUsernameError(data.error); setAuthLoading(false); return }
        if (data.field === 'email') { setRegEmailError(data.error); setAuthLoading(false); return }
        throw new Error(data.error || 'Register failed')
      }
      // On success, switch to login and prefill
      setAuthMode('login')
      clearRegisterForm()
      setAuthError('Account created. Please log in.')
    } catch (err) {
      setAuthError(err instanceof TypeError ? "Couldn't reach the server. Please try again." : (err.message || 'Register failed'))
    } finally { setAuthLoading(false) }
  }

  const handleForgot = async (e) => {
    e && e.preventDefault && e.preventDefault()
    setAuthLoading(true); setForgotMessage(null)
    try {
      const res = await fetch(`${SERVER_URL}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: forgotEmail }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Request failed')
      setForgotMessage(data.message || 'If that email exists, a reset link was sent (mock).')
    } catch (err) {
      setForgotMessage(err.message)
    } finally { setAuthLoading(false) }
  }

  // The server id the main view is talking to ('home' shows DMs, backed by the default server).
  const currentServerId = () => (selectedServerId !== 'home' ? selectedServerId : 'demo')

  // Mirror the active channel into a ref for socket callbacks (bound once at socket setup).
  useEffect(() => { activeChannelRef.current = activeChannel }, [activeChannel])

  // Whenever the server list changes (load, create, delete), bounce home if the server we're
  // viewing no longer exists (e.g. someone deleted it).
  useEffect(() => {
    if (serversList.length === 0) return
    if (selectedServerId !== 'home' && !serversList.some((sv) => sv.id === selectedServerId)) {
      setSelectedServerId('home')
    }
  }, [serversList, selectedServerId])

  // If the channel we're viewing was deleted (server:state no longer lists it), hop to the
  // server's first text channel.
  useEffect(() => {
    if (selectedServerId === 'home') return
    const chans = serverState?.server?.channels
    if (!chans || !chans.length || serverState.server.id !== selectedServerId) return
    if (!activeChannel || !chans.some((c) => c.id === activeChannel)) {
      const firstText = chans.find((c) => c.type === 'text')
      if (firstText) joinChannel(firstText.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverState, selectedServerId])

  const loadServers = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const res = await fetch(`${SERVER_URL}/servers`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return
      const data = await res.json()
      setServersList(Array.isArray(data.servers) ? data.servers : [])
    } catch (e) { /* offline — rail just stays as-is */ }
  }

  // Select a server tile: switch the socket into that server (its channels/messages replace the view).
  const handleSelectServer = (id) => {
    setSelectedServerId(id)
    if (id !== 'home' && socketRef.current) {
      setMessages([])
      socketRef.current.emit('join', { serverId: id, name })
    }
  }

  const createServer = async () => {
    const serverName = (window.prompt('Name your new server:') || '').trim()
    if (!serverName) return
    const t = token || localStorage.getItem('lanparty_token')
    try {
      const res = await fetch(`${SERVER_URL}/servers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ name: serverName }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create server')
      await loadServers()
      handleSelectServer(data.server.id)
    } catch (err) {
      alert(err.message || 'Could not create server')
    }
  }

  const createChannel = async (type) => {
    const sid = currentServerId()
    const chName = (window.prompt(`Name the new ${type === 'voice' ? 'voice' : 'text'} channel:`) || '').trim()
    if (!chName) return
    const t = token || localStorage.getItem('lanparty_token')
    try {
      const res = await fetch(`${SERVER_URL}/servers/${encodeURIComponent(sid)}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ name: chName, type }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create channel')
      // server:state broadcast updates the sidebar; jump into new text channels right away
      if (type === 'text') joinChannel(data.channel.id)
    } catch (err) {
      alert(err.message || 'Could not create channel')
    }
  }

  const authedFetch = (path, opts = {}) => {
    const t = token || localStorage.getItem('lanparty_token')
    return fetch(`${SERVER_URL}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(opts.headers || {}) } })
  }

  const renameServer = async (serverId, oldName) => {
    const name2 = (window.prompt('Rename server:', oldName || '') || '').trim()
    if (!name2 || name2 === oldName) return
    const res = await authedFetch(`/servers/${encodeURIComponent(serverId)}`, { method: 'PATCH', body: JSON.stringify({ name: name2 }) })
    if (!res.ok) alert((await res.json()).error || 'Rename failed')
  }

  const deleteServer = async (serverId, serverName2) => {
    if (!window.confirm(`Delete "${serverName2}"? All of its channels and messages will be permanently removed.`)) return
    const res = await authedFetch(`/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' })
    if (!res.ok) { alert((await res.json()).error || 'Delete failed'); return }
    if (selectedServerId === serverId) setSelectedServerId('home')
  }

  const renameChannel = async (channelId, oldName) => {
    const name2 = (window.prompt('Rename channel:', oldName || '') || '').trim()
    if (!name2 || name2 === oldName) return
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: JSON.stringify({ name: name2 }) })
    if (!res.ok) alert((await res.json()).error || 'Rename failed')
  }

  const deleteChannel = async (channelId, chName) => {
    if (!window.confirm(`Delete #${chName}? Its messages will be permanently removed.`)) return
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' })
    if (!res.ok) alert((await res.json()).error || 'Delete failed')
  }

  const joinChannel = (channelId) => {
    if (!socket) return
    setActiveChannel(channelId)
    socket.emit('joinChannel', { serverId: currentServerId(), channelId })
  }

  const sendMessage = async () => {
    if (!socket || (!text.trim() && !pendingFile)) return
    const body = text.trim()
    setText('')
    setShowEmojiPicker(false)
    setUploadError(null)
    setUploadingFile(true)
    try {
      const attachment = await uploadSelectedFile()
      socket.emit('message', { serverId: currentServerId(), channelId: activeChannel, text: body, attachment })
      clearPendingAttachment()
    } catch (err) {
      setUploadError(err.message)
      setText(body)
    } finally {
      setUploadingFile(false)
    }
  }

  // Tear down one peer connection and drop its remote stream.
  const removePeer = (peerId) => {
    const st = peersRef.current[peerId]
    if (st?.pc) { try { st.pc.close() } catch (e) {} }
    delete peersRef.current[peerId]
    setRemoteStreams((prev) => { const copy = { ...prev }; delete copy[peerId]; return copy })
  }

  // Create a peer connection using the "perfect negotiation" pattern so tracks can be added or
  // removed mid-call (camera / screen share) without glare. Politeness is derived deterministically
  // from the two socket ids so exactly one side is polite.
  const createPeer = (peerId) => {
    if (peersRef.current[peerId]) return peersRef.current[peerId]
    const pc = new RTCPeerConnection({ iceServers: iceConfigRef.current })
    const st = { pc, polite: (socketRef.current?.id || '') < peerId, makingOffer: false, ignoreOffer: false }
    peersRef.current[peerId] = st

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit('voice:signal', { to: peerId, signal: { candidate: e.candidate } })
    }
    pc.ontrack = (e) => {
      const [stream] = e.streams
      if (stream) setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }))
    }
    pc.onnegotiationneeded = async () => {
      try {
        st.makingOffer = true
        await pc.setLocalDescription()
        socketRef.current?.emit('voice:signal', { to: peerId, signal: { description: pc.localDescription } })
      } catch (err) {
        console.warn('negotiation failed', err)
      } finally {
        st.makingOffer = false
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(peerId)
    }
    // Send whatever local tracks we currently have (audio, plus video if the camera is already on).
    const ls = localStreamRef.current
    if (ls) ls.getTracks().forEach((track) => pc.addTrack(track, ls))
    return st
  }

  const handleSignal = async (from, signal) => {
    const st = peersRef.current[from] || createPeer(from)
    const pc = st.pc
    try {
      if (signal.description) {
        const desc = signal.description
        const offerCollision = desc.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable')
        st.ignoreOffer = !st.polite && offerCollision
        if (st.ignoreOffer) return
        await pc.setRemoteDescription(desc)
        if (desc.type === 'offer') {
          await pc.setLocalDescription()
          socketRef.current?.emit('voice:signal', { to: from, signal: { description: pc.localDescription } })
        }
      } else if (signal.candidate) {
        try { await pc.addIceCandidate(signal.candidate) } catch (err) { if (!st.ignoreOffer) throw err }
      }
    } catch (err) {
      console.warn('handleSignal failed', err)
    }
  }

  const startVoice = async (channelId = 'voice1', opts = {}) => {
    if (typeof channelId !== 'string') channelId = 'voice1' // guard against being passed a click event
    if (!socket) return
    const muted = opts.muted != null ? opts.muted : micMuted
    if (!localStreamRef.current) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true })
        localStreamRef.current = s
        setLocalStream(s)
      } catch (err) {
        alert('Microphone access denied')
        return
      }
    }
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !muted }) // honor mute/join-muted
    setMicMuted(muted)
    // Promote the pre-join camera preview (if the user turned it on) into the call — the preview
    // pipeline (rawCam + processor + output track) simply carries over, so there's no flicker.
    if (opts.camOn && outputTrackRef.current && localStreamRef.current) {
      const ls = localStreamRef.current
      if (!ls.getVideoTracks().includes(outputTrackRef.current)) ls.addTrack(outputTrackRef.current)
      outputTrackRef.current.onended = () => stopCamera()
      setScreenSharing(false)
      setVideoOn(true)
      setLocalStream(new MediaStream(ls.getTracks()))
    }
    // Pin the call to its server: every later voice/soundboard/activity emit targets this id even
    // if the user browses other servers mid-call.
    const callServerId = opts.serverId || currentServerId()
    voiceServerIdRef.current = callServerId
    setVoiceRailTarget(selectedServerId === 'home' ? 'home' : selectedServerId)
    setVoiceChannelId(channelId)
    setInVoice(true)
    socket.emit('voice:join', { serverId: callServerId, channelId })
    if (opts.camOn && outputTrackRef.current) emitStreamState(true, false, channelId) // announce our camera for Watch/Discover
  }

  // Join a voice channel from anywhere → open the pre-join screen (unless already in that channel).
  const joinVoiceChannel = (channelId, serverId) => {
    if (serverId && serverId !== currentServerId()) handleSelectServer(serverId)
    if (inVoice && voiceChannelId === channelId && voiceServerIdRef.current === (serverId || currentServerId())) { joinChannel(channelId); return }
    joinChannel(channelId) // navigate so the call view is behind the pre-join dialog
    openPreJoin(channelId, serverId)
  }

  // Open the Teams-style pre-join screen. We grab the mic so device names resolve and it can be
  // reused when joining — but NOTHING is sent to the call until the user clicks "Join now".
  const openPreJoin = (channelId, serverId) => {
    preJoinServerIdRef.current = serverId || currentServerId()
    setPreJoinChannelId(typeof channelId === 'string' ? channelId : 'voice1')
    setPreJoinCamOn(false)
    setPreJoinMuted(micMuted)
    setShowPreJoin(true)
    startPreJoinMic()
  }

  const startPreJoinMic = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true })
      if (preJoinMicStreamRef.current) preJoinMicStreamRef.current.getTracks().forEach((t) => t.stop())
      preJoinMicStreamRef.current = s
      const actual = s.getAudioTracks()[0]?.getSettings?.().deviceId
      if (actual) setSelectedMicId(actual)
      loadAudioDevices()
      startMicMeter(s)
    } catch (e) { /* mic denied — user can still join to listen */ }
  }

  const preJoinSelectMic = async (deviceId) => {
    setSelectedMicId(deviceId)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      if (preJoinMicStreamRef.current) preJoinMicStreamRef.current.getTracks().forEach((t) => t.stop())
      preJoinMicStreamRef.current = s
      startMicMeter(s)
    } catch (e) { /* ignore */ }
  }

  const stopPreJoinMic = () => {
    if (preJoinMicStreamRef.current) { preJoinMicStreamRef.current.getTracks().forEach((t) => t.stop()); preJoinMicStreamRef.current = null }
  }

  // Live mic level meter (local analysis only — never transmitted). Updates the meter mask element
  // directly (not React state) so the huge App component doesn't re-render every frame.
  const startMicMeter = (stream) => {
    stopMicMeter()
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC || !stream || !stream.getAudioTracks().length) return
    try {
      const ctx = new AC()
      if (ctx.resume) ctx.resume().catch(() => {})
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const state = { ctx, src, rafId: 0, stopped: false }
      const tick = () => {
        if (state.stopped) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 2.4)
        if (micMeterRef.current) micMeterRef.current.style.width = ((1 - level) * 100).toFixed(1) + '%' // mask shrinks as level rises
        state.rafId = requestAnimationFrame(tick)
      }
      state.rafId = requestAnimationFrame(tick)
      micAnalyserRef.current = state
    } catch (e) { /* ignore */ }
  }

  const stopMicMeter = () => {
    const s = micAnalyserRef.current
    if (s) { s.stopped = true; cancelAnimationFrame(s.rafId); try { s.src.disconnect() } catch (e) {} try { s.ctx.close() } catch (e) {} micAnalyserRef.current = null }
    if (micMeterRef.current) micMeterRef.current.style.width = '100%'
  }

  // "Join now": carry the configured mic + camera + effect into the call.
  const confirmPreJoin = async () => {
    const channelId = preJoinChannelId || 'voice1'
    const camOn = preJoinCamOn
    const muted = preJoinMuted
    if (inVoice && (voiceChannelId !== channelId || voiceServerIdRef.current !== preJoinServerIdRef.current)) leaveVoice()
    stopMicMeter()
    if (preJoinMicStreamRef.current) { // reuse the pre-join mic as the call audio (no second prompt)
      localStreamRef.current = preJoinMicStreamRef.current
      preJoinMicStreamRef.current = null
      setLocalStream(localStreamRef.current)
    }
    setShowPreJoin(false)
    await startVoice(channelId, { camOn, muted, serverId: preJoinServerIdRef.current })
  }

  const cancelPreJoin = () => {
    setShowPreJoin(false)
    setPreJoinCamOn(false)
    stopMicMeter()
    stopPreJoinMic()
    // the camera preview (if on) tears down via the preview effect once showPreJoin/preJoinCamOn clear
  }

  // Watch/Discover: open the panel (and refresh the list) / jump into a stream's voice channel.
  const openDiscover = () => { setShowDiscover(true); socketRef.current?.emit('discover:list') }
  const watchStream = (s) => { setShowDiscover(false); joinVoiceChannel((s && s.channelId) || 'voice1', s && s.serverId) }

  // --- External streams (Twitch / YouTube / Kik) ---
  const announceStream = () => {
    const f = announceForm
    if (!f.channel.trim()) { alert('Enter your channel name or stream link first.') ; return }
    socketRef.current?.emit('stream:announce', { platform: f.platform, channel: f.channel.trim(), title: f.title.trim(), game: f.game.trim(), genres: userSettings?.gamingProfile?.genres || [] })
    setMyExternalStream({ ...f })
    setShowAnnounceForm(false)
  }
  const unannounceStream = () => {
    socketRef.current?.emit('stream:unannounce')
    setMyExternalStream(null)
  }

  // Extract a YouTube video id from a URL or bare id ('' if it looks like a channel id instead).
  const parseYouTube = (input) => {
    const s = String(input || '').trim()
    if (/^UC[\w-]{20,}$/.test(s)) return { channelId: s }
    if (/^[\w-]{11}$/.test(s)) return { videoId: s }
    const m = s.match(/(?:youtu\.be\/|[?&]v=|\/live\/|embed\/|shorts\/)([\w-]{11})/)
    if (m) return { videoId: m[1] }
    const c = s.match(/youtube\.com\/channel\/(UC[\w-]{20,})/)
    if (c) return { channelId: c[1] }
    return {}
  }

  // Build the in-app embed URL for an external stream (null = not embeddable, e.g. Kik).
  const externalEmbedUrl = (s) => {
    if (!s) return null
    if (s.platform === 'twitch') {
      const ch = String(s.channel).trim().replace(/^.*twitch\.tv\//i, '').replace(/[/?#].*$/, '')
      return `https://player.twitch.tv/?channel=${encodeURIComponent(ch)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=true`
    }
    if (s.platform === 'youtube') {
      const yt = parseYouTube(s.channel)
      if (yt.videoId) return `https://www.youtube.com/embed/${yt.videoId}?autoplay=1`
      if (yt.channelId) return `https://www.youtube.com/embed/live_stream?channel=${yt.channelId}&autoplay=1`
      return null
    }
    return null // Kik has no public embed — announce-only
  }

  // Activities: start one for the room, relay an event, or end it (all scoped to the voice channel).
  const startActivity = (type) => { setShowActivityMenu(false); socketRef.current?.emit('activity:start', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', type }) }
  const sendActivityEvent = (event) => { socketRef.current?.emit('activity:event', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', event }) }
  const closeActivity = () => { socketRef.current?.emit('activity:stop', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1' }) }

  // Keyboard shortcuts on the pre-join dialog: Esc cancels, Enter joins.
  useEffect(() => {
    if (!showPreJoin) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelPreJoin() }
      else if (e.key === 'Enter' && !['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) { e.preventDefault(); confirmPreJoin() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreJoin, preJoinCamOn, preJoinMuted, preJoinChannelId, inVoice, voiceChannelId])

  // Close any open call-bar popover (audio devices / camera effects / screen-share quality) when
  // the user clicks outside it.
  useEffect(() => {
    if (!showAudioMenu && !showEffectsMenu && !showQualityMenu && !showActivityMenu) return
    const onDown = (e) => {
      if (showAudioMenu && audioMenuRef.current && !audioMenuRef.current.contains(e.target)) setShowAudioMenu(false)
      if (showEffectsMenu && effectsMenuRef.current && !effectsMenuRef.current.contains(e.target)) setShowEffectsMenu(false)
      if (showQualityMenu && qualityMenuRef.current && !qualityMenuRef.current.contains(e.target)) setShowQualityMenu(false)
      if (showActivityMenu && activityMenuRef.current && !activityMenuRef.current.contains(e.target)) setShowActivityMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showAudioMenu, showEffectsMenu, showQualityMenu, showActivityMenu])

  // Swap the local video track (camera or screen) across all peers. Pass null to stop video.
  // Add/remove of a track triggers renegotiation (onnegotiationneeded) on each connection.
  const setLocalVideoTrack = (newTrack) => {
    const ls = localStreamRef.current
    if (!ls) return
    const old = ls.getVideoTracks()[0]
    if (old) {
      Object.values(peersRef.current).forEach(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track === old)
        if (sender) pc.removeTrack(sender)
      })
      if (old !== newTrack) { old.stop(); ls.removeTrack(old) }
    }
    if (newTrack) {
      ls.addTrack(newTrack)
      Object.values(peersRef.current).forEach(({ pc }) => pc.addTrack(newTrack, ls))
    }
    setLocalStream(new MediaStream(ls.getTracks()))
  }

  // Cap the outgoing video bitrate on every peer's video sender (used for screen-share quality).
  const applyVideoBitrate = (bitrate) => {
    Object.values(peersRef.current).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video')
      if (!sender) return
      const params = sender.getParameters()
      if (!params.encodings || !params.encodings.length) params.encodings = [{}]
      params.encodings[0].maxBitrate = bitrate
      sender.setParameters(params).catch(() => {})
    })
  }

  // The background-cover source (gradient colors or image url) for a background id.
  const bgSource = (id, urlOverride) => {
    if (id === 'custom') { const u = urlOverride || customBgUrl; return u ? { url: u } : { colors: ['#232526', '#414345'] } }
    const bg = WEBCAM_BACKGROUNDS.find((b) => b.id === id)
    return bg ? { colors: bg.colors } : { colors: ['#232526', '#414345'] }
  }

  // Map an effect id to a processor descriptor. urlOverride lets a fresh upload apply before state settles.
  const describeEffect = (id, urlOverride) => {
    if (!id || id === 'none') return { kind: 'none' }
    if (id === 'blur') return { kind: 'blur', blurPx: 8 }
    if (id === 'strongblur') return { kind: 'blur', blurPx: 18 }
    if (id === 'hide') return { kind: 'hide', ...bgSource(bgCoverId, urlOverride) } // cover whole frame (person hidden)
    if (id === 'custom') { const u = urlOverride || customBgUrl; return u ? { kind: 'image', url: u } : { kind: 'none' } }
    const bg = WEBCAM_BACKGROUNDS.find((b) => b.id === id)
    return bg ? { kind: 'gradient', colors: bg.colors } : { kind: 'none' }
  }

  const camConstraints = (deviceId) => (
    deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } }
  )

  // Build/return the STABLE camera output track. The processor ALWAYS runs (even for 'none', which
  // just passes the camera through the canvas) so the output track never changes identity — effect
  // and camera changes only alter what the canvas draws, never the track. That means the track is
  // added to peers exactly once (no renegotiation churn → no freeze, stable remote video). One
  // pipeline feeds BOTH the popup preview and the live call, so preview == what goes live.
  const buildOutput = async (effectId, bgUrlOverride) => {
    const raw = rawCamStreamRef.current?.getVideoTracks()[0]
    if (!raw) return null
    const desc = describeEffect(effectId, bgUrlOverride)
    if (!effectsSupported()) return raw.clone() // no canvas capture (very old browser) → raw only
    try {
      if (effectsRef.current && effectsRef.current.isRunning) {
        await effectsRef.current.applyEffect(desc)
        return effectsRef.current.outputTrack
      }
      effectsRef.current = new WebcamEffectProcessor()
      const track = await effectsRef.current.start(raw, desc)
      setEffectsError(null)
      return track
    } catch (err) {
      console.warn('webcam pipeline failed, using raw camera', err)
      setEffectsError('Effects unavailable — is this machine online?')
      try { effectsRef.current?.stop() } catch (e) {}
      effectsRef.current = null
      return raw.clone()
    }
  }

  // Show a track in the popup self-preview. Usually the track is unchanged (stable pipeline) so we
  // avoid re-wrapping the stream; only a raw-clone fallback ever needs stopping.
  const setPreviewOutput = (track) => {
    const prev = outputTrackRef.current
    if (prev === track) { if (track && !previewStream) setPreviewStream(new MediaStream([track])); return }
    if (prev && prev !== effectsRef.current?.outputTrack) { try { prev.stop() } catch (e) {} }
    outputTrackRef.current = track || null
    setPreviewStream(track ? new MediaStream([track]) : null)
  }

  // Full camera teardown (turning the camera off, or closing the preview): drop the outgoing track,
  // stop effects, release the raw device, clear the preview.
  const stopCamera = () => {
    setLocalVideoTrack(null)
    try { effectsRef.current?.stop() } catch (e) {}
    effectsRef.current = null
    const out = outputTrackRef.current
    if (out) { try { out.stop() } catch (e) {} outputTrackRef.current = null }
    if (rawCamStreamRef.current) { rawCamStreamRef.current.getTracks().forEach((t) => t.stop()); rawCamStreamRef.current = null }
    setPreviewStream(null)
    setShowEffectsMenu(false)
    setVideoOn(false)
    if (inVoice) emitStreamState(false, false)
  }

  // Tear down just the preview pipeline (no state toggles) — used when the popup closes without
  // going live. If the camera went live we keep the pipeline (it's now the live feed).
  const teardownPreview = () => {
    if (videoOn) return
    try { effectsRef.current?.stop() } catch (e) {}
    effectsRef.current = null
    const out = outputTrackRef.current
    if (out) { try { out.stop() } catch (e) {} outputTrackRef.current = null }
    if (rawCamStreamRef.current) { rawCamStreamRef.current.getTracks().forEach((t) => t.stop()); rawCamStreamRef.current = null }
    setPreviewStream(null)
  }

  // Acquire a camera for the popup preview and render it with the currently-selected effect, so
  // the user sees exactly how they'll look before turning the camera on.
  const acquirePreview = async (deviceId) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(deviceId) })
      const oldRaw = rawCamStreamRef.current
      rawCamStreamRef.current = s
      s.getVideoTracks()[0].onended = () => stopCamera() // device unplugged / OS revoked
      setEffectsError(null)
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        setVideoDevices(devs.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' })))
      } catch (e) { /* ignore */ }
      const actual = s.getVideoTracks()[0]?.getSettings?.().deviceId
      if (actual) setSelectedCameraId(actual)
      if (effectsRef.current && effectsRef.current.isRunning) {
        // Switch the camera source in place — the stable output track is untouched.
        effectsRef.current.setCameraTrack(s.getVideoTracks()[0])
      } else {
        const out = await buildOutput(webcamEffect)
        setPreviewOutput(out)
      }
      if (oldRaw) oldRaw.getTracks().forEach((t) => t.stop()) // release the previous camera after the swap
    } catch (err) {
      teardownPreview()
      setEffectsError('Camera unavailable or permission denied')
    }
  }

  // Change the effect while the camera is already live. The processor keeps running and the output
  // track is stable, so this is just a redraw — no track swap, no renegotiation, no freeze.
  const applyLiveEffect = async (effectId, bgUrlOverride) => {
    const desc = describeEffect(effectId, bgUrlOverride)
    if (effectsRef.current && effectsRef.current.isRunning) {
      try { await effectsRef.current.applyEffect(desc); setEffectsError(null) } catch (e) { console.warn(e) }
      return
    }
    // Fallback: processor somehow not running while live → build a track and swap it in once.
    const out = await buildOutput(effectId, bgUrlOverride)
    if (out) { outputTrackRef.current = out; setLocalVideoTrack(out) }
  }

  // Choose an effect. Live → apply immediately; preview (camera off) → update the preview only,
  // so the user can compare looks before turning the camera on.
  const chooseEffect = async (effectId, bgUrlOverride) => {
    setWebcamEffect(effectId)
    if (videoOn) { if (!screenSharing) await applyLiveEffect(effectId, bgUrlOverride); return }
    const out = await buildOutput(effectId, bgUrlOverride)
    setPreviewOutput(out)
  }

  // Swap cameras mid-call, keeping the current effect. With the stable pipeline this just re-points
  // the processor's source — the output track (and the peers' senders) are untouched.
  const changeCameraLive = async (deviceId) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(deviceId) })
      const oldRaw = rawCamStreamRef.current
      rawCamStreamRef.current = s
      s.getVideoTracks()[0].onended = () => stopCamera()
      if (effectsRef.current && effectsRef.current.isRunning) {
        effectsRef.current.setCameraTrack(s.getVideoTracks()[0])
      } else {
        const out = await buildOutput(webcamEffect)
        if (out) { outputTrackRef.current = out; setLocalVideoTrack(out) }
      }
      if (oldRaw) oldRaw.getTracks().forEach((t) => t.stop())
    } catch (err) {
      setEffectsError('Could not switch camera')
    }
  }

  // Camera dropdown handler: live-switch if the camera is on, otherwise re-preview the new device.
  const changeCamera = async (deviceId) => {
    setSelectedCameraId(deviceId)
    if (videoOn) await changeCameraLive(deviceId)
    else await acquirePreview(deviceId)
  }

  // Tell the server whether we're sending camera/screen right now — powers the Watch/Discover list.
  const emitStreamState = (camera, screen, channelId) => {
    const ch = typeof channelId === 'string' ? channelId : (typeof voiceChannelId === 'string' ? voiceChannelId : 'voice1')
    socketRef.current?.emit('voice:stream-state', { serverId: voiceServerIdRef.current, channelId: ch, camera: !!camera, screen: !!screen, genres: userSettings?.gamingProfile?.genres || [] })
  }

  // Promote the popup preview to the live call — what you previewed is exactly what goes live,
  // with no re-acquire flicker (same raw stream + processor + output track).
  const goLiveWithCamera = () => {
    const out = outputTrackRef.current
    if (!out) return
    out.onended = () => stopCamera()
    setLocalVideoTrack(out)
    setScreenSharing(false)
    setVideoOn(true)
    setShowEffectsMenu(false)
    setPreviewStream(null) // popup closes; the track keeps running in localStream/peers
    emitStreamState(true, false)
  }

  // Keep a live self-preview (with the selected effect) running whenever the popup is open and the
  // camera is off. When it closes without going live, tear the preview down.
  useEffect(() => {
    const wantPreview = (showEffectsMenu && !videoOn && inVoice) || (showPreJoin && preJoinCamOn)
    if (wantPreview) acquirePreview(selectedCameraId)
    else teardownPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEffectsMenu, videoOn, inVoice, showPreJoin, preJoinCamOn])

  // Camera button handler: if the camera is on, turn it off; otherwise open the preview popup.
  const toggleCamera = async () => {
    if (!localStreamRef.current) return
    if (videoOn) { stopCamera(); return }
    setShowEffectsMenu((v) => !v)
  }

  // Voice gallery paging: total tiles (you + remotes), pages, and the count on the current page.
  const voiceTotalTiles = 1 + new Set([...Object.keys(peerNames), ...Object.keys(remoteStreams)]).size
  const voicePageCount = Math.max(1, Math.ceil(voiceTotalTiles / VOICE_TILES_PER_PAGE))
  const voicePageClamped = Math.min(voicePage, voicePageCount - 1)
  const voicePageTileCount = Math.min(VOICE_TILES_PER_PAGE, voiceTotalTiles - voicePageClamped * VOICE_TILES_PER_PAGE)

  // Keep the page index in range as people join/leave.
  useEffect(() => {
    if (voicePage > voicePageCount - 1) setVoicePage(voicePageCount - 1)
  }, [voicePageCount, voicePage])

  // Fit the CURRENT PAGE's tiles in the call view without scrolling: pick the column count that
  // maximizes tile size for the on-page tile count + container size (Zoom/Meet-style).
  useLayoutEffect(() => {
    if (!inVoice) return
    const el = videoStageRef.current
    if (!el) return
    const GAP = 12
    const ASPECT = 16 / 9
    const compute = () => {
      const n = voicePageTileCount
      const W = el.clientWidth, H = el.clientHeight
      if (!W || !H || n < 1) return
      let best = 1, bestArea = -1
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols)
        const cellW = (W - GAP * (cols - 1)) / cols
        const cellH = (H - GAP * (rows - 1)) / rows
        if (cellW <= 0 || cellH <= 0) continue
        let w = cellW, h = w / ASPECT
        if (h > cellH) { h = cellH; w = h * ASPECT }
        const area = w * h
        if (area > bestArea + 0.5) { bestArea = area; best = cols }
      }
      const rows = Math.ceil(n / best)
      setVoiceGrid((prev) => (prev.cols === best && prev.rows === rows ? prev : { cols: best, rows }))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [inVoice, activeChannel, voicePageTileCount])

  // Upload a custom background cover (kept local as an object URL — not sent to the server).
  const uploadWebcamBackground = (e) => {
    const file = e.target.files && e.target.files[0]
    if (e.target) e.target.value = ''
    if (!file) return
    if (customBgUrl) { try { URL.revokeObjectURL(customBgUrl) } catch (err) {} }
    const url = URL.createObjectURL(file)
    setCustomBgUrl(url)
    setBgCoverId('custom')
    chooseEffect('custom', url)
  }

  // Start screen sharing at a chosen quality preset (constraints + a sender bitrate cap).
  const startScreenShare = async (qualityId) => {
    setShowQualityMenu(false)
    if (!localStreamRef.current) return
    const q = SCREEN_QUALITIES.find((x) => x.id === qualityId) || SCREEN_QUALITIES[1]
    const video = { frameRate: { ideal: q.frameRate } }
    if (q.width) { video.width = { ideal: q.width }; video.height = { ideal: q.height } }
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video, audio: false })
      const track = disp.getVideoTracks()[0]
      if (!track) return
      track.onended = () => stopScreenShare() // user hit the browser/OS "stop sharing"
      setLocalVideoTrack(track)
      applyVideoBitrate(q.bitrate)
      setScreenQuality(qualityId)
      setVideoOn(false)
      setScreenSharing(true)
      socket?.emit('voice:screenshare-state', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', sharing: true })
      emitStreamState(false, true)
    } catch (err) {
      // Picker cancelled or permission denied — no-op.
    }
  }

  const stopScreenShare = () => {
    setLocalVideoTrack(null)
    setScreenSharing(false)
    socket?.emit('voice:screenshare-state', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', sharing: false })
    emitStreamState(false, false)
  }

  // Mute/unmute the local mic (footer button + in-call control share this). Toggles the audio
  // track's enabled flag when in a call; the state persists as the user's preference otherwise.
  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0]
    const next = track ? track.enabled : !micMuted // if enabled, we're muting → next=true
    if (track) track.enabled = !next
    setMicMuted(next)
    if (!next && deafened) setDeafened(false) // unmuting while deafened undeafens (Discord-like)
  }

  // Deafen: silence everyone else's audio (remote tiles are muted via the `deafened` prop) AND
  // self-mute, like Discord. Undeafening restores the mic to whatever it was before deafening.
  const prevMicMutedRef = useRef(false)
  const toggleDeafen = () => {
    const track = localStreamRef.current?.getAudioTracks()[0]
    setDeafened((d) => {
      const next = !d
      if (next) {
        prevMicMutedRef.current = micMuted
        if (track) track.enabled = false
        setMicMuted(true)
      } else {
        const restore = prevMicMutedRef.current
        if (track) track.enabled = !restore
        setMicMuted(restore)
      }
      return next
    })
  }

  // Speaker (output) selection is only supported where HTMLMediaElement.setSinkId exists (Chromium).
  const supportsSpeakerSelect = typeof document !== 'undefined' && typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

  // Enumerate audio devices for the mic/speaker picker. Labels require an active permission, which
  // we already have (the user is in a call) — we never enumerate/access devices outside a call.
  const loadAudioDevices = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      setAudioInputs(devs.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })))
      setAudioOutputs(devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Speaker' })))
      const cur = localStreamRef.current?.getAudioTracks()[0]?.getSettings?.().deviceId
      if (cur) setSelectedMicId(cur)
    } catch (e) { /* ignore */ }
  }

  // Switch the microphone: grab the new device and replaceTrack on every peer (no renegotiation),
  // preserving the current mute state.
  const changeMic = async (deviceId) => {
    setSelectedMicId(deviceId)
    if (!localStreamRef.current) return
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      const nt = s.getAudioTracks()[0]
      if (!nt) return
      nt.enabled = !micMuted // honor the current mute state
      Object.values(peersRef.current).forEach(({ pc }) => {
        const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'audio')
        if (sender) sender.replaceTrack(nt).catch(() => {})
      })
      const ls = localStreamRef.current
      const old = ls.getAudioTracks()[0]
      if (old) { old.stop(); ls.removeTrack(old) }
      ls.addTrack(nt)
      setLocalStream(new MediaStream(ls.getTracks()))
    } catch (e) {
      setEffectsError('Could not switch microphone')
    }
  }

  // Switch the speaker/output — applied to every remote tile's <video> via the sinkId prop.
  const changeSpeaker = (deviceId) => setSelectedSpeakerId(deviceId)

  const leaveVoice = () => {
    // Never let a bad emit block the local teardown — always tear the call down.
    const chId = typeof voiceChannelId === 'string' ? voiceChannelId : 'voice1'
    try { socket?.emit('voice:leave', { serverId: voiceServerIdRef.current, channelId: chId }) } catch (err) { console.warn('voice:leave emit failed', err) }
    Object.keys(peersRef.current).forEach(removePeer)
    peersRef.current = {}
    setRemoteStreams({})
    try { effectsRef.current?.stop() } catch (e) {}
    effectsRef.current = null
    if (rawCamStreamRef.current) { rawCamStreamRef.current.getTracks().forEach((t) => t.stop()); rawCamStreamRef.current = null }
    if (outputTrackRef.current) { try { outputTrackRef.current.stop() } catch (e) {} outputTrackRef.current = null }
    setPreviewStream(null)
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach((t) => t.stop()); localStreamRef.current = null }
    setLocalStream(null)
    setVideoOn(false)
    setScreenSharing(false)
    setShowEffectsMenu(false)
    setShowQualityMenu(false)
    setShowAudioMenu(false)
    setShowActivityMenu(false)
    setActivity(null)
    setVoicePage(0)
    setPeerNames({})
    setScreenSharingPeers({})
    setFullscreenStream(null)
    setInVoice(false)
    setVoiceChannelId(null)
    setVoiceRailTarget(null)
  }

  const handleSignOut = () => {
    if (socket) {
      try { socket.disconnect() } catch (e) { console.warn(e) }
    }
    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach(t => t.stop()) } catch (e) {}
      localStreamRef.current = null
    }
    setSocket(null)
    socketRef.current = null
    restoredViewRef.current = false
    viewPersistenceReadyRef.current = false
    setIsAuthenticated(false)
    setToken(null)
    setName('')
    setUserEmail('')
    setServerState(null)
    setMessages([])
    localStorage.removeItem('lanparty_token')
    localStorage.removeItem('lanparty_user')
    localStorage.removeItem(VIEW_STATE_KEY)
    setShowMembersPanel(false)
    setShowSettingsPanel(false)
    setInVoice(false)
    setVoiceRailTarget(null)
    setFriends([])
    setPendingFriendRequests([])
    setPendingFriendCount(0)
    setOutgoingFriendRequests([])
    setDmConversations([])
    setGroupChats([])
    setTotalUnreadMessages(0)
    setUnreadByChatId({})
    setGroupUnread({})
    setShowNewChatModal(false)
    setNewChatSelectedIds([])
    setNewChatGroupName('')
    setPendingFile(null)
    setUploadError(null)
    closeAddFriendModal()
  }

  const confirmSignOut = async () => {
    // attempt server-side logout (revoke token) but always clear local state
    try {
      if (token) {
        await fetch(`${SERVER_URL}/auth/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } })
      }
    } catch (err) { console.warn('Logout request failed', err) }
    setShowSignOutConfirm(false)
    handleSignOut()
  }

  const serverName = serverState?.server?.name || 'LAN Party'
  const isHomeView = selectedServerId === 'home'
  // Channels of the server on screen; the active channel's type drives which panel renders.
  const serverChannels = serverState?.server?.channels || []
  const activeChannelObj = serverChannels.find((c) => c.id === activeChannel)
  const activeChannelType = activeChannelObj ? activeChannelObj.type : 'text'
  const activeChannelName = activeChannelObj?.name || activeChannel
  const showHomeChat = isHomeView && homeChat
  const showMembersButton = !isHomeView || (Boolean(showHomeChat) && homeChat?.type === 'group')
  const activeGroupChat = showHomeChat && homeChat?.type === 'group'
    ? (groupChats.find((group) => String(group.id) === String(homeChat.id)) || homeChat)
    : null
  const groupParticipants = (() => {
    if (!activeGroupChat) return []
    const source = Array.isArray(activeGroupChat.participants) ? activeGroupChat.participants : []
    const map = new Map()
    source.forEach((participant, index) => {
      const participantId = String(participant?.id ?? participant?.name ?? `group-member-${index}`)
      const participantName = participant?.name || participant?.peerUsername
      if (!participantName || map.has(participantId)) return
      map.set(participantId, {
        id: participantId,
        name: participantName,
        isYou: participantName === name || participant?.peerUsername === name,
      })
    })
    if (name && !Array.from(map.values()).some((participant) => participant.isYou)) {
      map.set(`self-${name}`, { id: `self-${name}`, name, isYou: true })
    }
    return Array.from(map.values())
  })()
  const serverMembers = (serverState?.members || []).map((member, index) => {
    const memberName = member.username || member.name || `Member ${index + 1}`
    return {
      id: String(member.id ?? member.username ?? member.name ?? `server-member-${index}`),
      name: memberName,
      isYou: member.id === socket?.id || member.username === name || memberName === name,
    }
  })
  const membersPanelUsers = isHomeView ? groupParticipants : serverMembers

  const clearPendingAttachment = () => {
    setPendingFile(null)
    setUploadError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openNewChatModal = () => {
    setNewChatSelectedIds([])
    setNewChatGroupName('')
    setShowNewChatModal(true)
    setLeftNav('messages')
  }

  const closeNewChatModal = () => {
    setShowNewChatModal(false)
    setNewChatSelectedIds([])
    setNewChatGroupName('')
  }

  const toggleNewChatUser = (id) => {
    setNewChatSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const newChatUsers = (() => {
    const map = new Map()
    const add = (user) => {
      if (!user?.id || !user?.name) return
      const id = String(user.id)
      if (!map.has(id)) {
        map.set(id, {
          id,
          name: user.name,
          peerUsername: user.peerUsername || user.name,
          avatar: user.avatar,
          status: user.status || 'available',
        })
      }
    }
    friends.forEach(add)
    dmConversations.forEach(add)
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  })()

  const createNewChat = () => {
    const selectedUsers = newChatSelectedIds
      .map((id) => newChatUsers.find((user) => String(user.id) === String(id)))
      .filter(Boolean)
    if (selectedUsers.length === 0) return
    setSelectedServerId('home')
    setLeftNav('messages')
    clearPendingAttachment()
    if (selectedUsers.length === 1) {
      openPeerChat('dm', selectedUsers[0])
      closeNewChatModal()
      return
    }
    const group = {
      id: `group-${Date.now()}`,
      name: newChatGroupName.trim(),
      avatar: '#5865f2',
      preview: `${selectedUsers.length} members`,
      participants: selectedUsers,
    }
    setGroupChats((prev) => [group, ...prev])
    setSelectedGroupId(group.id)
    setSelectedFriendId(null)
    setSelectedDmId(null)
    setHomeChat({ type: 'group', id: group.id, name: group.name, participants: selectedUsers })
    setHomeMessages((prev) => ({ ...prev, [group.id]: prev[group.id] || [] }))
    closeNewChatModal()
  }

  const acceptPendingFile = (file) => {
    setUploadError(null)
    if (!file) return false
    if (file.size > MAX_FILE_SIZE) {
      setPendingFile(null)
      setUploadError('File is larger than 100 MB.')
      return false
    }
    setPendingFile(file)
    return true
  }

  const handleFileSelection = (event) => {
    const ok = acceptPendingFile(event.target.files?.[0])
    if (!ok && event.target) event.target.value = ''
  }

  // Pasting an image (e.g. screenshot or copied image) into the composer attaches it.
  const handleComposerPaste = (event) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          event.preventDefault()
          acceptPendingFile(file)
          return
        }
      }
    }
  }

  // Open the pending (not-yet-sent) attachment in the media viewer.
  const openPendingPreview = () => {
    if (!pendingFile || !pendingPreviewUrl) return
    setLightbox({
      items: [{ attachment: { url: pendingPreviewUrl, name: pendingFile.name, type: pendingFile.type }, url: pendingPreviewUrl, kind: mediaKind(pendingFile) }],
      index: 0,
    })
  }

  const uploadSelectedFile = async () => {
    if (!pendingFile) return null
    if (!token) throw new Error('You must be signed in to upload files.')
    const formData = new FormData()
    formData.append('file', pendingFile)
    const res = await fetch(`${SERVER_URL}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed')
    return data.attachment
  }

  const applyReactionToMessage = (message, emoji) => {
    const reactions = { ...(message.reactions || {}) }
    const current = reactions[emoji] || { count: 0, mine: false }
    if (current.mine) {
      const nextCount = Math.max(0, current.count - 1)
      if (nextCount === 0) delete reactions[emoji]
      else reactions[emoji] = { count: nextCount, mine: false }
    } else {
      reactions[emoji] = { count: current.count + 1, mine: true }
    }
    return { ...message, reactions }
  }

  const reactToHomeMessage = (messageId, emoji) => {
    if (!homeChat || !messageId) return
    const chatKey = chatStorageKey(homeChat.id)
    // Optimistic update; DMs persist server-side (reaction:updated reconciles), groups stay local.
    setHomeMessages((prev) => ({
      ...prev,
      [chatKey]: (prev[chatKey] || []).map((message) =>
        String(message.id) === String(messageId) ? applyReactionToMessage(message, emoji) : message
      ),
    }))
    if ((homeChat.type === 'friend' || homeChat.type === 'dm') && socket) {
      socket.emit('reaction:toggle', { scope: 'dm', messageId, emoji })
    }
  }

  const reactToChannelMessage = (messageId, emoji) => {
    if (!messageId) return
    setMessages((prev) =>
      prev.map((message) =>
        String(message.id) === String(messageId) ? applyReactionToMessage(message, emoji) : message
      )
    )
    if (socket) socket.emit('reaction:toggle', { scope: 'channel', messageId, emoji })
  }

  // ---- Collaborative image editing ----
  // Session is keyed by the (absolute) image URL, so anyone opening the same image collaborates.
  const startCollab = (imageUrl) => {
    if (!imageUrl || !socket) return
    setCollab({ sessionId: imageUrl, imageUrl })
    setCollabInvite(null)
    socket.emit('collab:join', { sessionId: imageUrl, imageUrl })
    if (!showHomeChat) socket.emit('collab:start', { serverId: currentServerId(), channelId: activeChannel, sessionId: imageUrl, imageUrl })
  }
  const joinCollab = (invite) => {
    if (!invite?.sessionId || !socket) return
    setCollab({ sessionId: invite.sessionId, imageUrl: invite.imageUrl })
    setCollabInvite(null)
    socket.emit('collab:join', { sessionId: invite.sessionId, imageUrl: invite.imageUrl })
  }
  const closeCollab = () => {
    if (collab && socket) socket.emit('collab:leave', { sessionId: collab.sessionId })
    setCollab(null)
  }
  const sendCollabStroke = (segment) => {
    if (collab && socket) socket.emit('collab:draw', { sessionId: collab.sessionId, segment })
  }
  const clearCollab = () => {
    if (collab && socket) socket.emit('collab:clear', { sessionId: collab.sessionId })
    collabCanvasRef.current?.clearCanvas()
  }

  // Send an image/media attachment to the current channel or DM/group (shared by collab-save).
  const sendMediaMessage = async (attachment) => {
    if (showHomeChat && homeChat) {
      if (homeChat.type === 'friend' || homeChat.type === 'dm') {
        const peerUsername = homeChat.peerUsername || homeChat.name
        try {
          const res = await fetch(`${SERVER_URL}/messages/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ toUsername: peerUsername, text: '', attachment }),
          })
          const data = await res.json()
          if (res.ok) { appendHomeMessage(homeChat.id, data.message); updateDmConversationPreview(homeChat.id, peerUsername, data.message, 0); loadMessagesData() }
        } catch (err) { console.warn('sendMediaMessage', err) }
        return
      }
      const chatKey = homeChat.id
      const msg = { id: `${chatKey}-${Date.now()}`, author: name || 'You', text: '', attachment, ts: Date.now() }
      setHomeMessages((prev) => ({ ...prev, [chatKey]: oldestMessagesFirst([...(prev[chatKey] || []), msg]) }))
      updateGroupConversationPreview(chatKey, msg)
      return
    }
    if (socket) socket.emit('message', { serverId: currentServerId(), channelId: activeChannel, text: '', attachment })
  }

  // Save the flattened (image + annotations) PNG: upload it and post it to the chat.
  const saveCollab = async (blob) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !blob) return
    try {
      const fd = new FormData()
      fd.append('file', new File([blob], 'edited-image.png', { type: 'image/png' }))
      const res = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      await sendMediaMessage({ url: data.attachment.url, name: 'edited-image.png', type: 'image/png', size: data.attachment.size })
      closeCollab()
    } catch (err) {
      console.warn('saveCollab failed', err)
    }
  }

  const editHomeMessage = (messageId, newText) => {
    if (!homeChat || !messageId) return
    const chatKey = chatStorageKey(homeChat.id)
    setHomeMessages((prev) => ({
      ...prev,
      [chatKey]: (prev[chatKey] || []).map((m) =>
        String(m.id) === String(messageId) ? { ...m, text: newText, edited: true } : m
      ),
    }))
  }

  const editChannelMessage = (messageId, newText) => {
    if (!messageId) return
    setMessages((prev) =>
      prev.map((m) => (String(m.id) === String(messageId) ? { ...m, text: newText, edited: true } : m))
    )
  }

  // Delete a channel message (server verifies ownership, then broadcasts message:deleted).
  const deleteChannelMessage = (messageId) => {
    if (!socket || !messageId) return
    socket.emit('message:delete', { serverId: currentServerId(), channelId: activeChannel, id: messageId })
  }

  // Delete a home-chat message. DMs are persisted (server DELETE + broadcast); groups are local.
  const deleteHomeMessage = async (messageId) => {
    if (!homeChat || !messageId) return
    const chatKey = chatStorageKey(homeChat.id)
    if (homeChat.type === 'friend' || homeChat.type === 'dm') {
      const t = token || localStorage.getItem('lanparty_token')
      try {
        const res = await fetch(`${SERVER_URL}/messages/${encodeURIComponent(messageId)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${t}` },
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed') }
        setHomeMessages((prev) => ({ ...prev, [chatKey]: (prev[chatKey] || []).filter((m) => String(m.id) !== String(messageId)) }))
        loadMessagesData()
      } catch (err) {
        console.warn('deleteHomeMessage', err)
      }
      return
    }
    // Group messages are local-only.
    setHomeMessages((prev) => ({ ...prev, [chatKey]: (prev[chatKey] || []).filter((m) => String(m.id) !== String(messageId)) }))
  }

  const openPeerChat = (type, item) => {
    const peerUsername = item.peerUsername || item.name
    const chatId = chatStorageKey(item.id)
    // Capture unread count before it's cleared so the scroll lands on the first unread message.
    pendingUnreadScrollRef.current = unreadByChatId[chatId] || 0
    setShowMembersPanel(false)
    clearPendingAttachment()
    setHomeChat({ type, id: chatId, name: item.name, peerUsername })
    if (type === 'friend') {
      setSelectedFriendId(item.id)
      setSelectedDmId(null)
    } else if (type === 'dm') {
      setSelectedDmId(item.id)
      setSelectedFriendId(null)
    }
    setSelectedGroupId(null)
    if (type === 'friend' || type === 'dm') {
      loadHomeChatHistory(peerUsername, chatId)
    }
    if (type === 'group') {
      setGroupUnread((prev) => {
        if (!prev[item.id]) return prev
        const next = { ...prev }
        delete next[item.id]
        return next
      })
    }
  }

  const handleSelectFriend = (friend) => {
    openPeerChat('friend', { ...friend, peerUsername: friend.name })
  }

  const handleSelectDm = (dm) => {
    openPeerChat('dm', { ...dm, peerUsername: dm.peerUsername || dm.name })
  }

  const handleSelectGroup = (group) => {
    pendingUnreadScrollRef.current = groupUnread[group.id] || 0
    setShowMembersPanel(false)
    clearPendingAttachment()
    setSelectedGroupId(group.id)
    setSelectedFriendId(null)
    setSelectedDmId(null)
    setHomeChat({ type: 'group', id: group.id, name: group.name })
    setGroupUnread((prev) => {
      if (!prev[group.id]) return prev
      const next = { ...prev }
      delete next[group.id]
      return next
    })
  }

  const sendHomeMessage = async () => {
    if ((!text.trim() && !pendingFile) || !homeChat) return
    const body = text.trim()
    setText('')
    setShowEmojiPicker(false)
    setUploadError(null)
    setUploadingFile(true)
    let attachment = null
    try {
      attachment = await uploadSelectedFile()
    } catch (err) {
      setUploadError(err.message)
      setText(body)
      setUploadingFile(false)
      return
    }
    if (homeChat.type === 'friend' || homeChat.type === 'dm') {
      const peerUsername = homeChat.peerUsername || homeChat.name
      try {
        const res = await fetch(`${SERVER_URL}/messages/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ toUsername: peerUsername, text: body, attachment }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Send failed')
        appendHomeMessage(homeChat.id, data.message)
        updateDmConversationPreview(homeChat.id, peerUsername, data.message, 0)
        clearPendingAttachment()
        loadMessagesData()
      } catch (err) {
        console.warn('sendHomeMessage', err)
        setUploadError(err.message)
        setText(body)
      } finally {
        setUploadingFile(false)
      }
      return
    }
    const chatKey = homeChat.id
    const msg = { id: `${chatKey}-${Date.now()}`, author: name || 'You', text: body, attachment, ts: Date.now() }
    setHomeMessages((prev) => ({
      ...prev,
      [chatKey]: oldestMessagesFirst([...(prev[chatKey] || []), msg]),
    }))
    updateGroupConversationPreview(chatKey, msg)
    clearPendingAttachment()
    setUploadingFile(false)
  }

  const homeChatMessages = homeChat ? homeMessages[chatStorageKey(homeChat.id)] || [] : []
  // name -> url lookup for rendering :shortcode: custom emojis in chat (personal + all servers).
  const emojiMap = (() => {
    const map = {}
    for (const list of Object.values(serverEmojis)) for (const c of list) map[c.name] = c.url
    for (const c of customEmojis) map[c.name] = c.url // personal takes precedence
    return map
  })()
  const topbarChannelLabel = showHomeChat
    ? homeChat.type === 'group'
      ? homeChat.name
      : `@ ${homeChat.name}`
    : `# ${activeChannelName}`
  const topbarServerLabel = showHomeChat
    ? homeChat.type === 'group'
      ? 'Group Message'
      : 'Direct Message'
    : serverName
  // Topbar order: serverLabel first, then channelLabel
  //   channel -> "LAN Party"      "# general"
  //   dm      -> "Direct Message" "@ name"
  //   group   -> "Group Message"  "group name"

  // Open the media viewer at the clicked attachment within a given message list.
  const openLightbox = (sourceMessages, attachment) => {
    const items = collectMediaList(sourceMessages)
    const url = attachmentUrl(attachment)
    const index = Math.max(0, items.findIndex((item) => item.url === url))
    if (!items.length) return
    setLightbox({ items, index })
  }
  const closeLightbox = () => setLightbox(null)
  const navigateLightbox = (delta) => {
    setLightbox((prev) => {
      if (!prev) return prev
      const count = prev.items.length
      const index = ((prev.index + delta) % count + count) % count
      return { ...prev, index }
    })
  }

  // Persist a partial change to the user's settings without disturbing the rest.
  const patchUserSettings = async (patch) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const cur = await fetch(`${SERVER_URL}/user/settings`, { headers: { Authorization: `Bearer ${t}` } })
      const curData = cur.ok ? await cur.json() : { settings: {} }
      const merged = { ...(curData.settings || {}), ...patch }
      await fetch(`${SERVER_URL}/user/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ settings: merged }),
      })
    } catch (err) {
      console.warn('patchUserSettings failed', err)
    }
  }

  // Insert text (an emoji or :shortcode:) into the composer at the caret.
  const insertIntoComposer = (insert) => {
    setText((prev) => `${prev}${insert}`)
  }

  const handleSelectEmoji = (emoji) => {
    insertIntoComposer(emoji)
  }

  const handleSelectCustomEmoji = (custom) => {
    insertIntoComposer(`:${custom.name}:`)
  }

  const handleSetEmojiSkinTone = (base, toneKey) => {
    setEmojiSkinTones((prev) => {
      const next = { ...prev }
      if (toneKey === 'default') delete next[base]
      else next[base] = toneKey
      patchUserSettings({ emojiSkinTones: next })
      return next
    })
  }

  // Turn a filename into a unique :shortcode: slug.
  const makeEmojiName = (filename, existing) => {
    let base = (filename || 'emoji').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'emoji'
    let name = base
    let n = 1
    const taken = new Set(existing.map((c) => c.name))
    while (taken.has(name)) name = `${base}_${n++}`
    return name
  }

  const addCustomEmoji = (url, suggestedName) => {
    setCustomEmojis((prev) => {
      if (prev.some((c) => c.url === url)) return prev
      const name = makeEmojiName(suggestedName, prev)
      const next = [...prev, { name, url }]
      patchUserSettings({ customEmojis: next })
      return next
    })
  }

  const deletePersonalEmoji = (name) => {
    setCustomEmojis((prev) => {
      const next = prev.filter((c) => c.name !== name)
      patchUserSettings({ customEmojis: next })
      return next
    })
  }

  // Upload a personal emoji. `name` is the user-provided shortcode (validated/uniquified here).
  const handleUploadCustomEmoji = async (file, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !file) return
    if (file.size > MAX_FILE_SIZE) { setUploadError('File is larger than 100 MB.'); return }
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${SERVER_URL}/files/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      addCustomEmoji(data.attachment.url, name || file.name)
    } catch (err) {
      setUploadError(err.message)
    }
  }

  // Save a custom emoji seen in chat (right-click) to the user's personal library.
  const saveCustomEmojiFromChat = (custom) => {
    if (!custom?.url) return
    addCustomEmoji(custom.url, custom.name)
  }

  // Load a server's custom emojis into state.
  const loadServerEmojis = async (serverId) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !serverId) return
    try {
      const res = await fetch(`${SERVER_URL}/servers/${encodeURIComponent(serverId)}/emojis`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return
      const data = await res.json()
      setServerEmojis((prev) => ({ ...prev, [serverId]: data.emojis || [] }))
    } catch (err) {
      console.warn('loadServerEmojis failed', err)
    }
  }

  const handleUploadServerEmoji = async (serverId, file, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !serverId || !file) return
    if (file.size > MAX_FILE_SIZE) { setUploadError('File is larger than 100 MB.'); return }
    try {
      const formData = new FormData()
      formData.append('file', file)
      const up = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData })
      const upData = await up.json()
      if (!up.ok) throw new Error(upData.error || 'Upload failed')
      const res = await fetch(`${SERVER_URL}/servers/${encodeURIComponent(serverId)}/emojis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ url: upData.attachment.url, name: name || file.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add server emoji')
      setServerEmojis((prev) => ({ ...prev, [serverId]: data.emojis || [] }))
    } catch (err) {
      setUploadError(err.message)
    }
  }

  const deleteServerEmoji = async (serverId, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !serverId || !name) return
    try {
      const res = await fetch(`${SERVER_URL}/servers/${encodeURIComponent(serverId)}/emojis/${encodeURIComponent(name)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${t}` },
      })
      const data = await res.json()
      if (res.ok) setServerEmojis((prev) => ({ ...prev, [serverId]: data.emojis || [] }))
    } catch (err) {
      console.warn('deleteServerEmoji failed', err)
    }
  }

  // ---- Shared GIF library ----
  const loadGifs = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const res = await fetch(`${SERVER_URL}/gifs`, { headers: { Authorization: `Bearer ${t}` } })
      if (res.ok) { const data = await res.json(); setGifLibrary(data.gifs || []) }
    } catch (err) {
      console.warn('loadGifs failed', err)
    }
  }

  const uploadGif = async (file, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !file) return
    if (file.size > MAX_FILE_SIZE) { setUploadError('File is larger than 100 MB.'); return }
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (name) formData.append('name', name)
      const res = await fetch(`${SERVER_URL}/gifs`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add GIF')
      setGifLibrary(data.gifs || [])
    } catch (err) {
      setUploadError(err.message)
    }
  }

  const deleteGif = async (id) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !id) return
    try {
      const res = await fetch(`${SERVER_URL}/gifs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
      const data = await res.json()
      if (res.ok) setGifLibrary(data.gifs || [])
    } catch (err) {
      console.warn('deleteGif failed', err)
    }
  }

  // Send a GIF to the current channel or DM/group. Library GIFs (/gifs/, /uploads/) go as an
  // attachment; external Giphy GIFs go as an inline text URL (rendered by mediaFromText).
  const sendGif = async (gif) => {
    if (!gif?.url) return
    setShowEmojiPicker(false)
    const isLocal = gif.url.startsWith('/gifs/') || gif.url.startsWith('/uploads/')
    const attachment = isLocal ? { url: gif.url, name: gif.name || 'gif', type: gif.type || 'image/gif', size: 0 } : null
    const body = isLocal ? '' : gif.url
    if (showHomeChat && homeChat) {
      if (homeChat.type === 'friend' || homeChat.type === 'dm') {
        const peerUsername = homeChat.peerUsername || homeChat.name
        try {
          const res = await fetch(`${SERVER_URL}/messages/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ toUsername: peerUsername, text: body, attachment }),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || 'Send failed')
          appendHomeMessage(homeChat.id, data.message)
          updateDmConversationPreview(homeChat.id, peerUsername, data.message, 0)
          loadMessagesData()
        } catch (err) {
          setUploadError(err.message)
        }
        return
      }
      // Group chats are local-only, mirroring sendHomeMessage.
      const chatKey = homeChat.id
      const msg = { id: `${chatKey}-${Date.now()}`, author: name || 'You', text: body, attachment, ts: Date.now() }
      setHomeMessages((prev) => ({
        ...prev,
        [chatKey]: oldestMessagesFirst([...(prev[chatKey] || []), msg]),
      }))
      updateGroupConversationPreview(chatKey, msg)
      return
    }
    if (socket) socket.emit('message', { serverId: currentServerId(), channelId: activeChannel, text: body, attachment })
  }

  // Is Giphy configured on the server (has an API key)?
  const giphyStatus = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return false
    try {
      const res = await fetch(`${SERVER_URL}/giphy/status`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return false
      const data = await res.json()
      return !!data.configured
    } catch {
      return false
    }
  }

  // Fetch a page of Giphy results (trending when query is empty) via our server proxy.
  // Returns the raw Giphy { data, pagination } shape the SDK <Grid> expects.
  const fetchGiphy = async (query, offset = 0) => {
    const empty = { data: [], pagination: { total_count: 0, count: 0, offset: 0 } }
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return empty
    const q = (query || '').trim()
    const path = q
      ? `/giphy/search?q=${encodeURIComponent(q)}&offset=${offset}`
      : `/giphy/trending?offset=${offset}`
    try {
      const res = await fetch(`${SERVER_URL}${path}`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return empty
      const data = await res.json()
      return { data: data.data || [], pagination: data.pagination || empty.pagination }
    } catch {
      return empty
    }
  }

  // ---- Shared soundboard ----
  useEffect(() => { soundVolumeRef.current = soundVolume }, [soundVolume])

  const loadSounds = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const res = await fetch(`${SERVER_URL}/sounds`, { headers: { Authorization: `Bearer ${t}` } })
      if (res.ok) { const data = await res.json(); setSoundLibrary(data.sounds || []) }
    } catch (err) {
      console.warn('loadSounds failed', err)
    }
  }

  const uploadSound = async (file, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !file) return
    if (file.size > MAX_FILE_SIZE) { setUploadError('File is larger than 100 MB.'); return }
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (name) formData.append('name', name)
      const res = await fetch(`${SERVER_URL}/sounds`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add sound')
      setSoundLibrary(data.sounds || [])
    } catch (err) {
      setUploadError(err.message)
    }
  }

  const deleteSound = async (id) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !id) return
    try {
      const res = await fetch(`${SERVER_URL}/sounds/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
      const data = await res.json()
      if (res.ok) setSoundLibrary(data.sounds || [])
    } catch (err) {
      console.warn('deleteSound failed', err)
    }
  }

  const renameSound = async (id, name) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !id || !name?.trim()) return
    try {
      const res = await fetch(`${SERVER_URL}/sounds/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (res.ok) setSoundLibrary(data.sounds || [])
    } catch (err) {
      console.warn('renameSound failed', err)
    }
  }

  // Stop whatever clip is currently playing (only one plays at a time).
  const stopCurrentSound = () => {
    const cur = currentSoundRef.current
    if (cur?.audio) { try { cur.audio.pause(); cur.audio.currentTime = 0 } catch {} }
    currentSoundRef.current = null
    setPlayingSoundIds([])
  }

  // Play a clip locally, enforcing a single active instance. With { toggle:true } (a pad click),
  // re-selecting the currently-playing clip stops it. Returns 'started' or 'stopped'.
  const playSoundUrl = (url, id, { toggle = false } = {}) => {
    if (!url) return 'stopped'
    if (toggle && currentSoundRef.current && currentSoundRef.current.id === id) {
      stopCurrentSound()
      return 'stopped'
    }
    stopCurrentSound() // always replace any other clip
    try {
      const audio = new Audio(emojiSrc(url))
      audio.volume = Math.max(0, Math.min(1, soundVolumeRef.current))
      const clear = () => { if (currentSoundRef.current?.audio === audio) { currentSoundRef.current = null; setPlayingSoundIds([]) } }
      audio.addEventListener('ended', clear)
      audio.addEventListener('error', clear)
      currentSoundRef.current = { audio, id }
      setPlayingSoundIds(id != null ? [id] : [])
      audio.play().catch(() => clear())
    } catch (err) {
      console.warn('playSoundUrl failed', err)
    }
    return 'started'
  }

  // Triggered by clicking a pad: toggle single-instance playback. When in a voice call, broadcast
  // to the voice room so everyone in the call hears it too (soundboard is voice-only).
  const playSound = (sound) => {
    if (!sound?.url) return
    const result = playSoundUrl(sound.url, sound.id, { toggle: true })
    if (inVoice && socket && voiceChannelId) {
      if (result === 'started') {
        socket.emit('soundboard:play', { serverId: voiceServerIdRef.current, channelId: voiceChannelId, soundId: sound.id, url: sound.url, name: sound.name, emoji: sound.emoji })
      } else {
        socket.emit('soundboard:stop', { serverId: voiceServerIdRef.current, channelId: voiceChannelId })
      }
    }
  }

  // ---- Public app directory ----
  const loadPublicApps = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const res = await fetch(`${SERVER_URL}/apps`, { headers: { Authorization: `Bearer ${t}` } })
      if (res.ok) { const data = await res.json(); setPublicApps(data.apps || []) }
    } catch (err) {
      console.warn('loadPublicApps failed', err)
    }
  }

  const openAppDirectory = () => { setShowAppDirectory(true); loadPublicApps() }

  // Upload an app to the public directory (optionally with an icon image).
  const uploadApp = async ({ name, description, url, iconFile }) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) throw new Error('You must be signed in.')
    let iconUrl = ''
    if (iconFile) {
      if (iconFile.size > MAX_FILE_SIZE) throw new Error('Icon is larger than 100 MB.')
      const fd = new FormData()
      fd.append('file', iconFile)
      const up = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const upData = await up.json()
      if (!up.ok) throw new Error(upData.error || 'Icon upload failed')
      iconUrl = upData.attachment.url
    }
    const res = await fetch(`${SERVER_URL}/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ name, description, url, iconUrl }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to publish app')
    setPublicApps(data.apps || [])
  }

  // Custom emojis for the server currently on screen.
  const serverEmojiGroups = serverState?.server
    ? [{ serverId: serverState.server.id, serverName: serverState.server.name || 'Server', emojis: serverEmojis[serverState.server.id] || [] }]
    : []

  const renderComposer = (placeholder, onSend) => {
    const canSend = Boolean(text.trim() || pendingFile) && !uploadingFile
    // Treat the selected File like an attachment for type detection (File has .type and .name).
    const pendingIsGif = pendingFile && isGifAttachment(pendingFile)
    const pendingIsImage = pendingFile && !pendingIsGif && isImageAttachment(pendingFile)
    const pendingIsVideo = pendingFile && isVideoAttachment(pendingFile)
    const pendingHasMedia = pendingIsGif || pendingIsImage || pendingIsVideo
    return (
      <div className="composer">
        {pendingFile && (
          <div className={`pending-attachment${pendingHasMedia ? ' pending-attachment-media' : ''}`}>
            {pendingHasMedia && pendingPreviewUrl && (
              <button
                type="button"
                className="pending-attachment-thumb"
                onClick={openPendingPreview}
                title="Click to preview"
                aria-label="Preview attached image"
              >
                {pendingIsVideo
                  ? <video src={pendingPreviewUrl} muted preload="metadata" />
                  : <img src={pendingPreviewUrl} alt={pendingFile.name} />}
              </button>
            )}
            <span className="pending-attachment-name">{pendingFile.name}</span>
            <span className="pending-attachment-size">{formatFileSize(pendingFile.size)}</span>
            <button type="button" onClick={clearPendingAttachment} aria-label="Remove attached file">x</button>
          </div>
        )}
        {uploadError && <div className="composer-error">{uploadError}</div>}
        {showEmojiPicker && (
          <EmojiPicker
            personalEmojis={customEmojis}
            serverEmojiGroups={serverEmojiGroups}
            gifs={gifLibrary}
            skinTones={emojiSkinTones}
            resolveSrc={emojiSrc}
            onSelectEmoji={handleSelectEmoji}
            onSelectCustom={handleSelectCustomEmoji}
            onSelectGif={sendGif}
            onFetchGiphy={fetchGiphy}
            onGiphyStatus={giphyStatus}
            onSetSkinTone={handleSetEmojiSkinTone}
            onUploadPersonal={handleUploadCustomEmoji}
            onUploadServer={handleUploadServerEmoji}
            onUploadGif={uploadGif}
            onDeletePersonal={deletePersonalEmoji}
            onDeleteServer={deleteServerEmoji}
            onDeleteGif={deleteGif}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        <div className="composer-inner">
          <button type="button" className="attach" onClick={() => fileInputRef.current?.click()} title="Attach file" aria-label="Attach file">
            <PaperclipIcon />
          </button>
          <button type="button" className="attach emoji-toggle" onClick={() => { setShowEmojiPicker((open) => { if (!open) { loadServerEmojis(currentServerId()); loadGifs(); } return !open }) }} title="Emoji & GIF" aria-label="Emoji & GIF" aria-expanded={showEmojiPicker}>
            <span style={{fontSize:22,lineHeight:1}}>😊</span>
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter') onSend() }}
            onPaste={handleComposerPaste}
          />
          <button className="send" onClick={onSend} disabled={!canSend} aria-disabled={!canSend}>
            {uploadingFile ? 'Uploading...' : <SendIcon />}
          </button>
          <input ref={fileInputRef} className="file-input" type="file" onChange={handleFileSelection} />
        </div>
      </div>
    )
  }

  // Password requirement checks for register form (used by left-side checklist)
  const pwHasLen = regPassword.length >= 8
  const pwHasLower = /[a-z]/.test(regPassword)
  const pwHasUpper = /[A-Z]/.test(regPassword)
  const pwHasNum = /\d/.test(regPassword)
  const pwHasSym = /[^A-Za-z0-9]/.test(regPassword)
  const pwItems = [
    { ok: pwHasLen, text: 'At least 8 characters' },
    { ok: pwHasLower, text: 'Lowercase letter' },
    { ok: pwHasUpper, text: 'Uppercase letter' },
    { ok: pwHasNum, text: 'Number' },
    { ok: pwHasSym, text: 'Special character' }
  ]

  const isEmailValid = Boolean(regEmail && /\S+@\S+\.\S+/.test(regEmail))
  const passwordValid = !validatePassword(regPassword) // true when strong
  // Enable Create Account on client-verifiable rules only. Availability is advisory:
  // block only when we KNOW a field is taken (=== false / field error), never on "unknown".
  const canCreate =
    Boolean(regUsername.trim()) &&
    isEmailValid &&
    Boolean(regPassword) &&
    passwordValid &&
    regPassword === regPasswordConfirm &&
    !authLoading &&
    regUsernameAvailable !== false &&
    regEmailAvailable !== false &&
    !regUsernameError &&
    !regEmailError;

  return (
    <div className="app">

      <AppLeftPane
        displayName={name}
        profile={profile}
        resolveAvatarSrc={emojiSrc}
        onOpenAppDirectory={openAppDirectory}
        onOpenDiscover={openDiscover}
        liveCount={discoverStreams.length}
        connected={connected}
        inVoice={inVoice}
        voiceRailTarget={voiceRailTarget}
        micMuted={micMuted}
        deafened={deafened}
        onToggleMic={toggleMute}
        onToggleDeafen={toggleDeafen}
        onOpenSettings={() => { setShowStatusMenu(false); openSettings() }}
        userStatus={userStatus}
        showStatusMenu={showStatusMenu}
        onToggleStatusMenu={() => setShowStatusMenu((open) => !open)}
        onSelectStatus={(status) => { saveUserPresence(status); setShowStatusMenu(false) }}
        activeNav={leftNav}
        onNavChange={setLeftNav}
        onSelectFriend={handleSelectFriend}
        selectedFriendId={selectedFriendId}
        onSelectDm={handleSelectDm}
        selectedDmId={selectedDmId}
        onSelectGroup={handleSelectGroup}
        selectedGroupId={selectedGroupId}
        onCreateMessage={openNewChatModal}
        onFriendVoiceChat={() => openPreJoin('voice1')}
        onFriendViewProfile={() => openSettings()}
        friends={friends}
        pendingFriendRequests={pendingFriendRequests}
        pendingFriendCount={pendingFriendCount}
        outgoingFriendRequests={outgoingFriendRequests}
        onOpenAddFriend={openAddFriendModal}
        onAcceptFriendRequest={acceptFriendRequest}
        onDeclineFriendRequest={declineFriendRequest}
        onCancelOutgoingFriendRequest={cancelOutgoingFriendRequest}
        dmConversations={dmConversations}
        groupConversations={groupChats}
        totalUnreadMessages={totalUnreadWithGroups}
        unreadByChatId={unreadByChatId}
        groupUnread={groupUnread}
        selectedServerId={selectedServerId}
        onSelectServer={handleSelectServer}
        variant={selectedServerId === 'home' ? 'home' : 'server'}
        serverName={serverName}
        servers={serversList}
        channels={serverChannels}
        serverId={selectedServerId}
        onCreateServer={createServer}
        onCreateChannel={createChannel}
        onRenameServer={renameServer}
        onDeleteServer={deleteServer}
        onRenameChannel={renameChannel}
        onDeleteChannel={deleteChannel}
        activeChannel={activeChannel}
        onJoinChannel={joinChannel}
        voiceChannelId={voiceChannelId}
        voiceServerId={inVoice ? voiceServerIdRef.current : null}
        onJoinVoice={joinVoiceChannel}
        onLeaveVoice={leaveVoice}
        members={serverState?.members || []}
        socketId={socket?.id}
      />

      <div className="main">
            <div className="topbar">
              <div className="topbar-inner" style={{justifyContent:'space-between'}}>
                  <div className="topbar-left" style={{display:'flex',gap:12,alignItems:'center'}}>
                    <div className="topbar-server">{topbarServerLabel}</div>
                    <div className="topbar-channel">{topbarChannelLabel}</div>
                  </div>

                  <div className="topbar-right" style={{display:'flex',gap:8,alignItems:'center'}}>
                    <button className="create-app-btn" onClick={() => {
                      if (deferredPrompt) {
                        deferredPrompt.prompt()
                        deferredPrompt.userChoice.then(choice => {
                          console.log('PWA choice', choice)
                          setDeferredPrompt(null)
                        })
                      } else {
                        setShowInstallPanel(true)
                      }
                    }}>Create Application</button>
                    {showMembersButton && (
                      <button className="members-btn" onClick={() => setShowMembersPanel(true)}>Members</button>
                    )}
                  </div>
                </div>
            </div>

        <div className="content-area">
          {showHomeChat && (
            <>
              <div ref={messagesListRef} className={`${homeChatMessages.length === 0 ? 'messages empty' : 'messages'} flow-${messageFlow}`}>
                {homeChatMessages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">@</div>
                    <div className="empty-title">No messages yet</div>
                    <div className="empty-sub">Say hello to {homeChat.name}!</div>
                  </div>
                ) : (
                  homeChatMessages.map((m, i) => (
                    <ChatMessage
                      key={m.id ?? `${m.ts}-${i}`}
                      message={m}
                      currentUser={name}
                      onReact={reactToHomeMessage}
                      onEdit={editHomeMessage}
                      onDelete={deleteHomeMessage}
                      onCollab={startCollab}
                      activeReactionMessageId={activeReactionMessageId}
                      setActiveReactionMessageId={setActiveReactionMessageId}
                      onOpenMedia={(attachment) => openLightbox(homeChatMessages, attachment)}
                      emojiMap={emojiMap}
                      onSaveEmoji={saveCustomEmojiFromChat}
                    />
                  ))
                )}
              </div>

              {renderComposer(`Message ${homeChat.name}`, sendHomeMessage)}
            </>
          )}

          {!showHomeChat && isHomeView && (
            <div className="messages empty">
              <div className="empty-state">
                <div className="empty-icon">@</div>
                <div className="empty-title">Welcome home</div>
                <div className="empty-sub">Pick a friend or message from the left to start chatting.</div>
              </div>
            </div>
          )}

          {!isHomeView && activeChannelType === 'text' && (
            <>
              <div ref={messagesListRef} className={`${messages.length === 0 ? 'messages empty' : 'messages'} flow-${messageFlow}`}>
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">#</div>
                    <div className="empty-title">No messages yet</div>
                    <div className="empty-sub">Be the first to say something!</div>
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <ChatMessage
                      key={m.id ?? `${m.ts}-${i}`}
                      message={m}
                      currentUser={name}
                      onReact={reactToChannelMessage}
                      onEdit={editChannelMessage}
                      onDelete={deleteChannelMessage}
                      onCollab={startCollab}
                      activeReactionMessageId={activeReactionMessageId}
                      setActiveReactionMessageId={setActiveReactionMessageId}
                      onOpenMedia={(attachment) => openLightbox(messages, attachment)}
                      emojiMap={emojiMap}
                      onSaveEmoji={saveCustomEmojiFromChat}
                    />
                  ))
                )}
              </div>

              {renderComposer(`Message #${activeChannelName}`, sendMessage)}
            </>
          )}

          {!isHomeView && activeChannelType === 'voice' && (
            <div className={`voice-panel${inVoice ? ' in-call' : ''}`}>
              {!inVoice ? (
                <div className="voice-join-wrap">
                  <button onClick={() => openPreJoin(activeChannel)} className="voice-btn">Join Voice</button>
                </div>
              ) : (() => {
                // Everyone in the room (from the server roster), whether or not their stream has
                // connected yet — so all participants show, with an avatar until video arrives.
                const participantIds = Array.from(new Set([...Object.keys(peerNames), ...Object.keys(remoteStreams)]))
                const tiles = [
                  { key: 'self', stream: localStream, label: `${name || 'You'} (you)`, muted: true, isScreen: screenSharing },
                  ...participantIds.map((id) => ({ key: id, stream: remoteStreams[id] || null, label: peerNames[id] || 'Guest', muted: deafened, sinkId: selectedSpeakerId, isScreen: !!screenSharingPeers[id] })),
                ]
                const start = voicePageClamped * VOICE_TILES_PER_PAGE
                const pageTiles = tiles.slice(start, start + VOICE_TILES_PER_PAGE)
                return (
                  <>
                    <div className="video-stage-wrap">
                      {activity ? (
                        <ActivityPanel activity={activity} me={name} onEvent={sendActivityEvent} onClose={closeActivity} />
                      ) : (
                        <>
                          <div className="video-stage" ref={videoStageRef} style={{ gridTemplateColumns: `repeat(${voiceGrid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${voiceGrid.rows}, minmax(0, 1fr))` }}>
                            {pageTiles.map((t) => (
                              <VideoTile key={t.key} stream={t.stream} label={t.label} muted={t.muted} sinkId={t.sinkId} isScreen={t.isScreen} onExpand={(s, l) => setFullscreenStream({ stream: s, label: l })} />
                            ))}
                          </div>
                          {voicePageCount > 1 && (
                            <>
                              <button type="button" className="video-page-btn prev" onClick={() => setVoicePage((p) => Math.max(0, p - 1))} disabled={voicePageClamped === 0} aria-label="Previous page">‹</button>
                              <button type="button" className="video-page-btn next" onClick={() => setVoicePage((p) => Math.min(voicePageCount - 1, p + 1))} disabled={voicePageClamped === voicePageCount - 1} aria-label="Next page">›</button>
                              <div className="video-page-indicator">Page {voicePageClamped + 1} / {voicePageCount} · {voiceTotalTiles} in call</div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    <div className="voice-controlbar" role="toolbar" aria-label="Call controls">
                      <div className="voice-ctrl-wrap" ref={effectsMenuRef}>
                        {showEffectsMenu && (
                          <div className="voice-effects-menu" role="menu" aria-label="Webcam effects">
                            <div className="voice-quality-title">{videoOn ? 'Camera background' : 'Camera preview'}</div>
                            {!videoOn && <PreviewVideo stream={previewStream} />}
                            {videoDevices.length > 0 && (
                              <select className="voice-cam-select" value={selectedCameraId || ''} onChange={(e) => changeCamera(e.target.value)} aria-label="Select camera">
                                {videoDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label}</option>))}
                              </select>
                            )}
                            <div className="voice-effects-section">Effect</div>
                            <button type="button" role="menuitem" className={`voice-quality-opt${webcamEffect === 'none' ? ' active' : ''}`} onClick={() => chooseEffect('none')}>{videoOn ? 'None' : 'No effect'}</button>
                            <button type="button" role="menuitem" className={`voice-quality-opt${webcamEffect === 'blur' ? ' active' : ''}`} onClick={() => chooseEffect('blur')}>Blur</button>
                            <button type="button" role="menuitem" className={`voice-quality-opt${webcamEffect === 'strongblur' ? ' active' : ''}`} onClick={() => chooseEffect('strongblur')}>Strong blur</button>
                            <div className="voice-effects-section">Backgrounds</div>
                            <div className="voice-bg-grid">
                              {WEBCAM_BACKGROUNDS.map((bg) => (
                                <button
                                  key={bg.id}
                                  type="button"
                                  className={`voice-bg-swatch${webcamEffect === bg.id ? ' active' : ''}`}
                                  style={{ background: `linear-gradient(135deg, ${bg.colors[0]}, ${bg.colors[1] || bg.colors[0]})` }}
                                  title={bg.label}
                                  aria-label={`${bg.label} background`}
                                  onClick={() => { setBgCoverId(bg.id); chooseEffect(bg.id) }}
                                />
                              ))}
                              {customBgUrl && (
                                <button
                                  type="button"
                                  className={`voice-bg-swatch${webcamEffect === 'custom' ? ' active' : ''}`}
                                  style={{ backgroundImage: `url(${customBgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                                  title="Custom background"
                                  aria-label="Custom background"
                                  onClick={() => { setBgCoverId('custom'); chooseEffect('custom') }}
                                />
                              )}
                              <label className="voice-bg-swatch voice-bg-upload" title="Upload a background image">
                                +
                                <input type="file" accept="image/*" hidden onChange={uploadWebcamBackground} />
                              </label>
                            </div>
                            <button type="button" role="menuitem" className={`voice-quality-opt voice-hide-opt${webcamEffect === 'hide' ? ' active' : ''}`} onClick={() => chooseEffect('hide')} title="Cover your whole camera with the selected background — others won't see you">
                              🚫 Hide me behind background
                            </button>
                            {effectsError && <div className="voice-effects-error">{effectsError}</div>}
                            {!videoOn && (
                              <>
                                <button type="button" className="voice-cam-golive" onClick={goLiveWithCamera} disabled={!previewStream}>
                                  Turn on camera
                                </button>
                                <div className="voice-effects-hint">🔒 Your camera is only used after you turn it on.</div>
                              </>
                            )}
                          </div>
                        )}
                        <button className={`voice-ctrl${videoOn ? '' : ' toggled'}`} onClick={toggleCamera} title={videoOn ? 'Turn off camera' : 'Turn on camera'} aria-label="Toggle camera" aria-pressed={videoOn} aria-haspopup="menu">
                          {videoOn ? <CamOnIcon /> : <CamOffIcon />}
                        </button>
                        {videoOn && (
                          <button
                            className={`voice-ctrl${webcamEffect !== 'none' ? ' toggled' : ''}`}
                            onClick={() => setShowEffectsMenu((v) => !v)}
                            title="Change background"
                            aria-label="Change camera background"
                            aria-pressed={webcamEffect !== 'none'}
                            aria-haspopup="menu"
                          >
                            <EffectsIcon />
                          </button>
                        )}
                      </div>
                      <div className="voice-ctrl-wrap" ref={qualityMenuRef}>
                        {showQualityMenu && !screenSharing && (
                          <div className="voice-quality-menu" role="menu" aria-label="Go Live quality">
                            <div className="voice-quality-title">Go Live · stream quality</div>
                            {SCREEN_QUALITIES.map((q) => (
                              <button key={q.id} type="button" role="menuitem" className={`voice-quality-opt${screenQuality === q.id ? ' active' : ''}`} onClick={() => startScreenShare(q.id)}>
                                {q.label}
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          className={`voice-golive-btn${screenSharing ? ' live' : ''}`}
                          onClick={() => (screenSharing ? stopScreenShare() : setShowQualityMenu((v) => !v))}
                          title={screenSharing ? 'Stop your stream' : 'Go Live — share your screen'}
                          aria-label={screenSharing ? 'Stop streaming' : 'Go Live'}
                          aria-pressed={screenSharing}
                          aria-haspopup="menu"
                        >
                          <span className={`golive-dot${screenSharing ? ' pulse' : ''}`} aria-hidden="true" />
                          {screenSharing ? 'Stop' : 'Go Live'}
                        </button>
                      </div>
                      <div className="voice-ctrl-wrap voice-soundboard-wrap">
                        {showSoundboard && (
                          <Soundboard
                            sounds={soundLibrary}
                            playingIds={playingSoundIds}
                            volume={soundVolume}
                            onSetVolume={setSoundVolume}
                            onPlay={playSound}
                            onUpload={uploadSound}
                            onRename={renameSound}
                            onDelete={deleteSound}
                            onClose={() => setShowSoundboard(false)}
                          />
                        )}
                        <button className={`voice-ctrl${showSoundboard ? ' toggled' : ''}`} onClick={() => setShowSoundboard((v) => { if (!v) loadSounds(); return !v })} title="Soundboard" aria-label="Soundboard" aria-pressed={showSoundboard} aria-haspopup="menu">
                          <SoundboardIcon />
                        </button>
                      </div>
                      <div className="voice-ctrl-wrap" ref={activityMenuRef}>
                        {showActivityMenu && (
                          <div className="voice-quality-menu activity-launcher" role="menu" aria-label="Activities">
                            <div className="voice-quality-title">🎉 Activities</div>
                            {ACTIVITY_TYPES.map((a) => (
                              <button key={a.id} type="button" role="menuitem" className="activity-launch-opt" onClick={() => startActivity(a.id)}>
                                <span className="activity-launch-icon">{a.icon}</span>
                                <span className="activity-launch-text">
                                  <span className="activity-launch-label">{a.label}</span>
                                  <span className="activity-launch-hint">{a.hint}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        <button className={`voice-ctrl${activity ? ' toggled' : ''}`} onClick={() => setShowActivityMenu((v) => !v)} title="Activities" aria-label="Activities" aria-pressed={!!activity} aria-haspopup="menu">
                          <ActivitiesIcon />
                        </button>
                      </div>
                      <div className="voice-ctrl-wrap" ref={audioMenuRef}>
                        {showAudioMenu && (
                          <div className="voice-audio-menu" role="menu" aria-label="Audio devices">
                            <div className="voice-quality-title">🎙️ Microphone</div>
                            {audioInputs.length === 0 && <div className="voice-effects-hint">No microphones found</div>}
                            {audioInputs.map((d) => (
                              <button key={d.deviceId} type="button" role="menuitemradio" aria-checked={selectedMicId === d.deviceId} className={`voice-quality-opt${selectedMicId === d.deviceId ? ' active' : ''}`} onClick={() => changeMic(d.deviceId)}>{d.label}</button>
                            ))}
                            {supportsSpeakerSelect ? (
                              <>
                                <div className="voice-effects-section">🔊 Speaker (output)</div>
                                {audioOutputs.length === 0 && <div className="voice-effects-hint">No output devices found</div>}
                                {audioOutputs.map((d) => (
                                  <button key={d.deviceId} type="button" role="menuitemradio" aria-checked={selectedSpeakerId === d.deviceId} className={`voice-quality-opt${selectedSpeakerId === d.deviceId ? ' active' : ''}`} onClick={() => changeSpeaker(d.deviceId)}>{d.label}</button>
                                ))}
                              </>
                            ) : (
                              <div className="voice-effects-hint">Output device selection isn't supported in this browser.</div>
                            )}
                            <div className="voice-effects-hint">🔒 Your mic &amp; speakers are only accessed while you're in a call.</div>
                          </div>
                        )}
                        <button className={`voice-ctrl${micMuted ? ' toggled' : ''}`} onClick={toggleMute} title={micMuted ? 'Unmute' : 'Mute'} aria-label="Toggle microphone" aria-pressed={micMuted}>
                          {micMuted ? <MicOffIcon /> : <MicOnIcon />}
                        </button>
                        <button className="voice-ctrl-caret" onClick={() => setShowAudioMenu((v) => { if (!v) loadAudioDevices(); return !v })} title="Audio settings — choose microphone &amp; speaker" aria-label="Audio device settings" aria-haspopup="menu" aria-expanded={showAudioMenu}>▾</button>
                      </div>
                      <button className="voice-ctrl hangup" onClick={leaveVoice} title="Disconnect" aria-label="Leave call">
                        <HangupIcon />
                      </button>
                    </div>
                  </>
                )
              })()}
            </div>
          )}
        </div>
      </div>
      {/* Watch / Discover — who's live right now (in-app screen shares + Twitch/YouTube/Kik) */}
      {showDiscover && (() => {
        const inAppStreams = discoverStreams.filter((s) => s.kind !== 'external')
        const externalStreamsList = discoverStreams.filter((s) => s.kind === 'external')
        const PLATFORM_META = { twitch: { label: 'Twitch', cls: 'twitch' }, youtube: { label: 'YouTube', cls: 'youtube' }, kik: { label: 'Kik', cls: 'kik' } }
        return (
        <div className="discover-overlay" onClick={() => setShowDiscover(false)}>
          <div className="discover-modal" role="dialog" aria-label="Discover live streams" onClick={(e) => e.stopPropagation()}>
            <div className="discover-head">
              <div className="discover-title">📡 Live now</div>
              <div className="discover-head-actions">
                {myExternalStream ? (
                  <button type="button" className="discover-announce stop" onClick={unannounceStream}>⏹ Stop announcing</button>
                ) : (
                  <button type="button" className="discover-announce" onClick={() => setShowAnnounceForm((v) => !v)}>📣 I'm live elsewhere</button>
                )}
                <button type="button" className="discover-close" onClick={() => setShowDiscover(false)} aria-label="Close">✕</button>
              </div>
            </div>
            {showAnnounceForm && !myExternalStream && (
              <div className="announce-form">
                <div className="announce-row">
                  {['twitch', 'youtube', 'kik'].map((p) => (
                    <button key={p} type="button" className={`announce-platform ${p}${announceForm.platform === p ? ' active' : ''}`} onClick={() => setAnnounceForm((f) => ({ ...f, platform: p }))}>{PLATFORM_META[p].label}</button>
                  ))}
                </div>
                <input className="announce-input" placeholder={announceForm.platform === 'twitch' ? 'Your Twitch channel name' : announceForm.platform === 'youtube' ? 'YouTube live URL or channel link' : 'Your Kik username'} value={announceForm.channel} onChange={(e) => setAnnounceForm((f) => ({ ...f, channel: e.target.value }))} />
                <div className="announce-row">
                  <input className="announce-input" placeholder="Stream title (optional)" value={announceForm.title} onChange={(e) => setAnnounceForm((f) => ({ ...f, title: e.target.value }))} />
                  <input className="announce-input" placeholder="Game (optional)" value={announceForm.game} onChange={(e) => setAnnounceForm((f) => ({ ...f, game: e.target.value }))} />
                </div>
                <button type="button" className="discover-watch announce-go" onClick={announceStream}>🔴 Announce my stream</button>
              </div>
            )}
            {discoverStreams.length === 0 && !showAnnounceForm && (
              <div className="discover-empty">No one is live right now. Hit <strong>Go Live</strong> in a voice channel to share your screen, or <strong>📣 I'm live elsewhere</strong> to announce your Twitch/YouTube/Kik stream.</div>
            )}
            {inAppStreams.length > 0 && (
              <>
                <div className="discover-section">🖥️ Screen shares in this app</div>
                <div className="discover-grid">
                  {inAppStreams.map((s) => (
                    <div key={s.id} className="discover-card">
                      <div className="discover-thumb">
                        <span className="discover-thumb-avatar">{(s.name || '?').trim().slice(0, 1).toUpperCase()}</span>
                        <div className="discover-badges"><span className="discover-badge live">🔴 LIVE</span></div>
                      </div>
                      <div className="discover-info">
                        <div className="discover-name">{s.name || 'Guest'}</div>
                        <div className="discover-meta">{s.channelId === 'voice1' ? 'Voice 1' : s.channelId} · {s.viewers} in channel</div>
                        {s.genres?.length > 0 && <div className="discover-genres">{s.genres.slice(0, 3).map((g) => <span key={g} className="discover-genre">{g}</span>)}</div>}
                      </div>
                      <button type="button" className="discover-watch" onClick={() => watchStream(s)}>Watch</button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {externalStreamsList.length > 0 && (
              <>
                <div className="discover-section">🌐 Live on Twitch · YouTube · Kik</div>
                <div className="discover-grid">
                  {externalStreamsList.map((s) => (
                    <div key={s.id} className="discover-card">
                      <div className={`discover-thumb ext-${s.platform}`}>
                        <span className="discover-thumb-avatar">{(s.name || '?').trim().slice(0, 1).toUpperCase()}</span>
                        <div className="discover-badges"><span className={`discover-badge platform ${s.platform}`}>{PLATFORM_META[s.platform]?.label || s.platform} · LIVE</span></div>
                      </div>
                      <div className="discover-info">
                        <div className="discover-name">{s.name || 'Guest'}</div>
                        <div className="discover-meta">{s.title || (s.platform === 'kik' ? `@${s.channel}` : s.channel)}{s.game ? ` · 🎮 ${s.game}` : ''}</div>
                        {s.genres?.length > 0 && <div className="discover-genres">{s.genres.slice(0, 3).map((g) => <span key={g} className="discover-genre">{g}</span>)}</div>}
                      </div>
                      {s.platform === 'kik' ? (
                        <div className="discover-kik-note">Open Kik and find <strong>@{s.channel}</strong> — Kik streams can't be embedded.</div>
                      ) : (
                        <button type="button" className="discover-watch" onClick={() => { setShowDiscover(false); setExternalViewer(s) }}>Watch here</button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        )
      })()}
      {/* In-app viewer for an external Twitch/YouTube stream */}
      {externalViewer && (
        <div className="extviewer-overlay" onClick={() => setExternalViewer(null)}>
          <div className="extviewer-frame" onClick={(e) => e.stopPropagation()}>
            <div className="extviewer-head">
              <span className="extviewer-title">🔴 {externalViewer.name} — {externalViewer.title || externalViewer.channel}{externalViewer.game ? ` · 🎮 ${externalViewer.game}` : ''}</span>
              <button type="button" className="discover-close" onClick={() => setExternalViewer(null)} aria-label="Close viewer">✕</button>
            </div>
            {externalEmbedUrl(externalViewer) ? (
              <iframe className="extviewer-embed" src={externalEmbedUrl(externalViewer)} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen title="Live stream" />
            ) : (
              <div className="discover-empty">This stream can't be embedded — check the link the streamer shared.</div>
            )}
          </div>
        </div>
      )}
      {/* Teams-style pre-join screen */}
      {showPreJoin && (
        <div className="prejoin-overlay">
          <div className="prejoin-modal" role="dialog" aria-label="Choose your audio and video settings">
            <div className="prejoin-title">Choose your audio and video settings</div>
            <div className="prejoin-subtitle">You're about to join <strong>{preJoinChannelId === 'voice1' ? 'Voice 1' : preJoinChannelId}</strong></div>
            <div className="prejoin-body">
              <div className="prejoin-preview">
                {preJoinCamOn ? (
                  <PreviewVideo stream={previewStream} />
                ) : (
                  <div className="prejoin-cam-off">
                    <CamOffIcon />
                    <span>Your camera is turned off</span>
                  </div>
                )}
                <div className="prejoin-preview-controls">
                  <button type="button" className={`voice-ctrl${preJoinCamOn ? '' : ' toggled'}`} onClick={() => setPreJoinCamOn((v) => !v)} title={preJoinCamOn ? 'Turn off camera' : 'Turn on camera'} aria-pressed={preJoinCamOn}>
                    {preJoinCamOn ? <CamOnIcon /> : <CamOffIcon />}
                  </button>
                  <button type="button" className={`voice-ctrl${preJoinMuted ? ' toggled' : ''}`} onClick={() => setPreJoinMuted((v) => !v)} title={preJoinMuted ? 'Will join muted' : 'Mic on'} aria-pressed={preJoinMuted}>
                    {preJoinMuted ? <MicOffIcon /> : <MicOnIcon />}
                  </button>
                </div>
              </div>
              <div className="prejoin-settings">
                {preJoinCamOn && (
                  <div className="prejoin-group">
                    <div className="prejoin-label">Camera</div>
                    {videoDevices.length > 0 && (
                      <select className="voice-cam-select" value={selectedCameraId || ''} onChange={(e) => changeCamera(e.target.value)} aria-label="Select camera">
                        {videoDevices.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label}</option>))}
                      </select>
                    )}
                    <div className="prejoin-effects-row">
                      {[['none', 'None'], ['blur', 'Blur'], ['strongblur', 'Strong blur'], ['hide', 'Hide me']].map(([id, lbl]) => (
                        <button key={id} type="button" className={`prejoin-fx${webcamEffect === id ? ' active' : ''}`} onClick={() => chooseEffect(id)}>{lbl}</button>
                      ))}
                    </div>
                    <div className="voice-bg-grid">
                      {WEBCAM_BACKGROUNDS.map((bg) => (
                        <button key={bg.id} type="button" className={`voice-bg-swatch${webcamEffect === bg.id ? ' active' : ''}`} style={{ background: `linear-gradient(135deg, ${bg.colors[0]}, ${bg.colors[1] || bg.colors[0]})` }} title={bg.label} aria-label={`${bg.label} background`} onClick={() => { setBgCoverId(bg.id); chooseEffect(bg.id) }} />
                      ))}
                      {customBgUrl && (
                        <button type="button" className={`voice-bg-swatch${webcamEffect === 'custom' ? ' active' : ''}`} style={{ backgroundImage: `url(${customBgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} title="Custom background" aria-label="Custom background" onClick={() => { setBgCoverId('custom'); chooseEffect('custom') }} />
                      )}
                      <label className="voice-bg-swatch voice-bg-upload" title="Upload a background image">+<input type="file" accept="image/*" hidden onChange={uploadWebcamBackground} /></label>
                    </div>
                  </div>
                )}
                <div className="prejoin-group">
                  <div className="prejoin-label">🎙️ Microphone</div>
                  {audioInputs.length > 0 ? (
                    <select className="voice-cam-select" value={selectedMicId || ''} onChange={(e) => preJoinSelectMic(e.target.value)} aria-label="Select microphone">
                      {audioInputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label}</option>))}
                    </select>
                  ) : <div className="voice-effects-hint">Detecting microphones…</div>}
                  <div className="prejoin-meter" title="Live microphone level" aria-hidden="true"><div className="prejoin-meter-mask" ref={micMeterRef} /></div>
                </div>
                {supportsSpeakerSelect && (
                  <div className="prejoin-group">
                    <div className="prejoin-label">🔊 Speaker</div>
                    {audioOutputs.length > 0 ? (
                      <select className="voice-cam-select" value={selectedSpeakerId || ''} onChange={(e) => changeSpeaker(e.target.value)} aria-label="Select speaker">
                        <option value="">System default</option>
                        {audioOutputs.map((d) => (<option key={d.deviceId} value={d.deviceId}>{d.label}</option>))}
                      </select>
                    ) : <div className="voice-effects-hint">No output devices found</div>}
                  </div>
                )}
                {effectsError && <div className="voice-effects-error">{effectsError}</div>}
                <div className="voice-effects-hint">🔒 Your devices are only used once you join.</div>
              </div>
            </div>
            <div className="prejoin-footer">
              <button type="button" className="prejoin-cancel" onClick={cancelPreJoin}>Cancel</button>
              <button type="button" className="prejoin-join" onClick={confirmPreJoin}>Join now</button>
            </div>
          </div>
        </div>
      )}
      {/* Full-screen viewer for a shared screen */}
      {fullscreenStream && (
        <div className="screen-fullscreen" onClick={() => setFullscreenStream(null)}>
          <FullscreenVideo stream={fullscreenStream.stream} />
          <div className="screen-fullscreen-label">{fullscreenStream.label}</div>
          <button type="button" className="screen-fullscreen-close" onClick={() => setFullscreenStream(null)} aria-label="Close full screen">✕</button>
        </div>
      )}
      {/* Collaborative image editing */}
      {collab && (
        <CollabCanvas
          ref={collabCanvasRef}
          imageUrl={collab.imageUrl}
          onStroke={sendCollabStroke}
          onClear={clearCollab}
          onSave={saveCollab}
          onClose={closeCollab}
        />
      )}
      {collabInvite && (!collab || collab.sessionId !== collabInvite.sessionId) && (
        <div className="collab-invite">
          <span>🎨 <strong>{collabInvite.by}</strong> is editing an image together</span>
          <button type="button" className="collab-invite-join" onClick={() => joinCollab(collabInvite)}>Join</button>
          <button type="button" className="collab-invite-dismiss" onClick={() => setCollabInvite(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {/* Members panel overlay */}
      <AddFriendModal
        open={showAddFriendModal}
        username={addFriendUsername}
        onUsernameChange={setAddFriendUsername}
        onClose={closeAddFriendModal}
        onSend={sendFriendRequest}
        loading={addFriendLoading}
        error={addFriendError}
        userExists={addFriendUserExists}
        userChecking={addFriendUserChecking}
        isSelf={addFriendIsSelf}
      />

      <div className={`auth-overlay ${showNewChatModal ? 'open' : ''}`} onClick={closeNewChatModal} />
      <NewChatModal
        open={showNewChatModal}
        users={newChatUsers}
        selectedIds={newChatSelectedIds}
        groupName={newChatGroupName}
        onToggleUser={toggleNewChatUser}
        onGroupNameChange={setNewChatGroupName}
        onClose={closeNewChatModal}
        onCreate={createNewChat}
      />

      <div className={`overlay ${showMembersPanel || showInstallPanel || showSignOutConfirm || showStatusMenu || showAddFriendModal ? 'open' : ''}`} onClick={() => { setShowMembersPanel(false); setShowInstallPanel(false); setShowSignOutConfirm(false); setShowStatusMenu(false); closeAddFriendModal() }} />
      <div className={`members-panel ${showMembersPanel ? 'open' : ''}`} role="dialog" aria-hidden={!showMembersPanel}>
        <div className="members-panel-header">
          <div>{isHomeView ? `${homeChat?.name || 'Group'} Members` : 'Server Members'}</div>
          <button className="members-close" onClick={() => setShowMembersPanel(false)}>✕</button>
        </div>
        <div className="members-panel-body">
          {membersPanelUsers.length > 0 ? (
            <ul>
              {membersPanelUsers.map((member) => (
                <li key={member.id}>{member.name}{member.isYou ? ' (you)' : ''}</li>
              ))}
            </ul>
          ) : (
            <div style={{ color: '#9fb0bf', fontSize: 14 }}>No members found for this chat.</div>
          )}
        </div>
      </div>

      {/* Sign-out confirmation (centered modal) */}
      <div className={`auth-overlay ${showSignOutConfirm ? 'open' : ''}`} />
      <div className={`auth-modal signout-modal ${showSignOutConfirm ? 'open' : ''}`} role="dialog" aria-hidden={!showSignOutConfirm}>
        <div className="auth-inner" style={{flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:180}}>
          <div style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div style={{fontWeight:700,fontSize:18}}>Confirm Sign Out</div>
            <button className="members-close" onClick={() => setShowSignOutConfirm(false)} style={{fontSize:22,background:'none',border:'none',color:'#9fb0bf',cursor:'pointer'}}>✕</button>
          </div>
          <div style={{margin:'18px 0',fontSize:15,color:'#cfd8e3',textAlign:'center',maxWidth:340}}>
            Are you sure you want to sign out? You will need to sign in again to access your servers.
          </div>
          <div style={{display:'flex',gap:12,justifyContent:'center',marginTop:8}}>
            <button className="connect-btn" onClick={() => setShowSignOutConfirm(false)} style={{minWidth:90}}>Cancel</button>
            <button className="connect-btn" onClick={confirmSignOut} style={{minWidth:90}}>Sign out</button>
          </div>
        </div>
      </div>

      {lightbox && (
        <MediaLightbox
          items={lightbox.items}
          index={lightbox.index}
          onClose={closeLightbox}
          onNavigate={navigateLightbox}
        />
      )}

      {/* Authentication modal (blocks app until signed in) */}
      <div className={`auth-overlay ${!isAuthenticated && authChecked ? 'open' : ''}`} />
      <div className={`auth-modal ${!isAuthenticated && authChecked ? 'open' : ''}`} role="dialog" aria-hidden={isAuthenticated || !authChecked}>
        <div className="auth-inner">
          <div className="auth-left">
            <h2>Welcome to LAN Party</h2>
            <p>Sign in to join your servers and voice chats.</p>
            {authMode === 'register' && (
              <div className="pw-reqs auth-left-reqs">
                {pwItems.map((it, idx) => (
                  <div key={idx} className={`pw-req ${it.ok ? 'ok' : ''}`}>
                    <div className="check">{it.ok ? '✓' : '•'}</div>
                    <div>{it.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="auth-right">
            <div className="auth-tabs">
              <button className={authMode==='login' ? 'active' : ''} onClick={() => setAuthMode('login')}>Log in</button>
              <button className={authMode==='register' ? 'active' : ''} onClick={() => { setAuthMode('register'); clearRegisterForm(); }}>Register Account</button>
            </div>

            {authMode === 'login' && (
              <form onSubmit={handleLogin} className="auth-form">
                {authError && <div className="auth-error">{authError}</div>}
                <label>Username</label>
                <input className="half-field" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} />
                <label>Password</label>
                <div className="input-with-icon">
                  <input className="half-field" type={showLoginPassword ? 'text' : 'password'} value={loginPassword} onChange={e => setLoginPassword(e.target.value)} />
                      <button type="button" className="input-eye" onClick={() => setShowLoginPassword(s => !s)} aria-label={showLoginPassword ? 'Hide password' : 'Show password'}>
                        {showLoginPassword ? (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.06 10.06 0 0 1 12 20c-5.05 0-9.29-3.36-10-8a9.77 9.77 0 0 1 1.67-3.19M6.06 6.06A9.77 9.77 0 0 1 12 4c5.05 0 9.29 3.36 10 8a9.77 9.77 0 0 1-1.67 3.19M1 1l22 22" /><circle cx="12" cy="12" r="3" /></svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12S5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
                        )}
                      </button>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:10}}>
                  <div style={{display:'flex',gap:8}}>
                      <button type="submit" className="connect-btn" disabled={!loginUsername.trim() || !loginPassword.trim() || authLoading}>{authLoading ? 'Connecting...' : 'Connect'}</button>
                    </div>
                  <div style={{display:'flex',alignItems:'center',gap:12}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13}}><input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} /> Remember me</label>
                    <button type="button" className="link" onClick={() => setForgotOpen(o => !o)}>Forgot Password?</button>
                  </div>
                </div>

                {forgotOpen && (
                  <div className="forgot">
                    <label>Email</label>
                    <input value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} />
                    <div style={{display:'flex',gap:8,marginTop:8}}>
                      <button type="button" className="connect-btn" onClick={handleForgot} disabled={!forgotEmail.trim() || authLoading}>{authLoading ? 'Sending...' : 'Send'}</button>
                      {forgotMessage && <div className="muted">{forgotMessage}</div>}
                    </div>
                  </div>
                )}
              </form>
            )}

            {authMode === 'register' && (
              <form onSubmit={handleRegister} className="auth-form">
                {authError && <div className="auth-error">{authError}</div>}
                <label>Username {authMode === 'register' && <span className="req-asterisk" aria-hidden>*</span>}</label>
                <input
                  className={`half-field ${regUsernameError ? 'input-error' : regUsernameAvailable === false ? 'input-error' : regUsernameAvailable === true ? 'input-ok' : ''}`}
                  value={regUsername}
                  onChange={e => {
                    setRegUsername(e.target.value);
                    setRegUsernameError(null);
                    setRegUsernameAvailable(null);
                  }}
                  onBlur={async () => {
                    if (!regUsername.trim()) return;
                    setRegUsernameChecking(true);
                    const data = await runAvailabilityCheck({ username: regUsername });
                    setRegUsernameAvailable(data.username === true ? true : data.username === false ? false : null);
                    setRegUsernameError(data.username === false ? 'Username already exists' : null);
                    setRegUsernameChecking(false);
                  }}
                  aria-required={authMode === 'register'}
                />
                {/* Taken / server error takes priority, then a neutral checking hint, then success. */}
                {(regUsernameError || regUsernameAvailable === false) && regUsername ? (
                  <div className="field-error-message">{regUsernameError || 'Username already exists'}</div>
                ) : regUsername && regUsernameChecking ? (
                  <div className="field-hint-message">Checking availability…</div>
                ) : regUsername && regUsernameAvailable === true ? (
                  <div className="field-success-message">Username available</div>
                ) : null}
                <label>Email {authMode === 'register' && <span className="req-asterisk" aria-hidden>*</span>}</label>
                <input
                  className={`half-field ${regEmailError ? 'input-error' : regEmailAvailable === false ? 'input-error' : regEmailAvailable === true ? 'input-ok' : ''}`}
                  value={regEmail}
                  onChange={e => {
                    setRegEmail(e.target.value);
                    setRegEmailError(null);
                    setRegEmailAvailable(null);
                  }}
                  onBlur={async () => {
                    const email = regEmail.trim();
                    if (!email || !/\S+@\S+\.\S+/.test(email)) return;
                    setRegEmailChecking(true);
                    const data = await runAvailabilityCheck({ email });
                    setRegEmailAvailable(data.email === true ? true : data.email === false ? false : null);
                    setRegEmailError(data.email === false ? 'Email already exists' : null);
                    setRegEmailChecking(false);
                  }}
                  aria-required={authMode === 'register'}
                />
                {/* Invalid format first, then taken/error, then checking hint, then success. */}
                {regEmail && !isEmailValid ? (
                  <div className="field-error-message">Invalid email address</div>
                ) : (regEmailError || regEmailAvailable === false) && regEmail ? (
                  <div className="field-error-message">{regEmailError || 'Email already exists'}</div>
                ) : regEmail && regEmailChecking ? (
                  <div className="field-hint-message">Checking availability…</div>
                ) : regEmail && isEmailValid && regEmailAvailable === true ? (
                  <div className="field-success-message">Email available</div>
                ) : null}
                <div className="field-row">
                  <div className="field-main">
                    <label>Password {authMode === 'register' && <span className="req-asterisk" aria-hidden>*</span>}</label>
                    <div className="input-with-icon">
                      <input className="half-field" type={showRegPassword ? 'text' : 'password'} value={regPassword} onChange={e => setRegPassword(e.target.value)} />
                      <button type="button" className="input-eye" onClick={() => setShowRegPassword(s => !s)} aria-label={showRegPassword ? 'Hide password' : 'Show password'}>
                        {showRegPassword ? (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.06 10.06 0 0 1 12 20c-5.05 0-9.29-3.36-10-8a9.77 9.77 0 0 1 1.67-3.19M6.06 6.06A9.77 9.77 0 0 1 12 4c5.05 0 9.29 3.36 10 8a9.77 9.77 0 0 1-1.67 3.19M1 1l22 22" /><circle cx="12" cy="12" r="3" /></svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12S5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
                        )}
                      </button>
                    </div>
                    <div className="pw-strength">
                        <div className="pw-bar" aria-hidden>
                          {Array.from({length:5}).map((_,i) => {
                            const score = scorePassword(regPassword)
                            const filled = i < score
                            const style = filled ? { background: strengthColors[Math.max(0, Math.min(score-1, strengthColors.length-1))] } : {}
                            return <div key={i} className={`pw-seg ${filled ? 'filled' : ''}`} style={style} />
                          })}
                        </div>
                        <div className="pw-text" style={{color: strengthColors[Math.max(0, Math.min(scorePassword(regPassword)-1, strengthColors.length-1))]}}>{strengthLabel(scorePassword(regPassword))}</div>
                        <div className="sr-only" aria-live="polite">{strengthLabel(scorePassword(regPassword))}</div>
                        {/* requirement checklist moved to left pane for cleaner layout */}
                    </div>
                  </div>
                  {/* required badge moved to labels as red asterisk */}
                </div>

                <label>Confirm Password {authMode === 'register' && <span className="req-asterisk" aria-hidden>*</span>}</label>
                <div className="input-with-icon">
                  <input
                    className={`half-field ${regPasswordConfirm ? (regPassword === regPasswordConfirm ? 'input-ok' : 'input-error') : ''}`}
                    type={showRegPasswordConfirm ? 'text' : 'password'}
                    value={regPasswordConfirm}
                    onChange={e => setRegPasswordConfirm(e.target.value)}
                    aria-invalid={regPasswordConfirm && regPassword !== regPasswordConfirm ? 'true' : 'false'}
                  />
                  <button type="button" className="input-eye" onClick={() => setShowRegPasswordConfirm(s => !s)} aria-label={showRegPasswordConfirm ? 'Hide password' : 'Show password'}>
                    {showRegPasswordConfirm ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.06 10.06 0 0 1 12 20c-5.05 0-9.29-3.36-10-8a9.77 9.77 0 0 1 1.67-3.19M6.06 6.06A9.77 9.77 0 0 1 12 4c5.05 0 9.29 3.36 10 8a9.77 9.77 0 0 1-1.67 3.19M1 1l22 22" /><circle cx="12" cy="12" r="3" /></svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b0b3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12S5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
                    )}
                  </button>
                  {regPasswordConfirm && regPassword === regPasswordConfirm && (
                    <span className="input-icon ok" aria-hidden>
                      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="12" height="12" aria-hidden="true" focusable="false">
                        <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                  {regPasswordConfirm && regPassword !== regPasswordConfirm && (
                    <span className="input-icon error" aria-hidden>
                      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="12" height="12" aria-hidden="true" focusable="false">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </div>
                {regPasswordConfirm && regPassword !== regPasswordConfirm && (
                  <div className="field-error-message" role="alert">Passwords do not match</div>
                )}

                <label style={{ marginTop: 12 }}>🎮 What do you love playing? <span className="reg-optional">(pick any)</span></label>
                <div className="reg-genres">
                  {GAME_GENRES.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`reg-genre${regGenres.includes(g) ? ' active' : ''}`}
                      onClick={() => setRegGenres((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g])}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <label>What are you playing right now? <span className="reg-optional">(past 2 weeks)</span></label>
                <input
                  className="half-field"
                  type="text"
                  placeholder="e.g. Valorant, Baldur's Gate 3"
                  maxLength={200}
                  value={regCurrentGames}
                  onChange={(e) => setRegCurrentGames(e.target.value)}
                />

                <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}>
                  <button type="submit" className="connect-btn" disabled={!canCreate} aria-disabled={!canCreate}>{authLoading ? 'Creating...' : 'Create Account'}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Public app directory */}
      <AppDirectoryModal
        open={showAppDirectory}
        apps={publicApps}
        onClose={() => setShowAppDirectory(false)}
        onUpload={uploadApp}
        resolveSrc={emojiSrc}
      />

      {/* Install panel (fallback) */}
      <div className={`members-panel install-panel ${showInstallPanel ? 'open' : ''}`} role="dialog" aria-hidden={!showInstallPanel}>
        <div className="members-panel-header">
          <div>Install LAN Party</div>
          <button className="members-close" onClick={() => setShowInstallPanel(false)}>✕</button>
        </div>
        <div className="members-panel-body">
          <p>If your browser supports Progressive Web Apps, you can install the app by using the browser's install option. Otherwise you can download a native installer in a future build.</p>
          <p>Options:</p>
          <ul>
            <li>Install as PWA (use browser menu or the prompt)</li>
            <li>Download native installer (not available in demo)</li>
          </ul>
        </div>
      </div>

      {/* Profile / Settings — centered modal */}
      <div className={`auth-overlay ${showSettingsPanel ? 'open' : ''}`} onClick={() => setShowSettingsPanel(false)} />
      <div
        className={`auth-modal profile-settings-modal ${showSettingsPanel ? 'open' : ''}`}
        role="dialog"
        aria-labelledby="profile-settings-title"
        aria-hidden={!showSettingsPanel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="profile-settings-header">
          <h2 id="profile-settings-title">Settings</h2>
          <button type="button" className="members-close" onClick={() => setShowSettingsPanel(false)} aria-label="Close">✕</button>
        </div>
        <div className="profile-settings-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={settingsTab === 'profile'} className={`profile-settings-tab${settingsTab === 'profile' ? ' active' : ''}`} onClick={() => setSettingsTab('profile')}>Profile</button>
          <button type="button" role="tab" aria-selected={settingsTab === 'appearance'} className={`profile-settings-tab${settingsTab === 'appearance' ? ' active' : ''}`} onClick={() => setSettingsTab('appearance')}>Appearance</button>
          <button type="button" role="tab" aria-selected={settingsTab === 'messages'} className={`profile-settings-tab${settingsTab === 'messages' ? ' active' : ''}`} onClick={() => setSettingsTab('messages')}>Messages</button>
        </div>
        <div className="profile-settings-body">
          {settingsTab === 'profile' && editingProfile && (
          <section className="profile-settings-section">
            {/* Live preview */}
            <div className="profile-preview">
              <ProfileAvatar name={name} profile={editingProfile} size={80} color={editingSettings?.leftTileColor} resolveSrc={emojiSrc} />
              <div className="profile-preview-meta">
                <span className="profile-preview-name" style={nameStyleToCss(editingProfile.nameStyle, editingProfile.nameFont)}>{name || 'Guest'}</span>
                {(editingProfile.tags || []).length > 0 && (
                  <span className="profile-preview-tags">
                    {editingProfile.tags.map((t) => <span key={`${t.type}-${t.label}`} className={`profile-tag profile-tag-${t.type}`}>{t.label}</span>)}
                  </span>
                )}
                {editingProfile.statusMessage && <span className="profile-preview-status">{editingProfile.statusMessage}</span>}
                {editingProfile.bio && <span className="profile-preview-bio">{editingProfile.bio}</span>}
              </div>
              <button
                type="button"
                className={`profile-edit-toggle${showProfileEditor ? ' active' : ''}`}
                aria-expanded={showProfileEditor}
                onClick={() => setShowProfileEditor((v) => !v)}
              >
                {showProfileEditor ? 'Done' : 'Edit Profile'}
              </button>
            </div>

            {/* Gaming profile — favorite genres + what you're playing lately */}
            <div className="gaming-profile-card">
              <h3 className="profile-settings-section-title">🎮 Gaming Profile</h3>
              <div className="gaming-sub">Favorite genres</div>
              <div className="reg-genres">
                {GAME_GENRES.map((g) => (
                  <button key={g} type="button" className={`reg-genre${(editingGaming.genres || []).includes(g) ? ' active' : ''}`} onClick={() => toggleEditGenre(g)}>{g}</button>
                ))}
              </div>
              <div className="gaming-sub">Playing right now <span className="reg-optional">(past 2 weeks)</span></div>
              <input
                type="text"
                className="profile-text-input"
                placeholder="e.g. Valorant, Baldur's Gate 3"
                maxLength={200}
                value={editingGaming.currentGames || ''}
                onChange={(e) => updateGamingProfile({ currentGames: e.target.value })}
              />
              <div className="gaming-hint">Shown to others on your live-stream cards in Discover.</div>
            </div>

            {showProfileEditor && (
            <div className="profile-editor-panel">
            {/* Avatar */}
            <h3 className="profile-settings-section-title">Profile Picture</h3>
            <div className="profile-edit-row">
              <button type="button" className="connect-btn" onClick={() => profileAvatarInputRef.current?.click()}>Upload image / GIF</button>
              {editingProfile.avatarUrl && <button type="button" className="profile-link-btn" onClick={() => updateProfileDraft({ avatarUrl: '' })}>Remove</button>}
              <input ref={profileAvatarInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { uploadProfileAvatar(e.target.files?.[0]); if (e.target) e.target.value = '' }} />
            </div>
            <div className="profile-edit-row">
              <input
                type="text"
                className="profile-text-input"
                placeholder="…or paste an image URL"
                onPaste={(e) => { const v = e.clipboardData.getData('text'); if (v) { e.preventDefault(); setAvatarFromUrl(v) } }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setAvatarFromUrl(e.target.value); e.target.value = '' } }}
              />
            </div>

            {/* Border decoration */}
            <h3 className="profile-settings-section-title">Border Decoration</h3>
            <div className="profile-chip-row">
              {BORDER_PRESETS.map((bp) => (
                <button key={bp.id} type="button" className={`profile-chip${editingProfile.border?.preset === bp.id ? ' active' : ''}`} onClick={() => updateProfileBorder({ preset: bp.id })}>{bp.label}</button>
              ))}
              <button type="button" className={`profile-chip${editingProfile.border?.preset === 'custom' ? ' active' : ''}`} onClick={() => updateProfileBorder({ preset: 'custom' })}>Custom</button>
            </div>
            {editingProfile.border?.preset === 'custom' && (
              <div className="profile-edit-row">
                <label className="profile-inline-label">Color <input type="color" value={editingProfile.border.color || '#f5c451'} onChange={(e) => updateProfileBorder({ color: e.target.value })} /></label>
                <label className="profile-inline-label">Width
                  <input type="range" min="0" max="8" value={editingProfile.border.width || 0} onChange={(e) => updateProfileBorder({ width: Number(e.target.value) })} />
                  <span>{editingProfile.border.width || 0}px</span>
                </label>
                <select className="profile-select" value={editingProfile.border.style || 'solid'} onChange={(e) => updateProfileBorder({ style: e.target.value })}>
                  {BORDER_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}

            {/* Animation overlay */}
            <h3 className="profile-settings-section-title">Animation Overlay</h3>
            <div className="profile-chip-row">
              {AVATAR_OVERLAYS.map((o) => (
                <button key={o.id} type="button" className={`profile-chip${editingProfile.overlay === o.id ? ' active' : ''}`} onClick={() => updateProfileDraft({ overlay: o.id })}>{o.label}</button>
              ))}
            </div>

            {/* Name styling */}
            <h3 className="profile-settings-section-title">Username Style</h3>
            <div className="profile-edit-row">
              <select className="profile-select" value={editingProfile.nameFont} onChange={(e) => updateProfileDraft({ nameFont: e.target.value })}>
                {NAME_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label} font</option>)}
              </select>
            </div>
            <div className="profile-chip-row">
              {NAME_STYLES.map((s) => (
                <button key={s.id} type="button" className={`profile-chip${editingProfile.nameStyle?.id === s.id ? ' active' : ''}`} onClick={() => updateProfileDraft({ nameStyle: { ...editingProfile.nameStyle, id: s.id } })}>{s.label}</button>
              ))}
            </div>
            </div>
            )}

            {/* Status message + bio */}
            <h3 className="profile-settings-section-title">About</h3>
            <input
              type="text"
              className="profile-text-input"
              placeholder="Status message (e.g. 'Building stuff')"
              maxLength={80}
              value={editingProfile.statusMessage}
              onChange={(e) => updateProfileDraft({ statusMessage: e.target.value })}
            />
            <textarea
              className="profile-textarea"
              placeholder="Bio — tell people about yourself"
              maxLength={400}
              rows={3}
              value={editingProfile.bio}
              onChange={(e) => updateProfileDraft({ bio: e.target.value })}
            />

            {/* Tags */}
            <h3 className="profile-settings-section-title">Clan / Server Tags</h3>
            <div className="profile-chip-row">
              <button type="button" className={`profile-chip${(editingProfile.tags || []).some((t) => t.type === 'server' && t.label === serverName) ? ' active' : ''}`} onClick={() => toggleServerTag(serverName)}>{serverName}</button>
            </div>
            <div className="profile-edit-row">
              <input
                type="text"
                className="profile-text-input"
                placeholder="Add a custom tag (e.g. DEV)"
                maxLength={16}
                value={customTagInput}
                onChange={(e) => setCustomTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag() } }}
              />
              <button type="button" className="connect-btn" onClick={addCustomTag}>Add</button>
            </div>
            {(editingProfile.tags || []).length > 0 && (
              <div className="profile-chip-row">
                {editingProfile.tags.map((t) => (
                  <span key={`${t.type}-${t.label}`} className={`profile-tag profile-tag-${t.type}`}>{t.label}<button type="button" onClick={() => removeTag(t)} aria-label={`Remove ${t.label}`}>×</button></span>
                ))}
              </div>
            )}

            {/* Account info */}
            <h3 className="profile-settings-section-title">Account</h3>
            <div className="profile-settings-fields">
              <div className="profile-settings-field"><span className="profile-settings-label">Username</span><span className="profile-settings-value">{name || 'Guest'}</span></div>
              <div className="profile-settings-field"><span className="profile-settings-label">Email</span><span className="profile-settings-value">{userEmail || '—'}</span></div>
            </div>

            <div className="profile-settings-actions">
              {isAuthenticated && (
                <button type="button" className="profile-settings-signout" onClick={() => { setShowSettingsPanel(false); setShowSignOutConfirm(true) }}>Sign out</button>
              )}
              <button type="button" className="connect-btn" onClick={saveProfile}>Save Profile</button>
            </div>
          </section>
          )}

          {settingsTab === 'appearance' && (
          <section className="profile-settings-section">
            <h3 className="profile-settings-section-title">Color Scheme</h3>
            <div className="scheme-grid">
              {COLOR_SCHEMES.map((scheme) => {
                const active = matchSchemeId(editingSettings || userSettings) === scheme.id
                return (
                  <button
                    key={scheme.id}
                    type="button"
                    className={`scheme-card${active ? ' active' : ''}`}
                    onClick={() => selectScheme(scheme)}
                    aria-pressed={active}
                  >
                    <span className="scheme-swatches">
                      <span style={{ background: scheme.colors.railColor }} />
                      <span style={{ background: scheme.colors.headerColor }} />
                      <span style={{ background: `linear-gradient(90deg, ${scheme.colors.accentStart}, ${scheme.colors.accentEnd})` }} />
                      <span style={{ background: scheme.colors.panelColor }} />
                    </span>
                    <span className="scheme-name">{scheme.name}{active ? ' ✓' : ''}</span>
                  </button>
                )
              })}
            </div>
          </section>
          )}

          {settingsTab === 'messages' && (
          <section className="profile-settings-section">
            <h3 className="profile-settings-section-title">Message Flow</h3>
            <p className="profile-settings-note">Choose how new messages populate the chat. This only affects your view.</p>
            <div className="msg-flow-options">
              <button
                type="button"
                className={`msg-flow-card${messageFlow === 'bottom' ? ' active' : ''}`}
                onClick={() => selectMessageFlow('bottom')}
                aria-pressed={messageFlow === 'bottom'}
              >
                <span className="msg-flow-diagram msg-flow-diagram-bottom" aria-hidden="true">
                  <span /><span /><span />
                </span>
                <span className="msg-flow-title">Bottom-up{messageFlow === 'bottom' ? ' ✓' : ''}</span>
                <span className="msg-flow-desc">Messages anchor to the bottom; new ones push up.</span>
              </button>
              <button
                type="button"
                className={`msg-flow-card${messageFlow === 'top' ? ' active' : ''}`}
                onClick={() => selectMessageFlow('top')}
                aria-pressed={messageFlow === 'top'}
              >
                <span className="msg-flow-diagram msg-flow-diagram-top" aria-hidden="true">
                  <span /><span /><span />
                </span>
                <span className="msg-flow-title">Top-down{messageFlow === 'top' ? ' ✓' : ''}</span>
                <span className="msg-flow-desc">Messages fill from the top down, then scroll up.</span>
              </button>
            </div>
          </section>
          )}
        </div>
      </div>
    </div>
  )
}
