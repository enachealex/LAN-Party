import React, { useEffect, useState, useRef, useLayoutEffect, useMemo } from 'react'
import longPressProps from './longPress'
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
import GifPicker from './components/GifPicker'
import ReactionPicker, { REACTION_PICKER_W, REACTION_PICKER_H } from './components/ReactionPicker'
import Soundboard from './components/Soundboard'
import CollabCanvas from './components/CollabCanvas'
import ActivityPanel, { ACTIVITY_TYPES } from './components/Activities'
import CreateChannelModal from './components/CreateChannelModal'
import ManageChannelAccessModal from './components/ManageChannelAccessModal'
import { COLOR_SCHEMES, matchSchemeId } from './colorSchemes'
import ProfileAvatar from './components/ProfileAvatar'
import AppDirectoryModal from './components/AppDirectoryModal'
import AppViewer from './components/AppViewer'
import { playUiSound, playUiClip, setUiSoundPrefs, unlockUiSounds } from './uiSounds'
import { findNewerBuild, alreadyReloadedFor, reloadForBuild } from './appUpdate'
import EntranceSoundRecorder from './components/EntranceSoundRecorder'
import MobileInstallGate, { detectPlatform, isStandalone, installGateDismissed, rememberInstallGateDismissed } from './components/MobileInstallGate'
import MicTest from './components/MicTest'
import BootSplash from './components/BootSplash'
import ImageCropModal from './components/ImageCropModal'
import PrivateMessageModal from './components/PrivateMessageModal'
import InviteLinkSection from './components/InviteLinkSection'
import InviteJoinDialog, { InviteJoinNotice, useInviteJoin } from './components/InviteJoin'
import SearchPanel from './components/SearchPanel'
import { syncPush, stopPush, pushSupported, pushCovers, windowFocused, useNotificationTarget } from './push'
import { createMicMeter } from './micLevel'
import { normalizeProfile, nameStyleToCss, borderPresetColor, AVATAR_OVERLAYS, BORDER_PRESETS, BORDER_STYLES, NAME_FONTS, NAME_STYLES } from './profileData'
import { WebcamEffectProcessor, effectsSupported, warmUpEffects } from './webcamEffects'
import { SfuSession } from './sfu'

// API/socket origin. In dev, talk to the local server; in a production build, default to the
// same origin (the server serves the client), so it "just works" behind one domain. Override with
// VITE_SERVER_URL at build time to point at a separate API host.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '')
// Reported in feedback/bug diagnostics: the git commit + build date, stamped by vite.config.js.
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'unknown'
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

// ---- History paging helpers ----
// Conversations are loaded a page at a time (see "History paging" in App). The channel on screen
// keeps its paging state under this key; DMs and groups use their own chat storage key.
const CHANNEL_HISTORY_KEY = '#channel'

// Join two runs of messages into one list, oldest first, keeping the first copy of any id. Pages
// overlap whenever a live message and a fetched page both carry the same row.
function mergeHistory(...runs) {
  const seen = new Set()
  const merged = []
  for (const run of runs) {
    for (const m of run || []) {
      const id = String(m?.id)
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(m)
    }
  }
  return oldestMessagesFirst(merged)
}

// The lowest (Math.min) or highest (Math.max) server row id in a list: the paging cursor. Ids made
// up on the client (a fallback key, a local-only message) are not row ids and are skipped.
function edgeMessageId(list, pick) {
  let edge = null
  for (const m of list || []) {
    const id = typeof m?.id === 'number' ? m.id : /^\d+$/.test(String(m?.id ?? '')) ? Number(m.id) : NaN
    if (!Number.isSafeInteger(id) || id < 1) continue
    edge = edge == null ? id : pick(edge, id)
  }
  return edge
}

// A group with no name is called after its other members: "ann, ben, cat +2".
function groupDisplayName(group, me) {
  if (group?.name) return group.name
  const others = (group?.members || []).map((m) => m.name).filter((n) => n && n !== me)
  if (others.length === 0) return 'Just you'
  return others.length <= 3 ? others.join(', ') : `${others.slice(0, 3).join(', ')} +${others.length - 3}`
}

// A server group summary in the shape the conversation list and chat view use. `rawName` is what's
// stored (possibly empty); `name` is what's shown.
function toGroupChat(group, me) {
  const members = group.members || []
  return {
    ...group,
    rawName: group.name || '',
    name: groupDisplayName(group, me),
    avatar: '#5865f2',
    participants: members,
    preview: group.lastMessage?.text || `${members.length} members`,
  }
}

// Group chat ids are 'grp-...'; DM conversation keys are the peer's numeric user id. Anything that
// scans every conversation for a DM message id must skip group keys, since the two id spaces overlap.
const isGroupChatKey = (key) => String(key).startsWith('grp-')

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
// Inline media inside a message body. Two shapes count: a bare url on its own, and a caption followed
// by a url — "look at this <url>". The second shape is what the GIF picker sends when you type
// alongside an external Tenor pick, and it is also how people paste links; it used to fall through to
// a raw underlined link, which looked broken next to every other GIF in the channel.
//
// A url in the MIDDLE of a sentence is deliberately still just a link. Promoting that to a full-width
// image is rarely what someone meant, and it would change how existing messages render.
function mediaUrlFromText(text) {
  const trimmed = (text || '').trim()
  if (!trimmed) return null
  const last = trimmed.split(/\s+/).pop()
  // Absolute for Tenor and other remote media; root-relative for our own /gifs/ and /uploads/ files,
  // which is how the composer stacks a library GIF as a block instead of using the one attachment slot.
  return /^(https?:\/\/|\/)\S+$/i.test(last) ? last : null
}

function mediaFromText(text) {
  const url = mediaUrlFromText(text)
  if (!url) return null
  let pathname = url
  if (/^https?:\/\//i.test(url)) {
    try {
      pathname = new URL(url).pathname
    } catch {
      return null
    }
  } else {
    pathname = url.split(/[?#]/)[0] // root-relative: the path is already the path
  }
  const name = pathname.split('/').pop() || url
  const probe = { url, name }
  if (!isMediaAttachment(probe)) return null
  return probe
}

/**
 * Split a message body into the ordered blocks it renders as: text, media, text, media… This is what
 * makes a stacked message possible (type, drop a GIF, type again, drop another) without a schema
 * change — the body stays plain text, so old messages, search and editing all keep working.
 *
 * The rule is per LINE: if a line's last token is a media url, the words before it become a text block
 * and the url becomes a media block. A url in the middle of a line stays inside the text and renders as
 * a link — the same call made above, which keeps prose containing links looking like prose.
 * @param {string} text
 * @returns {Array<{ type: 'text', text: string } | { type: 'media', media: { url: string, name: string } }>}
 */
function messageBlocks(text) {
  const blocks = []
  const pushText = (value) => {
    const trimmed = (value || '').trim()
    if (!trimmed) return
    const last = blocks[blocks.length - 1]
    // Consecutive text lines belong to one paragraph, not one block each.
    if (last && last.type === 'text') last.text += `\n${trimmed}`
    else blocks.push({ type: 'text', text: trimmed })
  }
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const media = mediaFromText(line)
    if (media) {
      pushText(line.slice(0, line.length - media.url.length))
      blocks.push({ type: 'media', media })
    } else {
      pushText(line)
    }
  }
  return blocks
}

/**
 * The words in front of inline media — the caption to show with it. Empty when the message was only
 * a url, which is what lets a bare GIF still render as media alone with no stray text above it.
 * @param {string} text
 * @returns {string}
 */
function captionFromText(text) {
  const media = mediaFromText(text)
  const trimmed = (text || '').trim()
  if (!media) return trimmed
  return trimmed.slice(0, trimmed.length - media.url.length).trim()
}

/**
 * The gist of a quoted message: its words, plus a small thumbnail when the message was media. A quoted
 * GIF used to show its raw url, which is unreadable and usually longer than the quote box itself.
 * Shared by the staged reply above the composer and the quote block inside a sent bubble.
 */
function QuoteBody({ text, className }) {
  const blocks = messageBlocks(text)
  const media = blocks.find((b) => b.type === 'media')?.media
  if (!media) return <div className={className}>{text}</div>
  const words = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
  const kind = isGifAttachment(media) ? 'GIF' : isVideoAttachment(media) ? 'Video' : 'Image'
  return (
    <div className={`${className} quote-has-media`}>
      <span className="quote-thumb">
        <img src={emojiSrc(media.url)} alt="" loading="lazy" />
      </span>
      {/* Any caption reads better than the file type; the type is the fallback for media-only quotes. */}
      <span className="quote-thumb-label">{words || kind}</span>
    </div>
  )
}

// Ordered list of every media item in a message array (attachments + media URLs) for lightbox cycling.
function collectMediaList(messages = []) {
  const list = []
  for (const m of messages) {
    // A stacked message can hold several media blocks, and the lightbox should cycle every one of them.
    const found = (m?.attachment && isMediaAttachment(m.attachment))
      ? [m.attachment]
      : messageBlocks(m?.text).filter((b) => b.type === 'media').map((b) => b.media)
    for (const media of found) {
      if (media && !isAttachmentExpired(media)) {
        list.push({ attachment: media, url: attachmentUrl(media), kind: mediaKind(media) })
      }
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
function renderMessageText(text, emojiMap, onSaveEmoji, currentUser) {
  if (!text) return null
  const parts = []
  const regex = /:([a-z0-9_]+):/gi
  let last = 0
  let match
  let key = 0
  // Split out @mentions so they render as highlighted chips (extra pop when it's you).
  const pushPlain = (chunk) => { if (chunk) parts.push(...[].concat(enlargeUnicodeEmoji(chunk, `t${key++}`))) }
  const pushMentions = (chunk) => {
    if (!chunk) return
    const mentionRe = /@(\w[\w.-]*)/g
    let mLast = 0
    let mm
    while ((mm = mentionRe.exec(chunk)) !== null) {
      if (mm.index > mLast) pushPlain(chunk.slice(mLast, mm.index))
      const isMe = currentUser && mm[1].toLowerCase() === String(currentUser).toLowerCase()
      parts.push(<span key={`m${key++}`} className={`msg-mention${isMe ? ' me' : ''}`}>@{mm[1]}</span>)
      mLast = mm.index + mm[0].length
    }
    pushPlain(chunk.slice(mLast))
  }
  // Links become clickable first — https for the web, vaultmovies:// so a Watch
  // Party invite pasted in chat opens straight into the Vault Movies app.
  const pushText = (chunk) => {
    if (!chunk) return
    const urlRe = /(https?:\/\/[^\s<>"'`]+|vaultmovies:\/\/[^\s<>"'`]+)/g
    let uLast = 0
    let um
    while ((um = urlRe.exec(chunk)) !== null) {
      if (um.index > uLast) pushMentions(chunk.slice(uLast, um.index))
      let url = um[0]
      const trail = url.match(/[.,;:!?)\]}]+$/) // trailing punctuation isn't part of it
      if (trail) url = url.slice(0, -trail[0].length)
      const external = url.startsWith('http')
      parts.push(
        <a key={`u${key++}`} className="msg-link" href={url} onClick={(e) => e.stopPropagation()} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>{url}</a>
      )
      uLast = um.index + url.length
      urlRe.lastIndex = uLast
    }
    pushMentions(chunk.slice(uLast))
  }
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

// Short one-line preview of a message for the pin bar / pin list / forward confirmation.
function pinPreview(m) {
  if (!m) return ''
  const blocks = m.attachment ? [] : messageBlocks(m.text)
  const bodyMedia = m.attachment || blocks.find((b) => b.type === 'media')?.media
  // Any words in the message preview better than "🎞 GIF"; only a media-only message falls through.
  const caption = m.attachment ? (m.text || '') : blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
  if (caption) return caption.length > 90 ? caption.slice(0, 90) + '…' : caption
  if (bodyMedia) {
    if (isGifAttachment(bodyMedia)) return '🎞 GIF'
    if (isImageAttachment(bodyMedia)) return '📷 Image'
    return '📎 ' + (bodyMedia.name || 'Attachment')
  }
  return m.text || '(empty message)'
}

function ChatMessage({ message, currentUser, onReact, activeReactionMessageId, setActiveReactionMessageId, onOpenMedia, emojiMap, onSaveEmoji, onEdit, onDelete, onCollab, onPin, onUnpin, onForward, onReply, isPinned, quickReactions = MESSAGE_REACTIONS, skinTones }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState(null) // { left, top } for the portal menu
  const [reactionPickerPos, setReactionPickerPos] = useState(null) // { left, top } for the full-library picker
  const [showTimestamp, setShowTimestamp] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const closeToolbarTimer = useRef(null)
  const moreBtnRef = useRef(null)
  const moreReactionsBtnRef = useRef(null)
  const isOutgoing = message.author === currentUser
  const isToolbarActive = String(activeReactionMessageId) === String(message.id)
  const reactions = message.reactions || {}
  // The body renders as ordered blocks — text, media, text, media — so one message can stack several
  // GIFs with words between them.
  const blocks = message.attachment ? [] : messageBlocks(message.text)
  const bodyHasText = blocks.some((b) => b.type === 'text')
  const blockMedia = blocks.filter((b) => b.type === 'media').map((b) => b.media)
  const textMedia = blockMedia[0] || null
  // True when the bubble's content is media alone, so it can shrink-wrap tightly. Reactions are
  // allowed — they render below the media without widening the bubble.
  const hasMediaContent = Boolean(message.attachment) || blockMedia.length > 0
  const isMediaOnly = hasMediaContent && !bodyHasText
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
  const MENU_H = 150
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

  // Open the full emoji library as a fixed-position portal anchored to the "+" toolbar button,
  // clamped to the viewport (flips above/below like the action menu).
  const toggleReactionPicker = () => {
    if (reactionPickerPos) { setReactionPickerPos(null); return }
    const btn = moreReactionsBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const margin = 8
    let left = isOutgoing ? r.right - REACTION_PICKER_W : r.left
    left = Math.max(margin, Math.min(left, window.innerWidth - REACTION_PICKER_W - margin))
    const top = (r.bottom + REACTION_PICKER_H + margin > window.innerHeight)
      ? Math.max(margin, r.top - REACTION_PICKER_H - 4) // flip above when not enough room below
      : r.bottom + 4
    setReactionPickerPos({ left, top })
  }
  const pickReaction = (emoji) => {
    onReact?.(message.id, emoji)
    setReactionPickerPos(null)
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
    <div className={`msg-row ${isOutgoing ? 'outgoing' : 'incoming'}${isPinned ? ' pinned' : ''}`} data-mid={message.id}>
      <div
        className={`msg-stack ${isToolbarActive ? 'toolbar-open' : ''}`}
        onMouseEnter={showToolbar}
        onMouseLeave={hideToolbarSoon}
        onFocus={showToolbar}
        // Touch has no hover, so the react/reply/more toolbar would be unreachable on a phone —
        // long-pressing the message reveals it (the same state the mouse path uses).
        {...longPressProps(showToolbar)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) hideToolbarSoon()
        }}
      >
        <div className="msg-teams-toolbar" role="toolbar" aria-label="Message reactions" onMouseEnter={showToolbar}>
          {quickReactions.map((emoji) => (
            <button key={emoji} type="button" className="msg-reaction-btn" onClick={() => onReact?.(message.id, emoji)} aria-label={`React with ${emoji}`}>
              {emoji}
            </button>
          ))}
          <button
            ref={moreReactionsBtnRef}
            type="button"
            className="msg-more-btn msg-more-reactions-btn"
            onMouseDown={(e) => e.stopPropagation() /* keep the picker's outside-mousedown close from firing before this toggle */}
            onClick={() => { showToolbar(); toggleReactionPicker() }}
            aria-label="More reactions"
            aria-expanded={Boolean(reactionPickerPos)}
          >
            +
          </button>
          {onReply && (
            <button
              type="button"
              className="msg-more-btn msg-reply-btn"
              onClick={() => { showToolbar(); onReply(message) }}
              title="Reply with quote"
              aria-label="Reply with quote"
            >
              {/* An SVG rather than the ❞ ornament: that glyph is heavy by design, and its baseline
                  sits it off-centre in a small square button no matter how it's aligned. */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M9.6 5.4c-2.9 1.1-4.9 3.8-4.9 6.9v6.3h6.2v-6.2H7.4c0-1.9 1-3.4 2.7-4.1l-.5-2.9Zm8.5 0c-2.9 1.1-4.9 3.8-4.9 6.9v6.3h6.2v-6.2h-3.5c0-1.9 1-3.4 2.7-4.1l-.5-2.9Z" />
              </svg>
            </button>
          )}
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
        {reactionPickerPos && (
          <ReactionPicker
            pos={reactionPickerPos}
            skinTones={skinTones}
            onPick={pickReaction}
            onClose={() => setReactionPickerPos(null)}
          />
        )}
        {menuOpen && menuPos && createPortal(
          <div
            className="msg-action-menu"
            role="menu"
            style={{ left: menuPos.left, top: menuPos.top }}
            onMouseEnter={showToolbar}
            onMouseLeave={hideToolbarSoon}
          >
            {onReply && <button type="button" role="menuitem" onClick={() => { onReply(message); setMenuOpen(false) }}>Reply</button>}
            {canEdit && <button type="button" role="menuitem" onClick={startEdit}>Edit</button>}
            {collabImage && onCollab && <button type="button" role="menuitem" onClick={handleCollab}>Edit together</button>}
            {onForward && <button type="button" role="menuitem" onClick={() => { onForward(message); setMenuOpen(false) }}>Forward</button>}
            <button type="button" role="menuitem" onClick={copyMessage}>Copy</button>
            {(onPin || onUnpin) && (
              isPinned
                ? <button type="button" role="menuitem" onClick={() => { onUnpin?.(message.id); setMenuOpen(false) }}>Unpin</button>
                : <button type="button" role="menuitem" onClick={() => { onPin?.(message.id); setMenuOpen(false) }}>Pin</button>
            )}
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
          {Array.isArray(message.quotes) && message.quotes.length > 0 && (
            <div className="msg-quotes">
              {message.quotes.map((q, i) => (
                <div className="msg-quote" key={`${q.id ?? 'q'}-${i}`}>
                  <div className="msg-quote-head">
                    <span className="msg-quote-author">{q.author}</span>
                    {formatMessageTime(q.ts) && <span className="msg-quote-time">{formatMessageTime(q.ts)}</span>}
                  </div>
                  <QuoteBody text={q.text} className="msg-quote-text" />
                </div>
              ))}
            </div>
          )}
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
            // Blocks in order. The "(edited)" marker rides on the last text block so it stays with the
            // words rather than floating under an image.
            blocks.map((block, i) => (block.type === 'text' ? (
              <div className="msg-text" key={`t${i}`}>
                {renderMessageText(block.text, emojiMap, onSaveEmoji, currentUser)}
                {message.edited && i === blocks.findLastIndex((b) => b.type === 'text') && <span className="msg-edited"> (edited)</span>}
              </div>
            ) : (
              <AttachmentCard key={`m${i}`} attachment={block.media} onOpenMedia={onOpenMedia} />
            )))
          )}
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
function VideoTile({ stream, label, muted, isScreen, onExpand, sinkId, volume = 1, onVolume }) {
  const ref = useRef()
  const [hasVideo, setHasVideo] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  // Per-person volume. Set imperatively for the same reason as `muted` below, and re-applied when
  // the stream changes because a fresh srcObject can reset the element.
  useEffect(() => { if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume)) }, [volume, stream])
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
      {/* Only on other people's tiles (onVolume is not passed for your own). One loud mic should not
          force you to turn the whole call down. */}
      {onVolume && (
        <div className={`video-tile-volume${showVolume ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="video-tile-volume-btn"
            onClick={() => setShowVolume((v) => !v)}
            title={`Volume for ${label}: ${Math.round(volume * 100)}%`}
            aria-label={`Adjust volume for ${label}`}
            aria-expanded={showVolume}
          >
            {volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
          </button>
          {showVolume && (
            <input
              type="range" min="0" max="100" step="1"
              className="video-tile-volume-slider"
              value={Math.round(volume * 100)}
              onChange={(e) => onVolume(Number(e.target.value) / 100)}
              aria-label={`Volume for ${label}`}
            />
          )}
        </div>
      )}
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

// Plays a WebRTC remote MediaStream (audio, or video for video calls) via imperative srcObject.
function RemoteMedia({ stream, video }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.srcObject = stream || null }, [stream])
  return video
    ? <video ref={ref} autoPlay playsInline className="call-remote-video" />
    : <audio ref={ref} autoPlay />
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

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
  // Active SFU session for the joined voice room (null = P2P mesh mode). When set, the mesh
  // handlers (voice:peers / voice:signal) stand down and all media flows through the server.
  const sfuRef = useRef(null)
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
  // Live state of the segmentation pipeline: 'idle' | 'loading' | 'active' | 'unavailable'. Without
  // this a failing model just showed an unblurred camera, which reads as "blur is broken".
  const [effectsStatus, setEffectsStatus] = useState('idle')
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
  // Which view the server side panel shows: 'channels' | 'members'. Group-DM members still use the
  // right-side panel above, since that view has no channel list to share a panel with.
  const [serverPaneTab, setServerPaneTab] = useState('channels')
  // Custom rail tile image being chosen: { target, file }. `target` is { kind: 'home' } or
  // { kind: 'server', id, name }; `file` is the picked original, cropped in the modal before upload.
  const [tileCrop, setTileCrop] = useState(null)
  // A picked profile picture waiting in the square cropper (null = cropper closed).
  const [avatarCrop, setAvatarCrop] = useState(null)
  const tileFileInputRef = useRef(null)
  const tileTargetRef = useRef(null) // survives the trip out to the OS file dialog and back
  const [memberMenu, setMemberMenu] = useState(null) // right-click manage menu: { x, y, username, name, role }
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showInstallPanel, setShowInstallPanel] = useState(false)
  // Hide browser "Download App" / PWA install UI when already running inside the Electron desktop shell.
  const isDesktopApp = typeof window !== 'undefined' && !!window.desktop?.isElectron
  // Settings panel: the long editors stay collapsed so the panel reads as a summary until the user
  // opts into editing. Each closes again on its own button.
  const [editGenresOpen, setEditGenresOpen] = useState(false)
  const [editAboutOpen, setEditAboutOpen] = useState(false)
  const [addTagOpen, setAddTagOpen] = useState(false)
  // Phone layout: the left nav (server rail + channel list) collapses into a drawer.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // On a mobile browser we push the installed (home-screen) app instead of the tab. Computed once:
  // these facts can't change without a reload, except the dismissal, which is state.
  const [installGateSkipped, setInstallGateSkipped] = useState(() => installGateDismissed())
  const [installedNow, setInstalledNow] = useState(false)
  // Public app directory modal.
  const [showAppDirectory, setShowAppDirectory] = useState(false)
  // The embeddable app currently open in the in-app sandboxed viewer (null = closed).
  const [viewerApp, setViewerApp] = useState(null)
  const [publicApps, setPublicApps] = useState([])
  // Whether that list has ever been fetched. An empty array alone cannot tell "there are no apps"
  // from "not asked yet" or "the request failed", and the launcher must not claim the first.
  const [publicAppsStatus, setPublicAppsStatus] = useState('idle') // 'idle' | 'loading' | 'ready' | 'error'
  // Whether the server says this account runs the instance (may review uploaded apps). It comes
  // with the app list and only decides what is DRAWN; the server re-checks on every request.
  const [instanceOwner, setInstanceOwner] = useState(false)
  // Every request that answers with the app list takes a number when it starts, and a list is only
  // put on screen if no later-started request has already put its own there: a slow GET must not
  // paint over the answer to the approve that was sent after it.
  const appsSeqRef = useRef(0)
  const appsAppliedRef = useRef(0)
  // True while the solo viewer was opened from the directory, which then comes back when it closes.
  const viewerFromDirectoryRef = useRef(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [settingsTab, setSettingsTab] = useState('profile') // 'profile' | 'appearance' | 'messages'
  // Feedback / bug-report modal (submissions forward to Vaultline via the server's /feedback route).
  const [feedbackType, setFeedbackType] = useState('feedback') // 'feedback' | 'request' | 'bug'
  const [feedbackTitle, setFeedbackTitle] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackFile, setFeedbackFile] = useState(null)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackResult, setFeedbackResult] = useState(null) // { ok, key?, message }
  const feedbackFileInputRef = useRef(null)
  // Invite-friends-to-server modal.
  const [inviteModal, setInviteModal] = useState(null) // { serverId, serverName } | null
  const [inviteMembers, setInviteMembers] = useState(new Set()) // usernames already in the server
  const [inviteBusy, setInviteBusy] = useState(new Set()) // usernames currently being invited
  const [inviteLoadingMembers, setInviteLoadingMembers] = useState(false)
  const [inviteQuery, setInviteQuery] = useState('') // filter the friends list in the invite modal
  // An invite link this page was opened through (/app/?invite=CODE), if any. The hook takes the code
  // out of the address bar and holds it across login, so it is declared up here with no dependency
  // on auth state: a signed-out visitor still needs it looked up.
  const inviteJoin = useInviteJoin(SERVER_URL)
  // The conversation a clicked push notification wants opened (/app/?open=…, or a message from the
  // service worker when a window was already open). Acted on further down, once signed in and loaded.
  const notificationTarget = useNotificationTarget()
  // Whether the profile customization controls (picture/border/overlay/name style) are expanded.
  const [showProfileEditor, setShowProfileEditor] = useState(false)
  // Editable username (in Edit Profile) — changing it reissues the auth token.
  const [editUsername, setEditUsername] = useState('')
  const [usernameSaving, setUsernameSaving] = useState(false)
  // Email-link account flows (password reset / deactivation confirm), keyed off ?reset= / ?deactivate=.
  const [accountFlow, setAccountFlow] = useState(null) // { type:'reset'|'deactivate', token, email }
  const [flowPassword, setFlowPassword] = useState('')
  const [flowPasswordConfirm, setFlowPasswordConfirm] = useState('')
  const [flowError, setFlowError] = useState(null)
  const [flowBusy, setFlowBusy] = useState(false)
  const [flowDone, setFlowDone] = useState(null)
  // Live-stream picture-in-picture: minimized state + draggable position + resizable size.
  const [streamMini, setStreamMini] = useState(false)
  const [streamPos, setStreamPos] = useState({ x: 24, y: 90 })
  const [streamSize, setStreamSize] = useState({ w: 344, h: 226 })
  // Direction new messages flow: 'bottom' (anchor to bottom, default) or 'top' (fill from top down).
  const [messageFlow, setMessageFlow] = useState('bottom')
  // The user's quick-reaction emojis shown in the message hover toolbar (customizable in Settings).
  const [quickReactions, setQuickReactions] = useState(MESSAGE_REACTIONS)
  // Which quick-reaction slot is being edited in Settings: { index, left, top } or null.
  const [editingQuickReaction, setEditingQuickReaction] = useState(null)
  // The user's customizable profile (avatar, decorations, bio, tags, name styling).
  const [profile, setProfile] = useState(() => normalizeProfile())
  // Draft profile being edited in the settings modal (committed on Save).
  const [editingProfile, setEditingProfile] = useState(null)
  const [customTagInput, setCustomTagInput] = useState('')
  const profileAvatarInputRef = useRef(null)
  const [userSettings, setUserSettings] = useState(null)
  const [editingSettings, setEditingSettings] = useState(null)
  // Scrollable body of the settings modal, so save/cancel can return the view to the top.
  const settingsBodyRef = useRef(null)
  const [token, setToken] = useState(null)
  // Authentication state
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  // Whether the initial session-restore check has completed. If a token exists we hold the
  // login modal back until /auth/me resolves, so it doesn't flash on refresh for signed-in users.
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem('lanparty_token'))
  // Startup sequence for a RETURNING user (a stored token). A signed-out visitor skips the splash and
  // goes straight to the login screen, so `bootDone` starts true for them.
  const hadTokenAtBoot = useRef(!!localStorage.getItem('lanparty_token'))
  const [bootSteps, setBootSteps] = useState(() => (hadTokenAtBoot.current ? { session: 'active' } : {}))
  const [bootDone, setBootDone] = useState(() => !hadTokenAtBoot.current)
  const [bootNote, setBootNote] = useState(null)
  const markBoot = (id, state) => setBootSteps((prev) => (prev[id] === state ? prev : { ...prev, [id]: state }))
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
  // ---- Voice preferences: per DEVICE (localStorage), like the mic and speaker choice. A headset on
  // one machine and laptop speakers on another want different answers. ----
  const readPref = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v } catch (_) { return fallback } }
  const writePref = (key, value) => { try { localStorage.setItem(key, value) } catch (_) { /* private mode: lasts for the session */ } }
  // Browser noise suppression. On by default, which is also what the browser did before this was a setting.
  const [noiseSuppression, setNoiseSuppression] = useState(() => readPref('lanparty_noise_suppression', '1') === '1')
  // Push-to-talk: the mic only transmits while the key is held. `pttKey` is a KeyboardEvent.code, so
  // it names the physical key and does not move with the keyboard layout.
  const [pttEnabled, setPttEnabled] = useState(() => readPref('lanparty_ptt', '0') === '1')
  const [pttKey, setPttKey] = useState(() => readPref('lanparty_ptt_key', 'Backquote'))
  const [pttHeld, setPttHeld] = useState(false)
  const [pttRebinding, setPttRebinding] = useState(false)
  // Per-person volume, 0..1, keyed by display name so it survives them reconnecting (a socket id does not).
  const [peerVolumes, setPeerVolumes] = useState(() => { try { return JSON.parse(readPref('lanparty_peer_volumes', '{}')) || {} } catch (_) { return {} } })
  const setPeerVolume = (who, value) => setPeerVolumes((prev) => {
    const next = { ...prev, [who]: value }
    if (value >= 1) delete next[who] // full volume is the default; don't store it
    writePref('lanparty_peer_volumes', JSON.stringify(next))
    return next
  })
  // Synthesized UI feedback sounds (Web Audio; see uiSounds.js). Persisted per-user in settings.
  const [uiSoundsEnabled, setUiSoundsEnabled] = useState(true)
  const [uiSoundVolume, setUiSoundVolume] = useState(0.5)
  // Audio device selection (mic input + speaker output). Enumerated only after the user is in a call.
  const [audioInputs, setAudioInputs] = useState([])
  const [audioOutputs, setAudioOutputs] = useState([])
  const [selectedMicId, setSelectedMicId] = useState(null)
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(null)
  const [showAudioMenu, setShowAudioMenu] = useState(false)
  // Watch/Discover: who is currently streaming (camera/screen) across the app.
  const [discoverStreams, setDiscoverStreams] = useState([])
  const [showDiscover, setShowDiscover] = useState(false)
  // Public profile card shown when you click a member.
  const [profileCard, setProfileCard] = useState(null) // { loading?, username, profile, gamingProfile, status }
  const [toast, setToast] = useState(null) // brief bottom notice (invites, role changes)
  // A newer build has been deployed than the one on screen (its signature), or null. See appUpdate.ts.
  const [newBuild, setNewBuild] = useState(null)
  const busyForReloadRef = useRef(false)
  const checkForUpdateRef = useRef(() => {})
  // External streaming (Twitch/YouTube/Kik): my announcement + the announce form + in-app viewer.
  const [myExternalStream, setMyExternalStream] = useState(null) // { platform, channel, title, game }
  // Streams this viewer has dismissed from Live now. Purely local — hiding someone's card never
  // touches their stream. Session-scoped on purpose: ids are socket ids, so a stream that comes back
  // later is a new id and reappears, which is what you want from "hide this one".
  const [hiddenStreamIds, setHiddenStreamIds] = useState(() => new Set())
  const [showAnnounceForm, setShowAnnounceForm] = useState(false)
  const [announceForm, setAnnounceForm] = useState({ platform: 'twitch', channel: '', title: '', game: '' })
  const [externalViewer, setExternalViewer] = useState(null) // stream entry being watched in-app
  // Activities: the shared activity for the current voice room (null when none), + the launcher.
  const [activity, setActivity] = useState(null)
  const [showActivityMenu, setShowActivityMenu] = useState(false)
  // Uploaded apps as activities. Whoever is hosting an app's frame (AppActivity) is handed what the
  // socket says as it arrives, beside the React state above rather than through it: transient app
  // messages are events, not state, and state updates have to reach the app one by one and in
  // order, where React is free to fold two quick ones into a single render.
  const appHostHandlersRef = useRef(new Set())
  const subscribeAppHostRef = useRef((handler) => {
    appHostHandlersRef.current.add(handler)
    return () => { appHostHandlersRef.current.delete(handler) }
  })
  const notifyAppHostRef = useRef((event) => {
    appHostHandlersRef.current.forEach((handler) => { try { handler(event) } catch (_) { /* one listener must not stop the rest */ } })
  })
  // The app this client itself just asked to start, so its panel opens without a second click.
  const startedAppRef = useRef(null) // { appId, at }
  const activityTypeRef = useRef(null)
  activityTypeRef.current = activity?.type || null
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
  const [showMicTest, setShowMicTest] = useState(false) // pre-join: reveal the full mic test
  const [preJoinMuted, setPreJoinMuted] = useState(false)
  const preJoinMicStreamRef = useRef(null) // mic acquired during pre-join (transferred to the call on join)
  const micMeterRef = useRef(null)     // the meter mask element (updated directly to avoid re-renders)
  const micBtnRef = useRef(null)       // in-call mic button; its --mic-level is written per frame
  const callMeterRef = useRef(null)    // createMicMeter handle for the in-call level indicator
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
  // First-login onboarding: a welcome screen, then the gaming profile (moved out of registration).
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onbStep, setOnbStep] = useState(0) // 0 = welcome, 1 = "what do you love playing?"
  const [onbGenres, setOnbGenres] = useState([])
  const [onbCurrentGames, setOnbCurrentGames] = useState('')
  const [onbSaving, setOnbSaving] = useState(false)
  // In-app text prompt (replaces window.prompt, which Electron doesn't support). Promise-based.
  const [promptModal, setPromptModal] = useState(null) // { title, label, placeholder, submitLabel, resolve }
  const [promptValue, setPromptValue] = useState('')
  // Direct 1:1 friend calls (separate from server voice channels; own peer connection + signaling).
  const [call, setCall] = useState(null) // { status:'outgoing'|'incoming'|'connecting'|'connected', peer, peerSocket, video, startedAt }
  const [callRemoteStream, setCallRemoteStream] = useState(null)
  const [callMuted, setCallMuted] = useState(false)
  const [callElapsed, setCallElapsed] = useState(0)
  const callRef = useRef(null)
  const callPcRef = useRef(null)
  const callLocalStreamRef = useRef(null)
  // Desktop transparent video overlay (shown while the app is hidden to the tray during a call).
  const remoteStreamsRef = useRef({})
  const callRemoteStreamRef = useRef(null)
  const overlayPcRef = useRef(null)
  const overlayActiveRef = useRef(false)
  const [leftNav, setLeftNav] = useState('friends')
  const [selectedServerId, setSelectedServerId] = useState('home')
  // Real servers from the DB (the rail renders these — no more mock tiles).
  const [serversList, setServersList] = useState([])
  // Unread channel-message counts: { [serverId]: { [channelId]: n } } (loaded from /unreads,
  // bumped live by unread:bump, cleared when a channel is viewed).
  const [channelUnreads, setChannelUnreads] = useState({})
  // Unread messages that @mention me, per channel: { serverId: { channelId: n } }. Kept apart from
  // the unread count because it is a different question ("did anyone ask for me?") with its own badge.
  const [channelMentions, setChannelMentions] = useState({})
  // Who is typing where: { conversationKey: { username: expiresAtMs } }. An entry expires on its own,
  // so a "typing" that is never followed by a message (they gave up, or the stop was lost) clears.
  const [typingBy, setTypingBy] = useState({})
  const lastTypingSentRef = useRef(0)
  const TYPING_SHOWN_MS = 5000
  const clearTyping = (key, who) => setTypingBy((prev) => {
    if (!prev[key] || !(who in prev[key])) return prev
    const rest = { ...prev[key] }
    delete rest[who]
    const next = { ...prev }
    if (Object.keys(rest).length) next[key] = rest
    else delete next[key]
    return next
  })
  // @mention autocomplete in the composer.
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissedFor, setMentionDismissedFor] = useState(null)
  // Pinned messages of the currently-viewed channel, newest pin first (from pins:updated).
  const [channelPins, setChannelPins] = useState([])
  const [showPinsModal, setShowPinsModal] = useState(false)   // "View Pins" list
  const [pinBarMenu, setPinBarMenu] = useState(null)          // right-click menu on the pin bar: {x,y}
  // Opened by right-click on desktop and long-press on touch, so both paths share one definition
  // and stay clamped inside the viewport.
  const openPinBarMenu = (e) => {
    e.preventDefault()
    setPinBarMenu({ x: Math.min(e.clientX, window.innerWidth - 190), y: Math.min(e.clientY, window.innerHeight - 90) })
  }
  const openMemberMenu = (e, member, role, canManage = false) => {
    e.preventDefault()
    setMemberMenu({
      x: Math.min(e.clientX, window.innerWidth - 190),
      y: Math.min(e.clientY, window.innerHeight - 120),
      username: member.username, name: member.name, role, canManage,
    })
  }
  // Private message composer, opened from a member's right-click menu in a server or group chat.
  const [pmTarget, setPmTarget] = useState(null)              // { username, name } | null
  const [pmSending, setPmSending] = useState(false)
  const [pmError, setPmError] = useState(null)
  const [forwardMsg, setForwardMsg] = useState(null)          // message being forwarded (opens the picker)
  // Desktop notifications preference (persisted locally; Notification.permission gates actual use).
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem('lanparty_notify') === '1')
  const notifyEnabledRef = useRef(notifyEnabled)
  useEffect(() => { notifyEnabledRef.current = notifyEnabled }, [notifyEnabled])
  // Create-channel modal (name + type + privacy); channelModalType pre-selects the clicked section.
  const [showChannelModal, setShowChannelModal] = useState(false)
  const [channelModalType, setChannelModalType] = useState('text')
  // Manage-access modal for an existing private channel: { id, name } or null.
  const [manageAccessChannel, setManageAccessChannel] = useState(null)
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
  const [showGifPicker, setShowGifPicker] = useState(false)
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
  // Set when the New Message picker is being used to add people to this group instead.
  const [addToGroupId, setAddToGroupId] = useState(null)
  const [groupBusy, setGroupBusy] = useState(false)
  const leavingGroupsRef = useRef(new Set()) // groups we're leaving on purpose (no "removed" toast)
  const [pendingFile, setPendingFile] = useState(null)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState(null)
  // Ordered composer stack: [{ kind: 'text', text } | { kind: 'gif', url, name }]. Built up as you
  // type and pick GIFs, then flattened into one message body on send, so a single message can be
  // text / GIF / text / GIF. Uploaded files keep their own slot (pendingFile) — they need uploading.
  const [composerStack, setComposerStack] = useState([])
  // Messages quoted into the composer (Teams-style reply): [{ id, author, ts, text }].
  const [pendingQuotes, setPendingQuotes] = useState([])
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
  // The same moment as restoredViewRef, as state: friends, conversations and groups are loaded and
  // the saved view has been put back. Opening a notification's conversation waits for it, because
  // doing so any earlier would be overwritten by that restore.
  const [viewRestored, setViewRestored] = useState(false)
  const messagesListRef = useRef(null)
  // Number of unread messages captured when a chat is opened, so we can land the
  // scroll on the first unread message instead of the bottom. Cleared once applied.
  const pendingUnreadScrollRef = useRef(0)
  // Tracks which chat the scroll position has already been initialized for.
  const scrollInitKeyRef = useRef(null)
  // Set when the chat changes; cleared once we've scrolled the new chat to the bottom (may be a tick
  // later, after its messages load). Survives visiting an empty chat in between.
  const needBottomScrollRef = useRef(true)
  // Whether the view is pinned to the newest message (true = follow new content / late-loading media).
  const stickToBottomRef = useRef(true)

  // ---- History paging ----
  // A conversation is no longer held whole: it is a window of pages that grows as the reader
  // scrolls. Per conversation (CHANNEL_HISTORY_KEY for the channel on screen, otherwise the home
  // chat's storage key):
  //   hasMore   older messages exist beyond the window (undefined until the server has said so)
  //   detached  newer ones exist beyond it too: the window sits somewhere back in history (a jump
  //             to a search result or a pin). Live messages are NOT appended to a detached window,
  //             since that would put today's message directly under last month's with nothing to
  //             show the gap.
  //   missed    how many live messages arrived while detached
  //   loadingOlder / loadingNewer   a page is on its way (one request at a time per direction)
  // The ref is the copy socket handlers and scroll listeners read; both are written together.
  const [historyMeta, setHistoryMeta] = useState({})
  const historyMetaRef = useRef({})
  // What is loaded, for code that runs outside a render (scroll listeners, socket handlers).
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const homeMessagesRef = useRef(homeMessages)
  homeMessagesRef.current = homeMessages
  // Which channel the `messages` list belongs to, as the server tagged it. Paging asks for more of
  // THIS channel; activeChannel can be a beat ahead of the list while a switch is in flight.
  const messagesChannelRef = useRef(null)
  // A scroll position owed to the next render: { fromBottom } after older messages were prepended
  // (so the view does not jump), or { toBottom } after returning to the present.
  const pendingScrollRef = useRef(null)
  // Set when a page of NEWER history is appended, so the follow-new-messages logic leaves it alone.
  const skipFollowRef = useRef(false)
  // A channel jump waiting for the socket to move us there: { serverId, channelId, messageId, timer }.
  const pendingJumpRef = useRef(null)
  // Live messages that arrived while a window was being fetched, and how many fetches are running.
  const liveBufferRef = useRef({})
  const windowFetchRef = useRef({})
  const olderRetryAtRef = useRef(0)
  // The message a jump should scroll to and flash once it has rendered: { key, id, n }.
  const [jumpHighlight, setJumpHighlight] = useState(null)
  // The paging functions, refreshed every render, for effects and listeners declared above them.
  const historyFnsRef = useRef({})
  const [showSearch, setShowSearch] = useState(false)

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
  // Socket handlers are bound once per connection, so they read the group list through a ref.
  const groupChatsRef = useRef([])
  useEffect(() => { groupChatsRef.current = groupChats }, [groupChats])

  // Mirror call state for socket callbacks + tick the in-call timer once connected.
  useEffect(() => { callRef.current = call }, [call])
  useEffect(() => {
    if (call?.status !== 'connected') return
    const started = call.startedAt || Date.now()
    const id = setInterval(() => setCallElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [call?.status, call?.startedAt])

  useEffect(() => { remoteStreamsRef.current = remoteStreams }, [remoteStreams])
  useEffect(() => { callRemoteStreamRef.current = callRemoteStream }, [callRemoteStream])

  // Desktop only: while the window is hidden to the tray during a call that has remote video, pipe
  // that video into a transparent, always-on-top, draggable/resizable overlay window (via a loopback
  // WebRTC connection, since MediaStreams can't cross Electron windows directly).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.desktop || !window.desktop.isElectron || !window.desktop.onVisibility) return
    const primaryRemoteVideoTrack = () => {
      const cs = callRemoteStreamRef.current
      if (cs) { const t = cs.getVideoTracks().find((x) => x.readyState === 'live'); if (t) return t }
      for (const s of Object.values(remoteStreamsRef.current || {})) {
        const t = s && s.getVideoTracks && s.getVideoTracks().find((x) => x.readyState === 'live')
        if (t) return t
      }
      return null
    }
    const stopOverlay = () => {
      overlayActiveRef.current = false
      try { overlayPcRef.current?.close() } catch (_) {}
      overlayPcRef.current = null
      try { window.desktop.overlayClose() } catch (_) {}
    }
    const buildOffer = async () => {
      const track = primaryRemoteVideoTrack()
      if (!track) { stopOverlay(); return }
      const pc = new RTCPeerConnection({ iceServers: iceConfigRef.current })
      overlayPcRef.current = pc
      pc.addTrack(track, new MediaStream([track]))
      pc.onicecandidate = (e) => { if (e.candidate) window.desktop.overlaySend({ type: 'candidate', candidate: e.candidate }) }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      window.desktop.overlaySend({ type: 'offer', sdp: pc.localDescription })
    }
    const startOverlay = () => {
      if (overlayActiveRef.current) return
      if (!primaryRemoteVideoTrack()) return // audio-only or no remote video → nothing to overlay
      overlayActiveRef.current = true
      window.desktop.overlayShow() // the overlay page sends { type:'ready' } once loaded
    }
    window.desktop.onVisibility((visible) => { if (visible) stopOverlay(); else startOverlay() })
    window.desktop.onOverlaySignal(async (msg) => {
      if (!msg) return
      if (msg.type === 'ready') buildOffer().catch((e) => console.warn('overlay offer failed', e))
      else if (msg.type === 'answer' && overlayPcRef.current) { try { await overlayPcRef.current.setRemoteDescription(msg.sdp) } catch (_) {} }
      else if (msg.type === 'candidate' && overlayPcRef.current) { try { await overlayPcRef.current.addIceCandidate(msg.candidate) } catch (_) {} }
    })
  }, [])

  // Identity of the currently-open chat (channel or home chat).
  // A home chat stays selected while a server is on screen, so "is one open" is not enough: keyed on
  // homeChat alone, the channel list would be scrolled (and listened to) as if it were that chat.
  const viewingHomeChat = Boolean(homeChat) && selectedServerId === 'home'
  const activeChatKey = viewingHomeChat ? `home:${homeChat.id}` : `channel:${selectedServerId}:${activeChannel}`
  const activeMessageCount = viewingHomeChat ? activeHomeMessageCount : messages.length

  useEffect(() => {
    const list = messagesListRef.current
    if (!list) return
    // Switching chats owes the new chat a scroll-to-bottom, applied once its messages are present.
    // Tracking the switch separately (rather than keying off message count) means visiting an EMPTY
    // chat in between doesn't leave a stale "already scrolled" marker that skips the next chat.
    if (scrollInitKeyRef.current !== activeChatKey) {
      scrollInitKeyRef.current = activeChatKey
      needBottomScrollRef.current = true
      pendingUnreadScrollRef.current = 0
      stickToBottomRef.current = true
    }
    if (activeMessageCount === 0) return

    if (needBottomScrollRef.current) {
      // Opening a chat always lands on the newest message (the bottom). The rAF re-pin catches
      // cases where late layout (avatars/wrapping) grows the list just after this runs.
      needBottomScrollRef.current = false
      list.scrollTop = list.scrollHeight
      stickToBottomRef.current = true
      requestAnimationFrame(() => {
        if (scrollInitKeyRef.current === activeChatKey && stickToBottomRef.current) list.scrollTop = list.scrollHeight
      })
      return
    }

    // A page of newer history appended to a detached window is not "a message arrived". Following
    // it would land on its last message, which asks for the next page, and so on to the present.
    if (skipFollowRef.current) {
      skipFollowRef.current = false
      stickToBottomRef.current = false
      return
    }

    // Same chat, a message arrived: keep pinned to the bottom only if already near it.
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    if (distanceFromBottom < 120) { list.scrollTop = list.scrollHeight; stickToBottomRef.current = true }
  }, [activeChatKey, activeMessageCount])

  // Follow late-loading content (images, GIFs, embeds): when a message's media finishes
  // loading it grows the list AFTER the scroll above ran with a too-short scrollHeight, leaving
  // the newest image below the fold. A capture-phase `load` listener re-pins to the bottom while
  // the user is still parked there; a scroll listener releases the pin when they scroll up.
  useEffect(() => {
    const list = messagesListRef.current
    if (!list) return
    const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120
    // The bottom of a detached window is not the newest message, so there is nothing to stay pinned
    // to there. Every scroll also checks whether an edge is close enough to fetch the next page.
    const onScroll = () => {
      stickToBottomRef.current = nearBottom() && !historyFnsRef.current.isDetached?.()
      historyFnsRef.current.checkEdges?.()
    }
    const onMediaLoad = () => { if (stickToBottomRef.current) list.scrollTop = list.scrollHeight }
    list.addEventListener('scroll', onScroll, { passive: true })
    list.addEventListener('load', onMediaLoad, true) // `load` doesn't bubble, but fires in capture
    return () => {
      list.removeEventListener('scroll', onScroll)
      list.removeEventListener('load', onMediaLoad, true)
    }
  }, [activeChatKey])

  useEffect(() => {
    setActiveReactionMessageId(null)
  }, [selectedServerId, activeChannel, homeChat?.id])

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId
  }, [selectedServerId])

  // ---- History paging: scroll upkeep (the paging itself is further down, by appendHomeMessage) ----
  // These sit below the effects that refresh homeChatRef / selectedServerIdRef on purpose: effects
  // run in declaration order, and the paging functions read the conversation on screen from those refs.

  // Settle a scroll position owed from just before this render. Prepending a page makes the list
  // taller at the top; keeping the distance from the BOTTOM fixed is what leaves the messages the
  // reader was looking at exactly where they were. Layout effect, so it lands before the paint.
  useLayoutEffect(() => {
    const owed = pendingScrollRef.current
    if (!owed) return
    pendingScrollRef.current = null
    const list = messagesListRef.current
    if (!list) return
    if (owed.toBottom) {
      list.scrollTop = list.scrollHeight
      stickToBottomRef.current = true
    } else {
      list.scrollTop = list.scrollHeight - owed.fromBottom
    }
  })

  // Leaving a conversation whose window was detached throws that window away, so coming back
  // always starts from the newest messages with live updates on.
  useEffect(() => {
    const homeKey = viewingHomeChat ? chatStorageKey(homeChat.id) : null
    const serverId = selectedServerId
    const channelId = activeChannel
    return () => historyFnsRef.current.leaveConversation?.(homeKey, serverId, channelId)
  }, [activeChatKey])

  // A home chat stays selected while a server is on screen, and may have had its window thrown away
  // by the effect above in the meantime. Coming back to it by the Home tile opens nothing, so
  // without this it would sit there empty ("No messages yet") in front of a full history.
  useEffect(() => {
    historyFnsRef.current.loadHomeChatIfMissing?.()
  }, [activeChatKey])

  // A jump's target has rendered: bring it into view and flash it. Runs after the scroll-to-bottom
  // effect above (declaration order), so a freshly opened chat ends on the target, not the bottom.
  useEffect(() => {
    if (!jumpHighlight) return
    if (historyFnsRef.current.currentKey?.() !== jumpHighlight.key) return
    historyFnsRef.current.flashMessage?.(jumpHighlight.id, false)
  }, [jumpHighlight])

  // After anything that changes the list or its paging state, see whether an edge is already in
  // reach. Without this a first page too short to scroll could never ask for the one before it,
  // because no scroll event would ever fire.
  useEffect(() => {
    historyFnsRef.current.checkEdges?.()
  }, [activeChatKey, activeMessageCount, historyMeta])

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

  // Email-link flows: /app/?reset=TOKEN&email=… or ?deactivate=TOKEN&email=… → open the matching
  // overlay and scrub the token out of the address bar.
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      const email = p.get('email') || ''
      if (p.get('reset')) setAccountFlow({ type: 'reset', token: p.get('reset'), email })
      else if (p.get('deactivate')) setAccountFlow({ type: 'deactivate', token: p.get('deactivate'), email })
      if (p.get('reset') || p.get('deactivate')) window.history.replaceState({}, '', window.location.pathname)
    } catch (_) { /* ignore */ }
  }, [])

  // Try to restore session from token
  useEffect(() => {
    const t = localStorage.getItem('lanparty_token')
    if (!t) { setAuthChecked(true); return }
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/auth/me`, { headers: { 'Authorization': `Bearer ${t}` } })
        // The session did not survive, so this is a signed-out browser now: it must stop receiving
        // that account's pushes too (there is no token left to tell the server with; see stopPush).
        if (!res.ok) { localStorage.removeItem('lanparty_token'); stopPush(); return }
        const data = await res.json()
        setToken(t)
        setIsAuthenticated(true)
        setName(data.user.username)
        setUserEmail(data.user.email || '')
        setUserSettings(data.user.settings)
        applySettings(data.user.settings)
        // Resume onboarding if a new account refreshed before finishing it.
        maybeStartOnboarding(data.user.settings)
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
        // Hydrate the selected server from the saved view BEFORE connecting. The socket's
        // 'connect' handler reads selectedServerIdRef to pick which server to join; on a fresh
        // reload the ref is still 'home' (restoreSavedView runs later, after two fetches), so
        // without this the socket joined 'demo' while the UI restored another server — its
        // channel id then failed the server-side gate and sends vanished silently.
        const savedView = readSavedViewState()
        if (
          savedView && (!savedView.username || savedView.username === data.user.username) &&
          savedView.selectedServerId && savedView.selectedServerId !== 'home' &&
          !/^s[1-5]$/.test(savedView.selectedServerId) // legacy mock ids — restoreSavedView migrates these
        ) {
          selectedServerIdRef.current = savedView.selectedServerId
          setSelectedServerId(savedView.selectedServerId)
          if (savedView.activeChannel) setActiveChannel(savedView.activeChannel)
        }
        connect(data.user.username, t)
        const [loadedFriends, loadedConversations, loadedGroups] = await Promise.all([
          loadFriendsData(t),
          loadMessagesData(t),
          loadGroupsData(t),
        ])
        restoreSavedView({ username: data.user.username, friendsList: loadedFriends, conversations: loadedConversations, groups: loadedGroups, authToken: t })
      } catch (err) {
        console.warn('Restore session failed', err)
        localStorage.removeItem('lanparty_token')
        // Same rule as the !res.ok exit above: this browser is now signed out, so it must not keep
        // showing that account's message previews. Without this a restore that failed on the network
        // (server restarting, device offline) left the subscription live on the login screen.
        stopPush()
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

  // The group chats this user is in, with their unread counts (the open group never shows a badge).
  const loadGroupsData = async (authToken) => {
    const t = authToken || token
    if (!t) return []
    try {
      const res = await fetch(`${SERVER_URL}/groups`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return []
      const data = await res.json()
      const me = localStorage.getItem('lanparty_user') || name
      const groups = (data.groups || []).map((g) => toGroupChat(g, me))
      setGroupChats(groups)
      const open = homeChatRef.current?.type === 'group' ? String(homeChatRef.current.id) : null
      setGroupUnread(Object.fromEntries(
        groups.filter((g) => g.unreadCount > 0 && String(g.id) !== open).map((g) => [g.id, g.unreadCount])
      ))
      return groups
    } catch (err) {
      console.warn('loadGroupsData failed', err)
      return []
    }
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
    setViewRestored(true)
    if (!saved || Object.keys(saved).length === 0) return
    if (saved.username && username && saved.username !== username) return

    if (saved.leftNav) setLeftNav(saved.leftNav)
    if (saved.activeChannel) setActiveChannel(saved.activeChannel)
    if (saved.selectedServerId) {
      // Migrate old mock rail ids (s1..s5) from previous versions: s1 was LAN Party ('demo').
      const sid = saved.selectedServerId
      const migrated = /^s[2-5]$/.test(sid) ? 'home' : (sid === 's1' ? 'demo' : sid)
      setSelectedServerId(migrated)
      // Re-room the socket into the restored channel. The connect-time join lands us in the
      // server's FIRST text channel; if the user was viewing a different one, joinChannel
      // switches the room and refetches that channel's history + pins, keeping the send
      // target and the socket's rooms in agreement. (Buffered by socket.io if not yet connected.)
      if (migrated !== 'home' && saved.activeChannel) {
        socketRef.current?.emit('joinChannel', { serverId: migrated, channelId: saved.activeChannel })
      }
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
      // Only reopen a group you're still in. That also drops the old browser-only groups ('group-...').
      const group = (groups || []).find((item) => String(item.id) === String(savedChat.id))
      if (!group) return
      setSelectedGroupId(group.id)
      setSelectedFriendId(null)
      setSelectedDmId(null)
      setHomeChat({ type: 'group', id: group.id, name: group.name })
      loadGroupHistory(group.id, authToken)
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
      playUiSound('success')
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

  // Snapshot of the runtime environment attached to each feedback/bug report to help triage.
  const collectDiagnostics = () => {
    try {
      return {
        appVersion: APP_VERSION,
        desktopApp: !!(typeof window !== 'undefined' && window.desktop && window.desktop.isElectron),
        platform: (typeof window !== 'undefined' && window.desktop && window.desktop.platform) || (typeof navigator !== 'undefined' ? navigator.platform : ''),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '',
        screen: typeof window !== 'undefined' && window.screen ? `${window.screen.width}x${window.screen.height}` : '',
        locale: typeof navigator !== 'undefined' ? (navigator.language || '') : '',
      }
    } catch (_) { return {} }
  }

  const submitFeedback = async () => {
    const msg = feedbackMessage.trim()
    if (!msg) { setFeedbackResult({ ok: false, message: 'Please describe your feedback first.' }); return }
    setFeedbackSubmitting(true)
    setFeedbackResult(null)
    try {
      const t = token || localStorage.getItem('token')
      const fd = new FormData()
      fd.append('type', feedbackType)
      if (feedbackTitle.trim()) fd.append('title', feedbackTitle.trim())
      fd.append('message', msg)
      fd.append('diagnostics', JSON.stringify(collectDiagnostics()))
      if (feedbackFile) fd.append('screenshot', feedbackFile)
      const res = await fetch(`${SERVER_URL}/feedback`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setFeedbackResult({ ok: true, key: data.key || null, message: data.key ? `Thanks! Your report was filed as ${data.key}.` : 'Thanks! Your report was received.' })
        setFeedbackMessage('')
        setFeedbackTitle('')
        setFeedbackFile(null)
      } else if (data && data.saved) {
        setFeedbackResult({ ok: true, message: 'Thanks! Your report was saved and will be delivered shortly.' })
      } else {
        setFeedbackResult({ ok: false, message: (data && data.error) || 'Could not submit right now. Please try again.' })
      }
    } catch (_) {
      setFeedbackResult({ ok: false, message: 'Network error. Please try again.' })
    } finally {
      setFeedbackSubmitting(false)
    }
  }

  // Object URL for the attached screenshot preview; revoked when it changes / unmounts.
  const feedbackPreview = useMemo(() => (feedbackFile ? URL.createObjectURL(feedbackFile) : null), [feedbackFile])
  useEffect(() => () => { if (feedbackPreview) URL.revokeObjectURL(feedbackPreview) }, [feedbackPreview])

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
    setEditUsername(name || '')
    setShowSettingsPanel(true)
  }

  // Change username (reissues the token; the socket reconnects with the new identity).
  const changeUsername = async () => {
    const next = editUsername.trim()
    if (!next || next === name || usernameSaving) return
    setUsernameSaving(true)
    try {
      const t = token || localStorage.getItem('lanparty_token')
      const res = await fetch(`${SERVER_URL}/user/username`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ username: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setToast(data.error || 'Could not change username'); return }
      setName(data.username)
      setToken(data.token)
      localStorage.setItem('lanparty_token', data.token)
      localStorage.setItem('lanparty_user', data.username)
      setEditUsername(data.username)
      // Reconnect the socket so the server ties this connection to the new username.
      try { socketRef.current?.disconnect() } catch (_) {}
      connect(data.username, data.token)
      setToast('Username updated')
    } catch (err) {
      setToast('Could not reach the server')
    } finally {
      setUsernameSaving(false)
    }
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

  // UI sound preferences (persisted per-user). Toggling on plays a confirmation blip so the change
  // is audible; the volume slider previews with a tap.
  const toggleUiSounds = () => {
    const next = !uiSoundsEnabled
    setUiSoundsEnabled(next)
    setUiSoundPrefs({ enabled: next })
    if (next) { unlockUiSounds(); playUiSound('toggle') }
    patchUserSettings({ uiSounds: { enabled: next, volume: uiSoundVolume } })
  }
  const changeUiSoundVolume = (v) => {
    const vol = Math.max(0, Math.min(1, v))
    setUiSoundVolume(vol)
    setUiSoundPrefs({ volume: vol })
    if (uiSoundsEnabled) playUiSound('tap')
    patchUserSettings({ uiSounds: { enabled: uiSoundsEnabled, volume: vol } })
  }

  // Replace one quick-reaction slot (from Settings). If the picked emoji already sits in
  // another slot, swap the two so the set stays free of duplicates.
  const setQuickReactionAt = (index, emoji) => {
    setQuickReactions((prev) => {
      const next = [...prev]
      const existing = next.indexOf(emoji)
      if (existing !== -1 && existing !== index) next[existing] = next[index]
      next[index] = emoji
      patchUserSettings({ quickReactions: next })
      return next
    })
  }
  const resetQuickReactions = () => {
    setQuickReactions(MESSAGE_REACTIONS)
    patchUserSettings({ quickReactions: MESSAGE_REACTIONS })
  }
  // Open the reaction picker anchored to a quick-reaction slot in Settings.
  const openQuickReactionEditor = (index, event) => {
    const r = event.currentTarget.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - REACTION_PICKER_W - margin))
    const top = (r.bottom + REACTION_PICKER_H + margin > window.innerHeight)
      ? Math.max(margin, r.top - REACTION_PICKER_H - 4)
      : r.bottom + 4
    setEditingQuickReaction({ index, left, top })
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

  // Switching a cosmetic preset drops any colour override, so the newly picked preset shows in its
  // own colours; the user can then re-tint it deliberately.
  const selectBorderPreset = (preset) => updateProfileBorder({ preset, tint: '' })
  const selectOverlay = (overlay) => updateProfileDraft({ overlay, overlayColor: '' })
  const selectNameStyle = (id) => updateProfileDraft({ nameStyle: { id, color: '', from: '', to: '' } })
  const updateNameStyle = (patch) => setEditingProfile((p) => ({ ...(p || {}), nameStyle: { ...(p?.nameStyle || {}), ...patch } }))

  // Voice-chat entrance clip. The server stores it straight onto the profile (so it survives even if
  // the user closes the editor without saving) and returns the url to mirror into the draft.
  const [entranceBusy, setEntranceBusy] = useState(false)
  const uploadEntranceSound = async (blob) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !blob) return
    setEntranceBusy(true)
    try {
      const fd = new FormData()
      // Name it with an extension so the server can sanity-check the type.
      const ext = (blob.type || '').includes('ogg') ? 'ogg' : 'webm'
      fd.append('clip', blob, `entrance.${ext}`)
      const res = await fetch(`${SERVER_URL}/profile/entrance-sound`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save the clip')
      updateProfileDraft({ entranceSound: data.url })
      setProfile((p) => ({ ...(p || {}), entranceSound: data.url }))
      playUiSound('success')
      setToast('Entrance sound saved')
    } catch (err) {
      alert(err.message || 'Could not save the entrance clip')
    } finally {
      setEntranceBusy(false)
    }
  }

  const removeEntranceSound = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    setEntranceBusy(true)
    try {
      await fetch(`${SERVER_URL}/profile/entrance-sound`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
      updateProfileDraft({ entranceSound: '' })
      setProfile((p) => ({ ...(p || {}), entranceSound: '' }))
    } catch (err) {
      console.warn('removeEntranceSound failed', err)
    } finally {
      setEntranceBusy(false)
    }
  }

  // Profile pictures go to their own endpoint, NOT the general /files/upload one: anything stored
  // under uploads/ is deleted by the 7-day sweep, which used to make an avatar vanish after a week.
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024 // must match the server's cap
  const uploadProfileAvatar = async (file) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t || !file) return
    // Failures report as a toast, NOT via setUploadError: that message only renders under the message
    // composer, which isn't on screen while the settings panel is open — so a rejected picture looked
    // like a dead button, and the message later reappeared attached to an unrelated action. The server
    // now enforces a type allowlist and a 5 MB cap (a HEIC phone photo hits both), so these paths are
    // reachable in normal use and have to be visible.
    if (!file.type.startsWith('image/')) { setToast('Profile picture must be an image.'); return }
    if (file.size > AVATAR_MAX_BYTES) { setToast('Profile picture must be under 5 MB.'); return }
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch(`${SERVER_URL}/profile/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
      const data = await res.json().catch(() => ({})) // a 413 from a proxy may not carry JSON
      if (!res.ok) throw new Error(data.error || 'Could not save that picture')
      // The endpoint writes it onto the profile immediately (same as the entrance clip), so mirror it
      // into the live profile as well as the draft — otherwise Cancel would show a stale picture.
      updateProfileDraft({ avatarUrl: data.url })
      setProfile((p) => ({ ...(p || {}), avatarUrl: data.url }))
      // …and into BOTH settings copies. They hold their own `profile` snapshot taken when the panel
      // opened: applySettings ends by calling setProfile(settings.profile), so picking a colour scheme
      // would otherwise snap the picture back to the pre-upload one, and the next wholesale save would
      // write that stale url — releasing the file we just stored and leaving a 404 behind.
      const mirrorAvatar = (s) => (s ? { ...s, profile: { ...(s.profile || {}), avatarUrl: data.url } } : s)
      setUserSettings(mirrorAvatar)
      setEditingSettings(mirrorAvatar)
      setUploadError(null) // don't let a previous failure resurface under the message composer
      setToast('Profile picture updated')
    } catch (err) {
      setToast(err.message || 'Could not save that picture')
    }
  }

  // A picked picture goes through the square cropper first, so it's framed the way the user wants
  // instead of being centre-cropped by CSS. Two exceptions go straight to the upload: a GIF (a canvas
  // crop would freeze an animated avatar into one frame) and anything that isn't an image (the upload
  // path already explains why it's refused).
  const pickProfileAvatar = (file) => {
    if (!file) return
    if (!file.type.startsWith('image/') || file.type === 'image/gif') { uploadProfileAvatar(file); return }
    setAvatarCrop(file)
  }

  // ---- Private messages from a member list ----

  const openPrivateMessage = (target) => {
    if (!target?.username) { setToast("That member can't be messaged directly."); return }
    setPmError(null)
    setPmSending(false)
    setPmTarget(target)
  }

  const closePrivateMessage = () => {
    // Cancel must not send anything — the modal owns the draft and drops it with this state.
    setPmTarget(null)
    setPmError(null)
    setPmSending(false)
  }

  const sendPrivateMessage = async (text) => {
    const target = pmTarget
    const body = (text || '').trim()
    if (!target?.username || !body || pmSending) return
    setPmSending(true)
    setPmError(null)
    try {
      const t = token || localStorage.getItem('lanparty_token')
      const res = await fetch(`${SERVER_URL}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ toUsername: target.username, text: body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setPmError(data.error || 'Could not send that message.'); return }
      // Refresh the DM lists so the new conversation appears under Messages straight away.
      loadMessagesData()
      setToast(`Message sent to ${target.name || target.username}`)
      setPmTarget(null)
    } catch (_) {
      setPmError('Network error — the message was not sent.')
    } finally {
      setPmSending(false)
    }
  }

  // ---- Custom rail tile images (Home tile + server icons) ----

  // Open the OS picker for a tile. The chosen file goes to the crop modal, never straight to upload:
  // the tile is square, so an uncropped photo would be silently centre-cropped by CSS instead of by
  // the person who picked it.
  const openTileImagePicker = (target) => {
    tileTargetRef.current = target
    if (tileFileInputRef.current) {
      tileFileInputRef.current.value = '' // re-picking the same file must still fire onChange
      tileFileInputRef.current.click()
    }
  }

  const onTileFilePicked = (e) => {
    const file = e.target.files && e.target.files[0]
    const target = tileTargetRef.current
    if (!file || !target) return
    if (!file.type.startsWith('image/')) { setToast('Tile image must be an image file.'); return }
    setTileCrop({ target, file })
  }

  // Upload the cropped square. The modal hands over a small re-encoded file, so this is a plain POST.
  const uploadTileImage = async (cropped) => {
    const target = tileCrop?.target
    if (!target || !cropped) return
    const t = token || localStorage.getItem('lanparty_token')
    const path = target.kind === 'home' ? '/profile/home-tile' : `/servers/${target.id}/icon`
    const fd = new FormData()
    fd.append('image', cropped)
    const res = await fetch(`${SERVER_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setToast(data.error || 'Could not save the tile image'); return }
    if (target.kind === 'home') {
      // Mirror it into both settings copies: `userSettings` drives the rail, and the settings modal
      // saves `editingSettings` wholesale — a stale copy there would wipe the tile on the next save.
      setUserSettings((s) => ({ ...(s || {}), homeTileUrl: data.url }))
      setEditingSettings((s) => (s ? { ...s, homeTileUrl: data.url } : s))
      setToast('Home tile updated')
    } else {
      // The server broadcasts servers:updated, so the rail (and every other member's) refreshes itself.
      setToast(`${target.name || 'Server'} icon updated`)
    }
    setTileCrop(null)
  }

  const resetTileImage = async (target) => {
    const t = token || localStorage.getItem('lanparty_token')
    const path = target.kind === 'home' ? '/profile/home-tile' : `/servers/${target.id}/icon`
    const res = await fetch(`${SERVER_URL}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setToast(data.error || 'Could not reset the tile image'); return }
    if (target.kind === 'home') {
      setUserSettings((s) => { const next = { ...(s || {}) }; delete next.homeTileUrl; return next })
      setEditingSettings((s) => { if (!s) return s; const next = { ...s }; delete next.homeTileUrl; return next })
    }
    setToast('Tile image reset')
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
  // Whether the profile draft (or gaming profile draft) differs from what's saved. Drives the
  // floating Save/Cancel bar in the settings modal. `updatedAt` is excluded from the gaming
  // comparison because every edit stamps it.
  const gamingSignature = (g) => JSON.stringify({ genres: g?.genres || [], currentGames: g?.currentGames || '' })
  const profileDirty = useMemo(() => {
    if (!editingProfile) return false
    return (
      JSON.stringify(normalizeProfile(editingProfile)) !== JSON.stringify(normalizeProfile(profile)) ||
      gamingSignature(editingSettings?.gamingProfile) !== gamingSignature(userSettings?.gamingProfile)
    )
  }, [editingProfile, profile, editingSettings, userSettings])

  // Instant jump (not smooth): the exit from editor mode re-renders/collapses the form, which
  // cancels an in-flight smooth scroll and strands it partway.
  const scrollSettingsToTop = () => { if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = 0 }

  const saveProfile = () => {
    const normalized = normalizeProfile(editingProfile)
    setProfile(normalized)
    const gaming = editingSettings?.gamingProfile
    const patch = gaming ? { profile: normalized, gamingProfile: gaming } : { profile: normalized }
    patchUserSettings(patch)
    setUserSettings((prev) => ({ ...(prev || {}), ...patch }))
    setShowProfileEditor(false)
    setToast('Profile saved')
    scrollSettingsToTop()
  }

  // Discard in-progress profile edits and leave Edit Profile mode (nothing is persisted until Save).
  const cancelProfileEdit = () => {
    setEditingProfile(normalizeProfile(profile))
    setEditingSettings((s) => ({ ...(s || {}), gamingProfile: (userSettings && userSettings.gamingProfile) || { genres: [], currentGames: '' } }))
    setCustomTagInput('')
    setEditUsername(name || '')
    setShowProfileEditor(false)
    scrollSettingsToTop()
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

  // ---- History paging: the plumbing ----
  // Everything here reads the conversation on screen through refs, never through render state:
  // these functions are called from socket handlers (bound once, in connect) and scroll listeners.
  const patchHistoryMeta = (key, patch) => {
    const next = { ...historyMetaRef.current, [key]: { ...(historyMetaRef.current[key] || {}), ...patch } }
    historyMetaRef.current = next
    setHistoryMeta(next)
  }
  const dropHistoryMeta = (key) => {
    if (!(key in historyMetaRef.current)) return
    const next = { ...historyMetaRef.current }
    delete next[key]
    historyMetaRef.current = next
    setHistoryMeta(next)
  }
  // Every time a conversation's window is REPLACED (opened, jumped, returned to the present) its
  // sequence number moves on. A page request remembers the number it started under and throws its
  // answer away if the number has moved: that page belonged next to a window that is gone.
  const historySeq = (key) => chatHistoryLoadSeqRef.current[key] || 0
  const bumpHistorySeq = (key) => {
    chatHistoryLoadSeqRef.current[key] = historySeq(key) + 1
    return chatHistoryLoadSeqRef.current[key]
  }
  // While a window is being fetched, live messages are also kept aside: one that lands after the
  // server read the page but before the page is shown would otherwise be lost with the old window.
  const beginWindowFetch = (key) => {
    if (!windowFetchRef.current[key]) liveBufferRef.current[key] = []
    windowFetchRef.current[key] = (windowFetchRef.current[key] || 0) + 1
  }
  const endWindowFetch = (key) => {
    windowFetchRef.current[key] = Math.max(0, (windowFetchRef.current[key] || 0) - 1)
    if (!windowFetchRef.current[key]) delete liveBufferRef.current[key]
  }
  const takeLiveBuffer = (key) => {
    const held = liveBufferRef.current[key] || []
    if (windowFetchRef.current[key]) liveBufferRef.current[key] = []
    return held
  }
  // A live message for conversation `key` has arrived. True means "do not add it to the list":
  // the window on screen is detached, and the message will be there when the reader comes back.
  const holdLiveMessage = (key, message) => {
    if (windowFetchRef.current[key]) (liveBufferRef.current[key] = liveBufferRef.current[key] || []).push(message)
    const meta = historyMetaRef.current[key]
    if (!meta?.detached) return false
    patchHistoryMeta(key, { missed: (meta.missed || 0) + 1 })
    return true
  }

  // The conversation on screen, as what paging needs to ask the server for more of it.
  const currentHistoryTarget = () => {
    if (selectedServerIdRef.current === 'home') {
      const chat = homeChatRef.current
      if (!chat) return null
      const key = chatStorageKey(chat.id)
      if (chat.type === 'group') return { kind: 'group', key, groupId: chat.id }
      if (chat.type !== 'friend' && chat.type !== 'dm') return null
      return { kind: 'dm', key, peer: chat.peerUsername || chat.name }
    }
    const held = messagesChannelRef.current
    if (!held || held.serverId !== selectedServerIdRef.current) return null
    return { kind: 'channel', key: CHANNEL_HISTORY_KEY, serverId: held.serverId, channelId: held.channelId }
  }
  const historyList = (target) =>
    (target.kind === 'channel' ? messagesRef.current : homeMessagesRef.current[target.key]) || []
  const setHistoryList = (target, update) => {
    if (target.kind === 'channel') setMessages((prev) => update(prev))
    else setHomeMessages((prev) => ({ ...prev, [target.key]: update(prev[target.key] || []) }))
  }

  const fetchHistoryPage = async (target, params = {}) => {
    const t = token || localStorage.getItem('lanparty_token')
    const path = target.kind === 'channel'
      ? `/servers/${encodeURIComponent(target.serverId)}/channels/${encodeURIComponent(target.channelId)}/messages`
      : target.kind === 'group'
        ? `/groups/${encodeURIComponent(target.groupId)}/messages`
        : `/messages/with/${encodeURIComponent(target.peer)}`
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
    ).toString()
    const res = await fetch(`${SERVER_URL}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${t}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Couldn't load messages")
    return { messages: data.messages || [], hasMore: !!data.hasMore, hasMoreAfter: !!data.hasMoreAfter }
  }

  // A page request failed. Nothing asks again for a few seconds (the edge check runs the moment the
  // row stops saying "loading", so a server that is down would otherwise be asked in a tight loop),
  // and then the edges are looked at once more: a reader parked at the very top makes no further
  // scroll events, so without that second look the page would simply never be asked for again.
  const pauseHistoryPaging = () => {
    olderRetryAtRef.current = Date.now() + 4000
    setTimeout(() => historyFnsRef.current.checkEdges?.(), 4100)
  }

  // Replacing a window moves the sequence number on before the new page is fetched, which makes any
  // older/newer page still in flight give up without touching its "loading" flag. That is right
  // when the new window arrives (it resets the flags). When it does not, the old window is still on
  // screen, and it would say "Loading…" and refuse to page for good.
  const clearHistoryLoading = (key) => {
    const meta = historyMetaRef.current[key]
    if (meta && (meta.loadingOlder || meta.loadingNewer)) patchHistoryMeta(key, { loadingOlder: false, loadingNewer: false })
  }

  // The reader is at the newest messages of a conversation: move the server's read marker there and
  // clear the badge. Never called for a detached window. Its newest messages have not been shown,
  // and marking them read would lose their unread badge for good.
  const markHistoryRead = (target) => {
    if (target.kind === 'channel') {
      socketRef.current?.emit('channel:read', { serverId: target.serverId, channelId: target.channelId })
      clearChannelUnread(target.serverId, target.channelId)
    } else if (target.kind === 'dm') {
      markConversationRead(target.peer, token || localStorage.getItem('lanparty_token'))
    } else {
      const t = token || localStorage.getItem('lanparty_token')
      fetch(`${SERVER_URL}/groups/${encodeURIComponent(target.groupId)}/read`, {
        method: 'POST', headers: { Authorization: `Bearer ${t}` },
      }).catch(() => {})
      setGroupUnread((prev) => {
        if (!(target.groupId in prev)) return prev
        const next = { ...prev }
        delete next[target.groupId]
        return next
      })
    }
  }

  // Replace a conversation's window with one page. Callers bump the sequence number first.
  const showHistoryWindow = (target, page, detached) => {
    // Reaching the present means live messages apply again, including any that arrived mid-fetch.
    const late = detached ? [] : takeLiveBuffer(target.key)
    setHistoryList(target, () => mergeHistory(page.messages, late))
    patchHistoryMeta(target.key, { hasMore: page.hasMore, detached, missed: 0, loadingOlder: false, loadingNewer: false })
  }

  // The reader is near the top and older messages exist: fetch the page before the oldest loaded.
  const loadOlderMessages = async () => {
    const target = currentHistoryTarget()
    if (!target || windowFetchRef.current[target.key]) return
    const meta = historyMetaRef.current[target.key]
    if (!meta?.hasMore || meta.loadingOlder || Date.now() < olderRetryAtRef.current) return
    const before = edgeMessageId(historyList(target), Math.min)
    if (before == null) return
    const seq = historySeq(target.key)
    patchHistoryMeta(target.key, { loadingOlder: true })
    try {
      const page = await fetchHistoryPage(target, { before })
      if (historySeq(target.key) !== seq) return
      const list = messagesListRef.current
      if (list && currentHistoryTarget()?.key === target.key) {
        pendingScrollRef.current = { fromBottom: list.scrollHeight - list.scrollTop }
      }
      setHistoryList(target, (prev) => mergeHistory(page.messages, prev))
      // An empty page ends it whatever the flag says; otherwise the edge check would ask again forever.
      patchHistoryMeta(target.key, { hasMore: page.hasMore && page.messages.length > 0, loadingOlder: false })
    } catch (err) {
      console.warn('loadOlderMessages failed', err)
      pauseHistoryPaging()
      if (historySeq(target.key) === seq) patchHistoryMeta(target.key, { loadingOlder: false })
    }
  }

  // The reader reached the bottom of a detached window: fetch the page after the newest loaded.
  // The last such page reattaches the window to the present.
  const loadNewerMessages = async () => {
    const target = currentHistoryTarget()
    if (!target || windowFetchRef.current[target.key]) return
    const meta = historyMetaRef.current[target.key]
    if (!meta?.detached || meta.loadingNewer || Date.now() < olderRetryAtRef.current) return
    const after = edgeMessageId(historyList(target), Math.max)
    if (after == null) return
    const seq = historySeq(target.key)
    patchHistoryMeta(target.key, { loadingNewer: true })
    beginWindowFetch(target.key)
    try {
      const page = await fetchHistoryPage(target, { after })
      if (historySeq(target.key) !== seq) return
      const detached = page.hasMoreAfter && page.messages.length > 0
      const incoming = detached ? page.messages : [...page.messages, ...takeLiveBuffer(target.key)]
      const known = new Set(historyList(target).map((m) => String(m.id)))
      if (incoming.some((m) => !known.has(String(m.id)))) skipFollowRef.current = true
      setHistoryList(target, (prev) => mergeHistory(prev, incoming))
      patchHistoryMeta(target.key, { detached, loadingNewer: false, ...(detached ? {} : { missed: 0 }) })
      // Read markers stood still while the window was detached; this page is where they catch up.
      if (!detached && currentHistoryTarget()?.key === target.key) markHistoryRead(target)
    } catch (err) {
      console.warn('loadNewerMessages failed', err)
      pauseHistoryPaging()
      if (historySeq(target.key) === seq) patchHistoryMeta(target.key, { loadingNewer: false })
    } finally {
      endWindowFetch(target.key)
    }
  }

  // Called on every scroll and after every change to the list: is either edge close enough to
  // want its next page? Both loaders refuse to run twice at once, so calling this often is cheap.
  const checkHistoryEdges = () => {
    const list = messagesListRef.current
    if (!list) return
    const target = currentHistoryTarget()
    const meta = target && historyMetaRef.current[target.key]
    if (!meta) return
    if (meta.hasMore && list.scrollTop < 240) loadOlderMessages()
    if (meta.detached && list.scrollHeight - list.scrollTop - list.clientHeight < 240) loadNewerMessages()
  }

  // Scroll a loaded message into view and flash it. False when it is not in the loaded window.
  const flashMessage = (messageId, smooth) => {
    const list = messagesListRef.current
    if (!list) return false
    const el = list.querySelector(`[data-mid="${CSS.escape(String(messageId))}"]`)
    if (!el) return false
    stickToBottomRef.current = false // jumping away from the bottom on purpose
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
    el.classList.remove('msg-jump-flash')
    void el.offsetWidth // restart the animation when the same message is jumped to twice
    el.classList.add('msg-jump-flash')
    setTimeout(() => el.classList.remove('msg-jump-flash'), 1600)
    return true
  }

  // Show the page of history around one message (a search result, or a pin that is not loaded)
  // and flash it. `onFail` is for a conversation opened just for this: it still needs something.
  const loadHistoryAround = async (target, messageId, { markRead = false, onFail } = {}) => {
    const seq = bumpHistorySeq(target.key)
    beginWindowFetch(target.key)
    try {
      // The server is never asked to mark read here: it would mark the whole conversation, and
      // this page may stop short of its newest messages.
      const page = await fetchHistoryPage(target, { around: messageId })
      if (historySeq(target.key) !== seq) return
      // A home chat left while this was on its way. Showing the page now would store a detached
      // window for a conversation nobody is looking at: its live messages would be held back, and
      // the next visit would open on last month. Dropped instead; coming back loads the newest page.
      if (target.kind !== 'channel' && currentHistoryTarget()?.key !== target.key) {
        clearHistoryLoading(target.key)
        return
      }
      bumpHistorySeq(target.key) // pages requested for the window this replaces are now stale
      showHistoryWindow(target, page, page.hasMoreAfter)
      if (page.messages.some((m) => String(m.id) === String(messageId))) {
        setJumpHighlight({ key: target.key, id: messageId, n: Date.now() })
      } else {
        setToast('That message is no longer there')
      }
      if (markRead && !page.hasMoreAfter) markHistoryRead(target)
    } catch (err) {
      console.warn('loadHistoryAround failed', err)
      if (historySeq(target.key) !== seq) return
      clearHistoryLoading(target.key)
      setToast("Couldn't load that message")
      if (onFail) onFail()
    } finally {
      endWindowFetch(target.key)
    }
  }

  // Back to the newest page and to normal live behaviour. Resolves once that is done (or failed).
  const jumpToPresent = async () => {
    const target = currentHistoryTarget()
    if (!target) return
    const seq = bumpHistorySeq(target.key)
    beginWindowFetch(target.key)
    try {
      const page = await fetchHistoryPage(target)
      if (historySeq(target.key) !== seq) return
      bumpHistorySeq(target.key)
      if (currentHistoryTarget()?.key === target.key) pendingScrollRef.current = { toBottom: true }
      showHistoryWindow(target, page, false)
      markHistoryRead(target)
    } catch (err) {
      console.warn('jumpToPresent failed', err)
      if (historySeq(target.key) !== seq) return
      clearHistoryLoading(target.key)
      setToast("Couldn't load the latest messages")
    } finally {
      endWindowFetch(target.key)
    }
  }
  // Sending from a detached window: return to the present first, so the new message appears where
  // it actually is rather than being held back with the other live ones.
  const ensureLiveHistory = async () => {
    const target = currentHistoryTarget()
    if (target && historyMetaRef.current[target.key]?.detached) await jumpToPresent()
  }

  // See the effect that calls this: a detached window does not outlive the visit that made it.
  const leaveConversation = (homeKey, serverId, channelId) => {
    if (homeKey) {
      if (!historyMetaRef.current[homeKey]?.detached) return
      bumpHistorySeq(homeKey)
      setHomeMessages((prev) => {
        if (!(homeKey in prev)) return prev
        const next = { ...prev }
        delete next[homeKey]
        return next
      })
      dropHistoryMeta(homeKey)
      return
    }
    // Only if the list still IS the channel being left: by the time this runs the next channel's
    // history may already have arrived, and that must not be cleared.
    const held = messagesChannelRef.current
    if (!historyMetaRef.current[CHANNEL_HISTORY_KEY]?.detached) return
    if (!held || held.serverId !== serverId || held.channelId !== channelId) return
    bumpHistorySeq(CHANNEL_HISTORY_KEY)
    messagesChannelRef.current = null
    setMessages([])
    dropHistoryMeta(CHANNEL_HISTORY_KEY)
  }

  // The channel list is about to be emptied for a switch: forget its paging state with it, so
  // nothing pages or holds back live messages against a list that is no longer there.
  const resetChannelHistory = () => {
    bumpHistorySeq(CHANNEL_HISTORY_KEY)
    messagesChannelRef.current = null
    dropHistoryMeta(CHANNEL_HISTORY_KEY)
  }

  // See the effect that calls this. "Nothing loaded" is the missing paging state, not an empty list:
  // a conversation with no messages has been loaded too. One already being fetched is left alone.
  const loadHomeChatIfMissing = () => {
    const target = currentHistoryTarget()
    if (!target || target.kind === 'channel') return
    if (historyMetaRef.current[target.key] || windowFetchRef.current[target.key]) return
    if (target.kind === 'group') loadGroupHistory(target.groupId)
    else loadHomeChatHistory(target.peer, target.key)
  }

  historyFnsRef.current = {
    checkEdges: checkHistoryEdges,
    flashMessage,
    leaveConversation,
    loadHomeChatIfMissing,
    currentKey: () => currentHistoryTarget()?.key,
    isDetached: () => {
      const target = currentHistoryTarget()
      return Boolean(target && historyMetaRef.current[target.key]?.detached)
    },
  }

  const appendHomeMessage = (chatKey, message) => {
    const key = chatStorageKey(chatKey)
    if (!message?.id) return
    if (holdLiveMessage(key, message)) return
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
    const seq = bumpHistorySeq(key)
    beginWindowFetch(key)
    try {
      // No cursor: the newest page. Older ones are fetched as the reader scrolls up.
      const res = await fetch(
        `${SERVER_URL}/messages/with/${encodeURIComponent(peerUsername)}?markRead=1`,
        { headers: { Authorization: `Bearer ${t}` } }
      )
      if (!res.ok) { if (historySeq(key) === seq) clearHistoryLoading(key); return }
      const data = await res.json()
      if (historySeq(key) !== seq) return
      bumpHistorySeq(key) // a page requested for the list this replaces no longer fits
      const messages = (data.messages || []).map((m, i) => ({
        ...m,
        id: m.id ?? `${key}-${m.ts}-${i}`,
      }))
      showHistoryWindow({ kind: 'dm', key }, { messages, hasMore: !!data.hasMore }, false)
      await loadMessagesData(t)
    } catch (err) {
      console.warn('loadHomeChatHistory failed', err)
      if (historySeq(key) === seq) clearHistoryLoading(key)
    } finally {
      endWindowFetch(key)
    }
  }

  // A group's history. Fetching it also marks it read on the server, which clears the badge in your
  // other windows (group:read).
  const loadGroupHistory = async (groupId, authToken) => {
    const t = authToken || token || localStorage.getItem('lanparty_token')
    if (!t || !groupId) return
    const key = chatStorageKey(groupId)
    const seq = bumpHistorySeq(key)
    beginWindowFetch(key)
    try {
      const res = await fetch(`${SERVER_URL}/groups/${encodeURIComponent(groupId)}/messages?markRead=1`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (!res.ok) { if (historySeq(key) === seq) clearHistoryLoading(key); return }
      const data = await res.json()
      if (historySeq(key) !== seq) return
      bumpHistorySeq(key)
      showHistoryWindow({ kind: 'group', key }, { messages: data.messages || [], hasMore: !!data.hasMore }, false)
    } catch (err) {
      console.warn('loadGroupHistory failed', err)
      if (historySeq(key) === seq) clearHistoryLoading(key)
    } finally {
      endWindowFetch(key)
    }
  }

  // Authenticated JSON call for the group endpoints. Throws with the server's message on failure.
  const groupRequest = async (method, path, body) => {
    const t = token || localStorage.getItem('lanparty_token')
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Something went wrong')
    return data
  }

  // Insert or refresh one group in the list (from a create/rename/add, or a group:updated push).
  const upsertGroupChat = (group) => {
    const me = localStorage.getItem('lanparty_user') || name
    const chat = toGroupChat(group, me)
    setGroupChats((prev) => {
      const i = prev.findIndex((g) => String(g.id) === String(chat.id))
      if (i < 0) return [chat, ...prev]
      const next = [...prev]
      next[i] = chat
      return next
    })
    setHomeChat((prev) => (prev?.type === 'group' && String(prev.id) === String(chat.id) ? { ...prev, name: chat.name } : prev))
    return chat
  }

  // Forget a group you left or were removed from, closing it if it's open.
  const dropGroupChat = (groupId) => {
    const without = (prev) => {
      if (!(groupId in prev)) return prev
      const next = { ...prev }
      delete next[groupId]
      return next
    }
    setGroupChats((prev) => prev.filter((g) => String(g.id) !== String(groupId)))
    setGroupUnread(without)
    setHomeMessages(without)
    if (homeChatRef.current?.type === 'group' && String(homeChatRef.current.id) === String(groupId)) {
      setHomeChat(null)
      setSelectedGroupId(null)
      setShowMembersPanel(false)
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
    if (settings.uiSounds && typeof settings.uiSounds === 'object') {
      const on = settings.uiSounds.enabled !== false // default on
      const vol = typeof settings.uiSounds.volume === 'number' ? settings.uiSounds.volume : 0.5
      setUiSoundsEnabled(on)
      setUiSoundVolume(vol)
      setUiSoundPrefs({ enabled: on, volume: vol })
    }
    if (Array.isArray(settings.quickReactions) && settings.quickReactions.length > 0 && settings.quickReactions.every((e) => typeof e === 'string' && e)) {
      setQuickReactions(settings.quickReactions.slice(0, MESSAGE_REACTIONS.length))
    }
    if (settings.profile && typeof settings.profile === 'object') setProfile(normalizeProfile(settings.profile))
  }

  const connect = (userName, t) => {
    markBoot('connect', 'active')
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
      // A joined app frame belongs to the previous socket. (On the very first connect nothing is
      // listening for this.)
      notifyAppHostRef.current({ type: 'reconnected' })
      // The usual reason for a reconnect is the server restarting for a deploy.
      checkForUpdateRef.current(false)
      // The app list, and with it whether this account is an instance owner (the review badge on
      // the rail). Also what catches up on app notifications missed while the socket was down.
      loadPublicApps(authToken)
      markBoot('connect', 'done')
      markBoot('sync', 'active')
      // allSettled, not all: one failing fetch must not strand the splash. The individual loaders
      // already swallow and log their own errors, so this is belt & braces.
      Promise.allSettled([
        loadFriendsData(authToken),
        loadMessagesData(authToken),
        loadServers(),
        loadUnreads(),
      ]).then(() => {
        markBoot('sync', 'done')
        setBootDone(true)
      })
    })
    s.on('friend:pending-updated', () => loadFriendsData(authToken))
    s.on('friend:list-updated', () => { loadFriendsData(authToken); loadMessagesData(authToken) })
    // Someone accepted the request WE sent. Distinct from friend:list-updated (which also fires on
    // unfriend), so this is the only place it's safe to celebrate.
    s.on('friend:request-accepted', ({ by } = {}) => {
      playUiSound('success')
      if (by) setToast(`${by} accepted your friend request`)
    })
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
      if (fromUsername) clearTyping(`dm:${fromUsername}`, fromUsername)
      const viewingThisDm = homeChatRef.current?.peerUsername === fromUsername &&
        selectedServerIdRef.current === 'home'
      if (fromUsername && fromUsername !== userName) playUiSound(viewingThisDm && !document.hidden ? 'receive' : 'notify')
      // Open, but on an older stretch: the message was held back, not shown, so it stays unread
      // until the reader returns to the present.
      const heldBack = viewingThisDm && !document.hidden && Boolean(historyMetaRef.current[chatKey]?.detached)
      if (heldBack) {
        loadMessagesData(authToken)
      } else if (viewingThisDm && !document.hidden) {
        markConversationRead(fromUsername, authToken)
      } else {
        loadMessagesData(authToken)
        maybeNotify('dm', { author: fromUsername, preview: (message?.text || '').slice(0, 120) || 'New direct message' })
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
      setServerState({ server: data.server, members, myRole: data.myRole || 'member' })
    })
    // Membership events: added to / removed from / kicked out of a server.
    s.on('server:invited', ({ name: srvName } = {}) => { loadServers(); if (srvName) setToast(`You were added to ${srvName}`) })
    s.on('server:removed', ({ serverId } = {}) => {
      loadServers()
      if (selectedServerIdRef.current === serverId) setSelectedServerId('home')
    })
    // Community app review (server/routes/library.js). Each carries { id, name, status } and
    // nothing else, so the list is fetched again: GET /apps is where the details and the
    // visibility rules live. 'deleted' is not a real status, only how a removal is announced.
    const appLabel = (appName) => (typeof appName === 'string' && appName ? `“${appName.slice(0, 80)}”` : 'An app')
    // To instance owners: an app is waiting for review.
    s.on('app:submitted', ({ name: appName } = {}) => {
      loadPublicApps(authToken)
      setToast(`${appLabel(appName)} was submitted for review`)
    })
    // To instance owners: something they list changed some other way. Counts only, no toast.
    s.on('app:review-queue', () => loadPublicApps(authToken))
    // To the uploader: someone else decided about their app.
    s.on('app:reviewed', ({ name: appName, status } = {}) => {
      loadPublicApps(authToken)
      const label = appLabel(appName).replace(/^An app$/, 'Your app')
      if (status === 'published') { playUiSound('success'); setToast(`${label} was approved and is now published`) }
      else if (status === 'rejected') setToast(`${label} was sent back for changes — see App Directory → Developer`)
      else if (status === 'draft') setToast(`${label} was unpublished by an instance owner`)
      else if (status === 'deleted') setToast(`${label} was removed by an instance owner`)
    })
    s.on('server:denied', ({ serverId } = {}) => {
      if (selectedServerIdRef.current === serverId) setSelectedServerId('home')
      loadServers()
    })
    // messages:init is `{ serverId, channelId, messages, hasMore }`: the newest page of the channel
    // just entered, and whether older ones exist (older array shape still accepted).
    s.on('messages:init', (payload) => {
      // Ignore history for a server we're no longer viewing (e.g. a stale join racing a
      // restored view) so it can't clobber the current channel's list.
      if (payload && !Array.isArray(payload) && payload.serverId) {
        const viewServer = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
        if (payload.serverId !== viewServer) return
      }
      const msgs = Array.isArray(payload) ? payload : (payload && payload.messages) || []
      const tagged = payload && !Array.isArray(payload) && payload.serverId && payload.channelId
      const jump = pendingJumpRef.current
      const jumpingHere = jump && tagged && jump.serverId === payload.serverId && jump.channelId === payload.channelId
      // The channel already on screen, sent again: a reconnect (and the resync after a refused send)
      // re-joins the server, and the answer is only the newest page. Replacing the list with it
      // would throw away every older page the reader had scrolled through, and their place in them.
      const held = messagesChannelRef.current
      const meta = historyMetaRef.current[CHANNEL_HISTORY_KEY]
      if (tagged && !jumpingHere && meta && held && held.serverId === payload.serverId && held.channelId === payload.channelId) {
        // Reading an older stretch: it stays. The present is one "Jump to present" away.
        if (meta.detached) return
        // Otherwise keep what is loaded and add what was missed, provided the two join up. If they
        // do not (more than a page arrived while away) there would be a hole, so start afresh below.
        const loaded = new Set(messagesRef.current.map((m) => String(m.id)))
        if (msgs.some((m) => loaded.has(String(m.id)))) {
          setMessages((prev) => mergeHistory(msgs, prev))
          return
        }
      }
      messagesChannelRef.current = tagged ? { serverId: payload.serverId, channelId: payload.channelId } : null
      // A fresh window: pages still on their way for the previous one must not be spliced into it.
      bumpHistorySeq(CHANNEL_HISTORY_KEY)
      setMessages(oldestMessagesFirst(msgs))
      patchHistoryMeta(CHANNEL_HISTORY_KEY, {
        hasMore: tagged ? !!payload.hasMore : false, detached: false, missed: 0, loadingOlder: false, loadingNewer: false,
      })
      // Arrived here to show one message (a search result)? It is either on this page already, or
      // further back, in which case the page around it replaces this one.
      if (jumpingHere) {
        pendingJumpRef.current = null
        clearTimeout(jump.timer)
        if (msgs.some((m) => String(m.id) === String(jump.messageId))) {
          setJumpHighlight({ key: CHANNEL_HISTORY_KEY, id: jump.messageId, n: Date.now() })
        } else {
          loadHistoryAround({ kind: 'channel', key: CHANNEL_HISTORY_KEY, serverId: payload.serverId, channelId: payload.channelId }, jump.messageId)
        }
      }
    })
    s.on('channel:joined', ({ serverId, channelId } = {}) => {
      if (!channelId) return
      // Same staleness guard as messages:init: a late join answer for another server must not
      // overwrite the restored channel (that mismatch made sends fail the server's gate).
      if (serverId) {
        const viewServer = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
        if (serverId !== viewServer) return
      }
      setActiveChannel(channelId)
      setChannelPins([]) // cleared until the fresh pins:updated for this channel arrives
      clearChannelUnread(serverId || selectedServerIdRef.current, channelId)
    })
    // A channel send was rejected (stale server/channel pairing — e.g. mid-resync). Surface it,
    // put the text back so nothing is lost, and re-join the current view to resync rooms.
    s.on('message:error', ({ text: failedText } = {}) => {
      setToast("Couldn't send — resynced with the server. Please try again.")
      if (failedText) setText((cur) => cur || failedText)
      const sid = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
      s.emit('join', { serverId: sid, name: userName || name })
    })
    // Pinned-message list for a channel changed (or arrived on join).
    s.on('pins:updated', ({ serverId, channelId, pins } = {}) => {
      const viewServer = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
      if (serverId === viewServer && channelId === activeChannelRef.current) setChannelPins(pins || [])
    })
    s.on('message', (msg) => {
      // Drop messages that aren't for the server+channel currently on screen (rooms should already
      // guarantee this; the tag check is belt & braces against any stale room membership).
      if (msg && msg.serverId && msg.channelId) {
        const viewServer = selectedServerIdRef.current !== 'home' ? selectedServerIdRef.current : 'demo'
        if (msg.serverId !== viewServer || msg.channelId !== activeChannelRef.current) return
        // We're looking at this channel right now — advance our read marker so a reload
        // doesn't count what we just watched arrive. Not while reading an older stretch of it: the
        // message is held back below, and something never shown must not be marked read.
        if (selectedServerIdRef.current !== 'home' && !historyMetaRef.current[CHANNEL_HISTORY_KEY]?.detached) {
          s.emit('channel:read', { serverId: msg.serverId, channelId: msg.channelId })
        }
      }
      if (msg && msg.author && msg.author !== userName) playUiSound('receive')
      // Their message has arrived, so they are no longer "typing" it.
      if (msg && msg.author) clearTyping(`channel:${msg.serverId}:${msg.channelId}`, msg.author)
      // Looking at an older stretch of this channel: the message waits for "Jump to present".
      if (holdLiveMessage(CHANNEL_HISTORY_KEY, msg)) return
      setMessages(prev => {
        if (prev.some((m) => m.id === msg.id)) return prev
        return oldestMessagesFirst([...prev, msg])
      })
    })
    // A channel got a new message somewhere — bump its unread badge unless we're watching it.
    s.on('unread:bump', (bump = {}) => {
      const { serverId, channelId, author } = bump
      if (!serverId || !channelId) return
      if (author && author === userName) return // our own message
      const viewingIt = selectedServerIdRef.current === serverId && activeChannelRef.current === channelId
      // A detached window is not showing this message, so it counts as unread like any other.
      const heldBack = Boolean(historyMetaRef.current[CHANNEL_HISTORY_KEY]?.detached)
      if (viewingIt && !document.hidden && !heldBack) { s.emit('channel:read', { serverId, channelId }); return }
      setChannelUnreads((prev) => {
        const srv = { ...(prev[serverId] || {}) }
        srv[channelId] = (srv[channelId] || 0) + 1
        return { ...prev, [serverId]: srv }
      })
      // Named in a channel I am not looking at: its own badge and its own sound, so it stands out
      // from ordinary chatter (which makes no sound at all from another channel).
      if ((bump.mentions || []).includes(userName)) {
        setChannelMentions((prev) => {
          const srv = { ...(prev[serverId] || {}) }
          srv[channelId] = (srv[channelId] || 0) + 1
          return { ...prev, [serverId]: srv }
        })
        playUiSound('mention')
      }
      maybeNotify('channel', bump)
    })
    // Someone started typing in a conversation. Keyed the same way the composer works out which
    // conversation is on screen (see renderComposer), so the line shows only where it belongs.
    s.on('typing', (p = {}) => {
      if (!p.from || p.from === userName) return
      const key = p.scope === 'channel' ? `channel:${p.serverId}:${p.channelId}`
        : p.scope === 'dm' ? `dm:${p.from}`
          : p.scope === 'group' ? `group:${p.groupId}` : null
      if (!key) return
      setTypingBy((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), [p.from]: Date.now() + TYPING_SHOWN_MS } }))
    })
    // A server was created/removed somewhere — refresh the rail.
    s.on('servers:updated', () => { loadServers() })
    // Spotify OAuth fallback: if the popup couldn't postMessage (blocked opener), the server
    // delivers the tokens over the socket instead. Stored locally; the Music activity reacts.
    s.on('spotify:auth', (payload) => {
      if (!payload?.access_token) return
      localStorage.setItem('lanparty_spotify', JSON.stringify({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        expires_at: Date.now() + ((payload.expires_in || 3600) - 60) * 1000,
      }))
      window.dispatchEvent(new CustomEvent('lanparty:spotify-auth'))
    })

    // Persisted reaction changed — apply the authoritative counts (mine computed for this user).
    s.on('reaction:updated', ({ scope, groupId, messageId, reactions }) => {
      const formatted = formatReactions(reactions, userName)
      if (scope === 'group') {
        setHomeMessages((prev) => {
          const key = chatStorageKey(groupId)
          if (!prev[key]) return prev
          return { ...prev, [key]: prev[key].map((m) => (String(m.id) === String(messageId) ? { ...m, reactions: formatted } : m)) }
        })
        return
      }
      if (scope === 'dm') {
        setHomeMessages((prev) => {
          let changed = false
          const next = {}
          for (const key of Object.keys(prev)) {
            if (isGroupChatKey(key)) { next[key] = prev[key]; continue }
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
    // A channel message was edited (by its author, perhaps in another window) — show the new text.
    s.on('message:edited', ({ id, text }) => setMessages((prev) =>
      prev.map((m) => (String(m.id) === String(id) ? { ...m, text, edited: true } : m))
    ))
    // A DM was edited — update it in whichever conversation holds it, and refresh the previews.
    s.on('dm:message-edited', ({ id, text }) => {
      setHomeMessages((prev) => {
        let changed = false
        const next = {}
        for (const key of Object.keys(prev)) {
          if (isGroupChatKey(key)) { next[key] = prev[key]; continue }
          next[key] = prev[key].map((m) => {
            if (String(m.id) !== String(id)) return m
            changed = true
            return { ...m, text, edited: true }
          })
        }
        return changed ? next : prev
      })
      loadMessagesData(authToken)
    })
    // A DM was deleted — drop that message id from any conversation it appears in.
    s.on('dm:message-deleted', ({ id }) => setHomeMessages((prev) => {
      let changed = false
      const next = {}
      for (const key of Object.keys(prev)) {
        if (isGroupChatKey(key)) { next[key] = prev[key]; continue }
        const arr = prev[key]
        const filtered = arr.filter((m) => String(m.id) !== String(id))
        if (filtered.length !== arr.length) changed = true
        next[key] = filtered
      }
      return changed ? next : prev
    }))

    // ---- Group chats: every change arrives here, for every member ----
    const isOpenGroup = (groupId) => homeChatRef.current?.type === 'group' &&
      String(homeChatRef.current.id) === String(groupId) && selectedServerIdRef.current === 'home'
    const clearGroupBadge = (groupId) => setGroupUnread((prev) => {
      if (!(groupId in prev)) return prev
      const next = { ...prev }
      delete next[groupId]
      return next
    })
    s.on('group:updated', ({ group } = {}) => {
      if (!group?.id) return
      upsertGroupChat(group)
      if (isOpenGroup(group.id)) return
      const n = group.unreadCount || 0
      if (n) setGroupUnread((prev) => (prev[group.id] === n ? prev : { ...prev, [group.id]: n }))
      else clearGroupBadge(group.id)
    })
    s.on('group:removed', ({ groupId } = {}) => {
      if (!groupId) return
      const group = groupChatsRef.current.find((g) => String(g.id) === String(groupId))
      const onPurpose = leavingGroupsRef.current.delete(String(groupId))
      dropGroupChat(groupId)
      if (!onPurpose && group) setToast(`You were removed from ${group.name}`)
    })
    s.on('group:message', ({ groupId, message } = {}) => {
      if (!groupId || !message) return
      appendHomeMessage(groupId, message)
      updateGroupConversationPreview(groupId, message)
      if (message.author) clearTyping(`group:${groupId}`, message.author)
      const me = localStorage.getItem('lanparty_user') || userName
      if (message.author === me) return
      const reading = isOpenGroup(groupId) && !document.hidden
      playUiSound(reading ? 'receive' : 'notify')
      // Open on an older stretch: held back and not shown, so it is unread until they come back.
      if (reading && historyMetaRef.current[chatStorageKey(groupId)]?.detached) {
        setGroupUnread((prev) => ({ ...prev, [groupId]: (prev[groupId] || 0) + 1 }))
        return
      }
      if (reading) {
        fetch(`${SERVER_URL}/groups/${encodeURIComponent(groupId)}/read`, {
          method: 'POST', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {})
        return
      }
      setGroupUnread((prev) => ({ ...prev, [groupId]: (prev[groupId] || 0) + 1 }))
      const group = groupChatsRef.current.find((g) => String(g.id) === String(groupId))
      maybeNotify('group', { author: message.author, groupId, groupName: group?.name, preview: (message.text || '').slice(0, 120) || 'Sent an attachment' })
    })
    s.on('group:read', ({ groupId } = {}) => { if (groupId) clearGroupBadge(groupId) })
    s.on('group:message-edited', ({ groupId, id, text } = {}) => setHomeMessages((prev) => {
      const key = chatStorageKey(groupId)
      if (!prev[key]) return prev
      return { ...prev, [key]: prev[key].map((m) => (String(m.id) === String(id) ? { ...m, text, edited: true } : m)) }
    }))
    s.on('group:message-deleted', ({ groupId, id } = {}) => {
      setHomeMessages((prev) => {
        const key = chatStorageKey(groupId)
        if (!prev[key]) return prev
        return { ...prev, [key]: prev[key].filter((m) => String(m.id) !== String(id)) }
      })
      loadGroupsData(authToken) // it may have been the message the conversation list previews
    })

    // Someone in the channel fired a soundboard clip — play it locally (replacing any current one).
    s.on('soundboard:play', ({ soundId, url }) => playSoundUrl(url, soundId))
    s.on('soundboard:stop', () => stopCurrentSound())

    // voice events — I (the newcomer) create a peer for each existing member; adding my tracks
    // triggers onnegotiationneeded, which sends the offer. Existing peers answer via voice:signal.
    s.on('voice:peers', (peers) => {
      setPeerNames((prev) => ({ ...prev, ...Object.fromEntries(peers.map((p) => [p.id, p.name])) }))
      // In SFU mode media comes via consumers, not P2P connections — no mesh peers.
      if (!sfuRef.current) { for (const p of peers) createPeer(p.id) }
      setInVoice(true)
    })
    s.on('voice:peer-joined', ({ id, name: peerName, entranceSound }) => {
      // The newcomer offers to us; we create our peer when their offer arrives (handleSignal).
      // Fires only for people arriving after us — the existing roster comes via voice:peers (silent).
      if (!id) return
      setPeerNames((prev) => ({ ...prev, [id]: peerName }))
      // Their own recorded entrance clip takes the place of the generic join blip. The url is
      // supplied by the server (looked up from their profile), never by the joining client.
      if (typeof entranceSound === 'string' && entranceSound.startsWith('/entrances/')) playUiClip(emojiSrc(entranceSound))
      else playUiSound('peerJoin')
    })
    s.on('voice:signal', ({ from, signal }) => { if (!sfuRef.current) handleSignal(from, signal) })
    // Direct 1:1 friend calls
    s.on('call:incoming', ({ from, fromSocket, video }) => onCallIncoming(from, fromSocket, video))
    s.on('call:accepted', ({ from, fromSocket }) => onCallAccepted(from, fromSocket))
    s.on('call:declined', () => onCallDeclined())
    s.on('call:canceled', () => onCallCanceled())
    s.on('call:ended', () => onCallEnded())
    s.on('call:unavailable', () => onCallUnavailable())
    s.on('call:handled', () => onCallHandledElsewhere())
    s.on('call:signal', ({ from, signal }) => handleCallSignal(from, signal))
    s.on('voice:peer-left', ({ id }) => { removePeer(id); playUiSound('peerLeave'); setPeerNames((prev) => { const c = { ...prev }; delete c[id]; return c }); setScreenSharingPeers((prev) => { const c = { ...prev }; delete c[id]; return c }) })
    s.on('voice:screenshare-state', ({ id, sharing }) => setScreenSharingPeers((prev) => ({ ...prev, [id]: sharing })))
    // Watch/Discover: the server pushes the full list of who's live whenever it changes.
    s.on('discover:update', (list) => setDiscoverStreams(Array.isArray(list) ? list : []))
    s.emit('discover:list')
    // Activities: the server pushes the current shared activity for our voice room (or null).
    s.on('activity:update', (a) => {
      const next = a && typeof a === 'object' ? a : null
      setActivity(next)
      if (next && next.type === 'app') notifyAppHostRef.current({ type: 'activity', activity: next })
    })
    // Someone joined or left the running app. Sent on its own, without the app's shared state, so
    // people coming and going do not cost everyone a copy of it.
    s.on('activity:app-joined', (m) => {
      if (!m || typeof m !== 'object' || !Array.isArray(m.joined)) return
      setActivity((prev) => (prev && prev.type === 'app' && prev.state && prev.state.run === m.run ? { ...prev, state: { ...prev.state, joined: m.joined } } : prev))
    })
    // A transient message from an uploaded app someone else in the room is running. Passed on as
    // data to the app's own frame and never rendered here.
    s.on('activity:app-message', (m) => {
      if (!m || typeof m !== 'object') return
      notifyAppHostRef.current({ type: 'message', from: typeof m.from === 'string' ? m.from : '', data: m.data })
    })
    // Fetch WebRTC ICE servers (STUN + any configured TURN) so calls connect across networks.
    fetch(`${SERVER_URL}/webrtc/ice`).then((r) => r.json()).then((d) => { if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceConfigRef.current = d.iceServers }).catch(() => {})

    // Collaborative image editing
    s.on('collab:invite', ({ sessionId, imageUrl, by }) => setCollabInvite({ sessionId, imageUrl, by }))
    s.on('collab:state', ({ segments }) => collabCanvasRef.current?.loadSegments(segments || []))
    s.on('collab:draw', ({ segment }) => collabCanvasRef.current?.drawSegment(segment))
    s.on('collab:clear', () => collabCanvasRef.current?.clearCanvas())
  }

  // First-login onboarding: show the welcome + gaming-profile flow only for brand-new accounts.
  // New users get settings.onboardingComplete === false from the server; existing users don't have
  // the flag, so `=== false` is false for them and they skip it.
  const maybeStartOnboarding = (settings) => {
    if (settings && settings.onboardingComplete === false) {
      setOnbGenres([])
      setOnbCurrentGames('')
      setOnbStep(0)
      setShowOnboarding(true)
    }
  }

  // Persist the gaming profile chosen during onboarding and mark it complete so it won't show again.
  const finishOnboarding = async (skip = false) => {
    setOnbSaving(true)
    const gamingProfile = {
      genres: skip ? [] : onbGenres.slice(0, 12),
      currentGames: skip ? '' : onbCurrentGames.trim().slice(0, 200),
      updatedAt: Date.now(),
    }
    const patch = { gamingProfile, onboardingComplete: true }
    setUserSettings((prev) => ({ ...(prev || {}), ...patch }))
    try { await patchUserSettings(patch) } catch (_) { /* best-effort; flag still set locally */ }
    setOnbSaving(false)
    setShowOnboarding(false)
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
      // First login for a new account → run the welcome + gaming-profile onboarding.
      maybeStartOnboarding(data.user.settings)

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
      const [loadedFriends, loadedConversations, loadedGroups] = await Promise.all([
        loadFriendsData(data.token),
        loadMessagesData(data.token),
        loadGroupsData(data.token),
      ])
      restoreSavedView({ username: data.user.username, friendsList: loadedFriends, conversations: loadedConversations, groups: loadedGroups, authToken: data.token })
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
        body: JSON.stringify({ username: regUsername, email: regEmail, password: regPassword, passwordConfirm: regPasswordConfirm })
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
      setForgotMessage(data.message || 'If that email exists, a reset link was sent.')
    } catch (err) {
      setForgotMessage(err.message)
    } finally { setAuthLoading(false) }
  }

  // Complete a password reset from the emailed link.
  const submitReset = async () => {
    setFlowError(null)
    if (!flowPassword || flowPassword !== flowPasswordConfirm) { setFlowError('Passwords do not match'); return }
    setFlowBusy(true)
    try {
      const res = await fetch(`${SERVER_URL}/auth/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: accountFlow.token, email: accountFlow.email, password: flowPassword, passwordConfirm: flowPasswordConfirm }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFlowError(data.error || 'Could not reset password'); return }
      setAccountFlow(null); setFlowPassword(''); setFlowPasswordConfirm('')
      setFlowDone('Password reset! Log in with your new password.')
    } catch (_) { setFlowError('Could not reach the server') } finally { setFlowBusy(false) }
  }

  // Confirm account deactivation from the emailed link → deletes the account, then signs out.
  const submitDeactivateConfirm = async () => {
    setFlowError(null); setFlowBusy(true)
    try {
      const res = await fetch(`${SERVER_URL}/account/deactivate/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: accountFlow.token, email: accountFlow.email }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFlowError(data.error || 'Could not deactivate the account'); return }
      try { socketRef.current?.disconnect() } catch (_) {}
      stopPush() // the server already dropped this account's subscriptions along with the account
      localStorage.removeItem('lanparty_token'); localStorage.removeItem('lanparty_user')
      setIsAuthenticated(false); setToken(null); setName('')
      setAccountFlow(null)
      setFlowDone('Your account has been deactivated. Sorry to see you go 💔')
    } catch (_) { setFlowError('Could not reach the server') } finally { setFlowBusy(false) }
  }

  // Start deactivation from Settings → emails a confirmation link.
  const requestDeactivate = async () => {
    if (!window.confirm('Delete your account? We’ll email a confirmation link. Confirming permanently deletes your account and all its data.')) return
    try {
      const t = token || localStorage.getItem('lanparty_token')
      const res = await fetch(`${SERVER_URL}/account/deactivate`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } })
      const data = await res.json().catch(() => ({}))
      setToast(res.ok ? 'Check your email to confirm deactivation.' : (data.error || 'Could not start deactivation'))
    } catch (_) { setToast('Could not reach the server') }
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
      resetChannelHistory()
      setMessages([])
      socketRef.current.emit('join', { serverId: id, name })
    }
  }

  // Promise-based text prompt via an in-app modal (window.prompt is unsupported in the Electron app).
  const askPrompt = (opts = {}) => new Promise((resolve) => {
    setPromptValue(opts.initial || '')
    setPromptModal({
      title: opts.title || 'Enter a value',
      label: opts.label || '',
      placeholder: opts.placeholder || '',
      submitLabel: opts.submitLabel || 'OK',
      resolve,
    })
  })
  const resolvePrompt = (value) => { promptModal?.resolve(value); setPromptModal(null) }

  const createServer = async () => {
    const serverName = ((await askPrompt({ title: 'Create a server', label: 'Server name', placeholder: 'e.g. Game Night', submitLabel: 'Create' })) || '').trim()
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

  // The "+" in a channel section opens the create-channel modal, pre-selecting that section's type.
  const createChannel = (type) => {
    setChannelModalType(type === 'voice' ? 'voice' : 'text')
    setShowChannelModal(true)
  }

  // Submit from the create-channel modal (name + chosen type + privacy).
  const submitCreateChannel = async ({ name: chName, type, privacy, members }) => {
    const sid = currentServerId()
    const t = token || localStorage.getItem('lanparty_token')
    try {
      const res = await fetch(`${SERVER_URL}/servers/${encodeURIComponent(sid)}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ name: chName, type, privacy, members: privacy === 'private' ? (members || []) : [] }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create channel')
      setShowChannelModal(false)
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
    const name2 = ((await askPrompt({ title: 'Rename server', label: 'Server name', initial: oldName || '', submitLabel: 'Rename' })) || '').trim()
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
    const name2 = ((await askPrompt({ title: 'Rename channel', label: 'Channel name', initial: oldName || '', submitLabel: 'Rename' })) || '').trim()
    if (!name2 || name2 === oldName) return
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: JSON.stringify({ name: name2 }) })
    if (!res.ok) alert((await res.json()).error || 'Rename failed')
  }

  const deleteChannel = async (channelId, chName) => {
    if (!window.confirm(`Delete #${chName}? Its messages will be permanently removed.`)) return
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' })
    if (!res.ok) alert((await res.json()).error || 'Delete failed')
  }

  // ---- Membership management (invite / leave / kick / roles) ----
  // Open the invite dialog for a server and load its current members (so friends already in show a ✓).
  const openServerInvite = async (serverId, serverName) => {
    if (!serverId || serverId === 'home' || serverId === 'demo') return
    const nm = serverName || serversList.find((s) => s.id === serverId)?.name || 'this server'
    setInviteModal({ serverId, serverName: nm })
    setInviteMembers(new Set())
    setInviteBusy(new Set())
    setInviteQuery('')
    setInviteLoadingMembers(true)
    try {
      const res = await authedFetch(`/servers/${encodeURIComponent(serverId)}/members`)
      if (res.ok) {
        const data = await res.json()
        setInviteMembers(new Set((data.members || []).map((m) => m.username)))
      }
    } catch (_) { /* leave empty; server still rejects dupes */ }
    finally { setInviteLoadingMembers(false) }
  }

  // Invite one friend (by username) to the currently-open invite dialog's server.
  const inviteFriendToServer = async (username) => {
    if (!inviteModal || !username) return
    setInviteBusy((prev) => new Set(prev).add(username))
    try {
      const res = await authedFetch(`/servers/${encodeURIComponent(inviteModal.serverId)}/invite`, { method: 'POST', body: JSON.stringify({ username }) })
      if (res.ok) {
        setInviteMembers((prev) => new Set(prev).add(username))
        setToast(`Invited ${username}`)
      } else {
        const err = (await res.json().catch(() => ({}))).error || 'Invite failed'
        // If they're somehow already in, reflect it; otherwise surface the error.
        if (/already a member/i.test(err)) setInviteMembers((prev) => new Set(prev).add(username))
        else setToast(err)
      }
    } catch (_) {
      setToast('Invite failed')
    } finally {
      setInviteBusy((prev) => { const n = new Set(prev); n.delete(username); return n })
    }
  }
  // Link controls in the invite dialog are for owner/admins. The rail already knows my role in each server.
  const inviteModalIsStaff = !!inviteModal && ['owner', 'admin'].includes(serversList.find((s) => s.id === inviteModal.serverId)?.role)
  // Accept the invite link this page was opened through, then land in the server it led to.
  const acceptServerInvite = async () => {
    const joined = await inviteJoin.accept(authedFetch)
    if (!joined) return // the dialog is already showing why
    // The rail must know the server before it is selected, or the tile highlight has nothing to land on.
    await loadServers()
    handleSelectServer(joined.server.id)
    setToast(joined.alreadyMember ? `You’re already in ${joined.server.name}` : `Joined ${joined.server.name}`)
  }
  const leaveServer = async (serverId, serverName2) => {
    if (!window.confirm(`Leave "${serverName2}"? You'll need a new invite to rejoin.`)) return
    const res = await authedFetch(`/servers/${encodeURIComponent(serverId)}/leave`, { method: 'POST' })
    if (!res.ok) { alert((await res.json()).error || 'Could not leave'); return }
    if (selectedServerId === serverId) setSelectedServerId('home')
  }
  const kickMember = async (username) => {
    if (!window.confirm(`Remove ${username} from this server?`)) return
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/members/${encodeURIComponent(username)}`, { method: 'DELETE' })
    if (!res.ok) alert((await res.json()).error || 'Could not remove member')
  }
  const setMemberRole = async (username, role) => {
    const res = await authedFetch(`/servers/${encodeURIComponent(currentServerId())}/members/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify({ role }) })
    if (res.ok) setToast(`${username} is now ${role === 'admin' ? 'an admin' : 'a member'}`)
    else alert((await res.json()).error || 'Could not change role')
  }

  // ---- Direct 1:1 friend calls (WebRTC, separate from server voice channels) ----
  const teardownCall = () => {
    try { callPcRef.current?.close() } catch (_) {}
    callPcRef.current = null
    if (callLocalStreamRef.current) { try { callLocalStreamRef.current.getTracks().forEach((t) => t.stop()) } catch (_) {} callLocalStreamRef.current = null }
    setCallRemoteStream(null)
    setCallMuted(false)
    setCallElapsed(0)
    setCall(null)
  }

  const startCallPeer = async (peerSocket, isCaller) => {
    const pc = new RTCPeerConnection({ iceServers: iceConfigRef.current })
    callPcRef.current = pc
    const ls = callLocalStreamRef.current
    if (ls) ls.getTracks().forEach((t) => pc.addTrack(t, ls))
    pc.onicecandidate = (e) => { if (e.candidate) socketRef.current?.emit('call:signal', { to: peerSocket, signal: { candidate: e.candidate } }) }
    pc.ontrack = (e) => { setCallRemoteStream(e.streams[0]) }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') setCall((c) => (c ? { ...c, status: 'connected', startedAt: c.startedAt || Date.now() } : c))
      else if ((st === 'failed' || st === 'closed' || st === 'disconnected') && callRef.current) teardownCall()
    }
    if (isCaller) {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socketRef.current?.emit('call:signal', { to: peerSocket, signal: { description: pc.localDescription } })
    }
  }

  const handleCallSignal = async (fromSocket, signal) => {
    const pc = callPcRef.current
    if (!pc) return
    try {
      if (signal.description) {
        await pc.setRemoteDescription(signal.description)
        if (signal.description.type === 'offer') {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          socketRef.current?.emit('call:signal', { to: fromSocket, signal: { description: pc.localDescription } })
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(signal.candidate)
      }
    } catch (err) { console.warn('call signal error', err) }
  }

  const startCall = async (peerUsername, withVideo = false) => {
    if (!peerUsername || callRef.current) return
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null), video: withVideo }) }
    catch (e) { alert('Microphone access is required to call.'); return }
    callLocalStreamRef.current = stream
    setCall({ status: 'outgoing', peer: peerUsername, peerSocket: null, video: withVideo })
    socketRef.current?.emit('call:invite', { to: peerUsername, video: withVideo })
  }

  const acceptCall = async () => {
    const c = callRef.current
    if (!c || c.status !== 'incoming') return
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null), video: c.video }) }
    catch (e) { declineCall(); return }
    callLocalStreamRef.current = stream
    setCall({ ...c, status: 'connecting' })
    await startCallPeer(c.peerSocket, false) // create the peer, then answer the caller's offer
    socketRef.current?.emit('call:accept', { to: c.peerSocket })
  }

  const declineCall = () => {
    const c = callRef.current
    if (c?.peerSocket) socketRef.current?.emit('call:decline', { to: c.peerSocket })
    teardownCall()
  }

  const hangUpCall = () => {
    const c = callRef.current
    if (c) {
      if (c.status === 'outgoing') socketRef.current?.emit('call:cancel', { to: c.peer })
      else if (c.peerSocket) socketRef.current?.emit('call:end', { to: c.peerSocket })
    }
    teardownCall()
  }

  const toggleCallMute = () => {
    setCallMuted((m) => {
      const next = !m
      callLocalStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next })
      return next
    })
  }

  // Reactions to inbound call socket events (bound in connect()).
  const onCallIncoming = (from, fromSocket, video) => {
    if (callRef.current) { socketRef.current?.emit('call:decline', { to: fromSocket }); return } // busy
    setCall({ status: 'incoming', peer: from, peerSocket: fromSocket, video: !!video })
  }
  const onCallAccepted = async (from, fromSocket) => {
    if (!callRef.current || callRef.current.status !== 'outgoing') return
    setCall((c) => (c ? { ...c, status: 'connecting', peerSocket: fromSocket } : c))
    await startCallPeer(fromSocket, true) // caller creates the offer once the callee accepts
  }
  const onCallDeclined = () => { if (callRef.current) { setToast(`${callRef.current.peer} declined`); teardownCall() } }
  const onCallCanceled = () => { if (callRef.current?.status === 'incoming') teardownCall() }
  const onCallEnded = () => { if (callRef.current) teardownCall() }
  const onCallHandledElsewhere = () => { if (callRef.current?.status === 'incoming') teardownCall() }
  const onCallUnavailable = () => { setToast(`${callRef.current?.peer || 'They'} can't be reached`); teardownCall() }
  // Safety net: an outgoing call that's never answered (peer online but away, or negotiation stalls)
  // would otherwise ring forever and follow you across every page. Give up after 30s.
  useEffect(() => {
    if (!call || (call.status !== 'outgoing' && call.status !== 'connecting')) return
    const t = setTimeout(() => {
      const c = callRef.current
      if (c && (c.status === 'outgoing' || c.status === 'connecting')) {
        setToast(`${c.peer} didn't answer`)
        hangUpCall()
      }
    }, 30000)
    return () => clearTimeout(t)
  }, [call?.status])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const joinChannel = (channelId) => {
    if (!socket) return
    // On phones the nav is a drawer over the chat: reveal the chat even when this channel was already
    // the active one (in which case the state-change effect below wouldn't fire).
    setMobileNavOpen(false)
    setActiveChannel(channelId)
    resetChannelHistory()
    setMessages([]) // drop the previous channel's messages so the scroll-to-bottom runs on fresh content
    const serverId = currentServerId()
    socket.emit('joinChannel', { serverId, channelId })
    clearChannelUnread(serverId, channelId)
  }

  // Viewing a channel zeroes its badge (the server's read marker is advanced by joinChannel /
  // channel:read on its side).
  const clearChannelUnread = (serverId, channelId) => {
    const without = (prev) => {
      if (!prev[serverId]?.[channelId]) return prev
      const srv = { ...prev[serverId] }
      delete srv[channelId]
      return { ...prev, [serverId]: srv }
    }
    setChannelUnreads(without)
    setChannelMentions(without) // opening the channel is reading the mention
  }

  // Drop typing entries once they expire. Only ticks while someone is actually typing.
  useEffect(() => {
    if (Object.keys(typingBy).length === 0) return undefined
    const id = setInterval(() => setTypingBy((prev) => {
      const now = Date.now()
      let changed = false
      const next = {}
      for (const [key, people] of Object.entries(prev)) {
        const live = Object.fromEntries(Object.entries(people).filter(([, until]) => until > now))
        if (Object.keys(live).length !== Object.keys(people).length) changed = true
        if (Object.keys(live).length) next[key] = live
      }
      return changed ? next : prev
    }), 1000)
    return () => clearInterval(id)
  }, [typingBy])

  const loadUnreads = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return
    try {
      const res = await fetch(`${SERVER_URL}/unreads`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return
      const data = await res.json()
      setChannelUnreads(data.unreads || {})
      setChannelMentions(data.mentions || {})
    } catch (e) { /* offline — badges just stay stale */ }
  }

  // Coming back to a hidden tab while a channel is on screen counts as reading it.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return
      const serverId = selectedServerIdRef.current
      const channelId = activeChannelRef.current
      if (serverId && serverId !== 'home' && channelId) {
        clearChannelUnread(serverId, channelId)
        socketRef.current?.emit('channel:read', { serverId, channelId })
      }
      const open = homeChatRef.current
      if (serverId === 'home' && open?.type === 'group') {
        setGroupUnread((prev) => {
          if (!(open.id in prev)) return prev
          const next = { ...prev }
          delete next[open.id]
          return next
        })
        const t = localStorage.getItem('lanparty_token')
        if (t) fetch(`${SERVER_URL}/groups/${encodeURIComponent(open.id)}/read`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Drive the in-call mic button's level indicator. Runs only while actually in a call, and is
  // rebuilt when the local stream is replaced (device change, camera toggle rebuilding the stream).
  // The level is written straight onto the element as a CSS variable — going through React state
  // would re-render this whole component ~60x a second.
  useEffect(() => {
    const stream = localStream
    if (!inVoice || !stream || !stream.getAudioTracks().length) {
      try { callMeterRef.current?.stop() } catch (_) { /* ignore */ }
      callMeterRef.current = null
      micBtnRef.current?.style.setProperty('--mic-level', '0')
      return undefined
    }
    const meter = createMicMeter(stream, (level) => {
      // A muted track yields silence, so the indicator honestly shows nothing while muted.
      micBtnRef.current?.style.setProperty('--mic-level', level.toFixed(3))
    })
    callMeterRef.current = meter
    return () => { try { meter.stop() } catch (_) { /* ignore */ } }
  }, [inVoice, localStream])

  // Session restored (or the stored token turned out to be stale) -> advance the splash.
  useEffect(() => {
    if (!hadTokenAtBoot.current || bootDone || !authChecked) return
    if (!isAuthenticated) { setBootDone(true); return } // stale token: show the login screen instead
    markBoot('session', 'done')

    // Update check is desktop-only, and the bridge only exists in shells new enough to expose it —
    // web and older installs skip the step rather than stalling on an event that never comes.
    const bridge = typeof window !== 'undefined' ? window.desktop : null
    if (!bridge || typeof bridge.onUpdateStatus !== 'function') {
      markBoot('updates', 'skipped')
    } else {
      markBoot('updates', 'active')
      let settled = false
      const finish = (state) => { if (!settled) { settled = true; markBoot('updates', state) } }
      bridge.onUpdateStatus((status) => {
        // 'downloading' is left running in the background — electron-updater installs on quit, so
        // there's no reason to hold the app hostage to it.
        if (status === 'available' || status === 'none' || status === 'downloading' || status === 'error') finish('done')
      })
      // Never let a silent feed hold up startup.
      setTimeout(() => finish('done'), 4000)
    }
  }, [authChecked, isAuthenticated, bootDone])

  // Fail open: if any step stalls, reveal the app rather than trapping the user on the splash.
  // Say so at 4s first — on a slow connection a silent splash is indistinguishable from a hang, and
  // the note has to land BEFORE the reveal or it unmounts with the splash and is never read.
  useEffect(() => {
    if (bootDone) return undefined
    const slow = setTimeout(() => setBootNote('Taking longer than usual — still syncing…'), 4000)
    const t = setTimeout(() => setBootDone(true), 9000)
    return () => { clearTimeout(slow); clearTimeout(t) }
  }, [bootDone])

  // Phone drawer: any navigation (server, channel or DM) closes it so the chat is revealed. Covers
  // every entry point at once instead of threading a close call through each handler.
  useEffect(() => { setMobileNavOpen(false) }, [selectedServerId, activeChannel, homeChat])

  // Switching servers returns the side panel to Channels: arriving somewhere new and seeing a member
  // list instead of the channels you came for is disorienting.
  useEffect(() => { setServerPaneTab('channels') }, [selectedServerId])

  // Unlock synthesized UI sounds on the first user gesture (browsers suspend audio until then), and
  // give a soft click on any button/link press so interactions don't feel dead. playUiSound() itself
  // respects the enabled toggle, so this stays silent when sounds are turned off. Opt an element out
  // with a [data-no-uitap] ancestor.
  useEffect(() => {
    const onPointerDown = (e) => {
      unlockUiSounds()
      const el = e.target?.closest?.('button, [role="button"], a[href]')
      if (el && !el.closest?.('[data-no-uitap]')) playUiSound('tap')
    }
    const onKeyDown = () => unlockUiSounds()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    // Every alert() in the app is an error/warning to the user, so beep on all of them. Wrap rather
    // than touch dozens of call sites; restore the original on unmount.
    const origAlert = window.alert
    window.alert = (...args) => { playUiSound('error'); return origAlert.apply(window, args) }
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.alert = origAlert
    }
  }, [])

  // Desktop notification for activity you'd otherwise miss (tab hidden, or a DM/@mention while
  // you're elsewhere in the app). Gated on the Settings toggle + browser permission.
  const maybeNotify = (kind, info = {}) => {
    if (!notifyEnabledRef.current) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const me = localStorage.getItem('lanparty_user')
    const mentioned = (info.mentions || []).includes(me)
    // Channel chatter only notifies when hidden; @mentions and DMs also notify while visible.
    if (kind === 'channel' && !document.hidden && !mentioned) return
    // With this browser registered for Web Push, the server pushes DMs, group messages and @mentions
    // whenever no window has focus. Raising our own as well would alert twice for one message.
    if (pushCovers(kind, mentioned)) return
    try {
      const title = kind === 'dm'
        ? `💬 ${info.author}`
        : kind === 'group'
          ? `👥 ${info.groupName || 'Group chat'}`
          : `${mentioned ? '🔔' : '#'} ${info.channelName || 'channel'} · ${info.serverName || 'LAN Party'}`
      const body = kind === 'dm'
        ? (info.preview || 'New direct message')
        : `${info.author}: ${info.preview || 'New message'}`
      const tag = kind === 'group' ? `lanparty-group-${info.groupId}` : `lanparty-${kind}-${info.serverId || 'dm'}-${info.channelId || info.author}`
      const n = new Notification(title, { body, tag, silent: false })
      n.onclick = () => { window.focus(); n.close() }
    } catch (e) { /* some browsers throw for backgrounded pages — badge still updates */ }
  }

  // Settings toggle: turning ON asks the browser for permission first.
  const toggleNotifications = async () => {
    if (notifyEnabled) {
      setNotifyEnabled(false)
      localStorage.setItem('lanparty_notify', '0')
      // Off means off with the app closed as well: unregister this browser for push.
      stopPush(authedFetch)
      return
    }
    if (typeof Notification === 'undefined') { alert('This browser does not support desktop notifications.'); return }
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    if (perm !== 'granted') { alert('Notifications are blocked for this site — allow them in your browser settings, then try again.'); return }
    setNotifyEnabled(true)
    localStorage.setItem('lanparty_notify', '1')
    // Registering for push happens in the effect below, the same way it does at login.
  }

  // Notifications while the app is closed. Whenever someone is signed in with the toggle on — a
  // fresh login, a restored session, or the toggle just switched on — make sure this browser is
  // subscribed and registered to THEM. Where push is not possible (the desktop app, iOS outside an
  // installed web app, a server without it) this does nothing and the toggle keeps meaning what it
  // always did: notifications while the page is open.
  useEffect(() => {
    if (!isAuthenticated || !notifyEnabled) return
    syncPush(authedFetch)
  }, [isAuthenticated, notifyEnabled])

  // Tell the server whether this window is in front of its user. It is what keeps a push from
  // buzzing a phone about a message that is already on screen here; the server only pushes someone
  // who has no focused window at all. Per socket, so it is sent again after every reconnect.
  useEffect(() => {
    if (!socket) return
    const report = () => { if (socket.connected) socket.emit('presence:focus', { focused: windowFocused() }) }
    socket.on('connect', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    document.addEventListener('visibilitychange', report)
    report()
    return () => {
      socket.off('connect', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      document.removeEventListener('visibilitychange', report)
    }
  }, [socket])

  // Go to the conversation a clicked notification was about, the same way a click in the UI would.
  const openNotificationTarget = async (target) => {
    if (target.kind === 'requests') {
      setSelectedServerId('home')
      setLeftNav('friends')
      setMobileNavOpen(true) // on phones the requests live in the nav drawer
      loadFriendsData()
      return
    }
    if (target.kind === 'dm') {
      const matches = (item) => String(item.id) === target.userId || (item.peerUsername || item.name) === target.username
      const known = dmConversations.find(matches) || friends.find(matches)
      setSelectedServerId('home')
      setLeftNav('messages')
      // A first message from someone who is not a friend (a server co-member) is in neither list
      // yet, which is why the notification carries their id: it is what the chat is keyed by.
      openPeerChat('dm', known
        ? { ...known, peerUsername: known.peerUsername || known.name }
        : { id: target.userId, name: target.username, peerUsername: target.username })
      return
    }
    if (target.kind === 'group') {
      const find = (list) => (list || []).find((g) => String(g.id) === target.groupId)
      // Not in the list we have: it may simply be newer than our last load.
      const group = find(groupChats) || find(await loadGroupsData())
      if (!group) return // no longer a member; there is nothing to open
      setSelectedServerId('home')
      setLeftNav('messages')
      handleSelectGroup(group)
      return
    }
    if (target.kind === 'channel') {
      const s = socketRef.current
      if (!s) return
      setMobileNavOpen(false) // reveal the chat on phones
      // Only ask; the server's channel:joined answer is what moves the view. A channel that has been
      // deleted, or that we can no longer see, is then simply never entered.
      const hop = () => s.emit('joinChannel', { serverId: target.serverId, channelId: target.channelId })
      if (selectedServerIdRef.current === target.serverId) {
        if (activeChannelRef.current !== target.channelId) hop()
        return
      }
      // Entering a server lands in its first channel. Wait for that to be confirmed before moving
      // on: sent together, the two answers race and the first channel can win.
      const onJoined = ({ serverId, channelId } = {}) => {
        if (serverId !== target.serverId) return
        s.off('channel:joined', onJoined)
        clearTimeout(giveUp)
        if (channelId !== target.channelId) hop()
      }
      const giveUp = setTimeout(() => s.off('channel:joined', onJoined), 8000)
      s.on('channel:joined', onJoined)
      handleSelectServer(target.serverId)
    }
  }

  useEffect(() => {
    const target = notificationTarget.target
    // Held until there is a session and its lists are in: a notification clicked while signed out
    // opens its conversation right after login.
    if (!target || !isAuthenticated || !bootDone || !viewRestored) return
    notificationTarget.clear()
    openNotificationTarget(target)
  }, [notificationTarget.target, isAuthenticated, bootDone, viewRestored])

  const sendMessage = async () => {
    if (!socket || (!text.trim() && !pendingFile)) return
    const body = text.trim()
    setText('')
    setShowEmojiPicker(false)
    setShowGifPicker(false)
    setUploadError(null)
    setUploadingFile(true)
    await ensureLiveHistory()
    try {
      const attachment = await uploadSelectedFile()
      socket.emit('message', { serverId: currentServerId(), channelId: activeChannel, text: body, attachment, quotes: pendingQuotes.length > 0 ? pendingQuotes : undefined })
      playUiSound('send')
      setPendingQuotes([])
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

  // Constraints for every microphone capture. Passing `audio: true` left noise suppression to the
  // browser's default with no way to turn it off, which matters for anyone playing music or using a
  // mic that already cleans its own signal. Echo cancellation and gain control stay on.
  const micConstraints = (deviceId) => ({
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    noiseSuppression,
    echoCancellation: true,
    autoGainControl: true,
  })

  const startVoice = async (channelId = 'voice1', opts = {}) => {
    if (typeof channelId !== 'string') channelId = 'voice1' // guard against being passed a click event
    if (!socket) return
    const muted = opts.muted != null ? opts.muted : micMuted
    if (!localStreamRef.current) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(selectedMicId) })
        localStreamRef.current = s
        setLocalStream(s)
      } catch (err) {
        alert('Microphone access denied')
        return
      }
    }
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !muted && !pttEnabled }) // honor mute/join-muted; in push-to-talk the mic starts closed
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
    playUiSound('joinVoice')
    // SFU-first: probe the server BEFORE joining so the mode is settled when voice:peers arrives.
    // A null answer (SFU off / old server) means the mesh path below runs exactly as before.
    let sfuSession = null
    try {
      sfuSession = await SfuSession.create(socket, { serverId: callServerId, channelId }, {
        onPeerStream: (peerId, stream) => setRemoteStreams((prev) => ({ ...prev, [peerId]: stream })),
        onPeerGone: (peerId) => setRemoteStreams((prev) => { const c = { ...prev }; delete c[peerId]; return c }),
      })
    } catch (err) { console.warn('SFU probe failed — using mesh', err) }
    sfuRef.current = sfuSession
    socket.emit('voice:join', { serverId: callServerId, channelId })
    if (sfuSession) {
      // Drop the SFU and re-join so the server resends voice:peers, which now takes the mesh path
      // (sfuRef is null again). Guarded so a watchdog fallback can't double-fire after a catch.
      const fallbackToMesh = (why, err) => {
        if (sfuRef.current !== sfuSession) return
        console.warn(why, err || '')
        try { sfuSession.close() } catch (e) { /* already closed */ }
        sfuRef.current = null
        socket.emit('voice:join', { serverId: callServerId, channelId })
      }
      try {
        await sfuSession.connect()
        const audioTrack = localStreamRef.current?.getAudioTracks()[0]
        if (audioTrack) await sfuSession.produceAudio(audioTrack)
        const videoTrack = localStreamRef.current?.getVideoTracks()[0]
        if (videoTrack) await sfuSession.setVideoTrack(videoTrack)
      } catch (err) {
        // Signaling-level failure (handshake threw) after we already skipped mesh setup.
        fallbackToMesh('SFU connect failed — falling back to mesh', err)
      }
      // Media-path watchdog: connect()/produce resolve once DTLS params are exchanged over the
      // socket, which succeeds even when the media port itself is unreachable (e.g. a remote user
      // whose router isn't forwarded). If no transport actually reaches 'connected' in time, the
      // audio would be silently dead — so fall back to the mesh, which the SFU can't do server-side.
      if (sfuRef.current === sfuSession) {
        const connected = await sfuSession.waitUntilConnected(8000)
        if (!connected) fallbackToMesh('SFU media path did not connect — falling back to mesh')
      }
    }
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
      const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(selectedMicId) })
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
      const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
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

  // Show a member's public profile card (avatar, status, bio, gaming profile).
  const openMemberProfile = async (username) => {
    if (!username) return
    setProfileCard({ loading: true, username })
    try {
      const res = await authedFetch(`/users/${encodeURIComponent(username)}/public`)
      if (!res.ok) throw new Error('not found')
      setProfileCard(await res.json())
    } catch (e) {
      setProfileCard({ username, notFound: true })
    }
  }

  // The Friends/Messages layout (sections, what's in them, manual order) is saved to the account so it
  // survives reloads and follows you between devices. HomeLeftPanel debounces the calls.
  const saveHomeLayout = (homeLayout) => {
    setUserSettings((prev) => ({ ...(prev || {}), homeLayout }))
    patchUserSettings({ homeLayout })
  }

  // Remove a friend (both sides). The server then sends friend:list-updated to both of you, which
  // refreshes the friend and conversation lists. Message history is kept on the server.
  const removeFriend = async (friend) => {
    const username = friend?.peerUsername || friend?.name
    if (!username) return
    if (!window.confirm(`Remove ${username} from your friends? You can send them a new request later.`)) return
    try {
      const res = await authedFetch(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not remove friend') }
      setToast(`Removed ${username} from your friends`)
    } catch (err) {
      setToast(err.message || 'Could not remove friend')
    }
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

  // Is this card my own announcement? Compared by socket id rather than display name, which is not
  // unique. The server keys external entries as `ext-<socketId>`.
  const isMyAnnouncement = (stream) => Boolean(socket?.id) && stream?.id === `ext-${socket.id}`

  // The X on a card. On your own announcement it takes the announcement down (this is what replaced
  // the "Stop announcing" button); on anyone else's it just hides the card for you.
  const dismissStream = (stream) => {
    if (isMyAnnouncement(stream)) { unannounceStream(); return }
    setHiddenStreamIds((prev) => new Set(prev).add(stream.id))
  }
  const unhideAllStreams = () => setHiddenStreamIds(new Set())

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

  // Shrink the stream viewer into a draggable picture-in-picture in the bottom-right.
  const minimizeStream = () => {
    setStreamPos({ x: Math.max(12, window.innerWidth - 356), y: Math.max(70, window.innerHeight - 250) })
    setStreamMini(true)
  }
  // Drag the PiP miniplayer around by its header (keeps the iframe mounted, so playback never stops).
  // Pointer events (not mouse) so the miniplayer can be dragged with a finger — touch never fires
  // mousemove/mouseup, which left the PiP immovable on phones while covering most of the screen.
  // Clamping uses the LIVE streamSize: it used to assume the default 344x226, so dragging after a
  // resize let the player run off-screen.
  const startDragStream = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A press on the header's own buttons (Expand, Close) is a click, not a drag. Starting a drag
    // there captured the pointer to the header, which retargets the click to the header too, so the
    // buttons never received it and the miniplayer could not be expanded or closed.
    if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return
    const startX = e.clientX, startY = e.clientY
    const origin = { ...streamPos }
    const { w: W, h: H } = streamSize
    const id = e.pointerId
    try { e.currentTarget.setPointerCapture(id) } catch (_) { /* capture unsupported */ }
    const onMove = (ev) => {
      if (ev.pointerId !== id) return // ignore a second finger
      setStreamPos({
        x: Math.max(0, Math.min(window.innerWidth - W, origin.x + (ev.clientX - startX))),
        y: Math.max(0, Math.min(window.innerHeight - H, origin.y + (ev.clientY - startY))),
      })
    }
    const onUp = (ev) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  // Resize the PiP miniplayer from its bottom-right corner (keeps it fully on-screen by nudging
  // its position if growing would push it past an edge).
  const startResizeStream = (e) => {
    e.stopPropagation()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const startX = e.clientX, startY = e.clientY
    const origin = { ...streamSize }
    const id = e.pointerId
    try { e.currentTarget.setPointerCapture(id) } catch (_) { /* capture unsupported */ }
    const onMove = (ev) => {
      if (ev.pointerId !== id) return
      const w = Math.max(240, Math.min(window.innerWidth - 12, origin.w + (ev.clientX - startX)))
      const h = Math.max(150, Math.min(window.innerHeight - 12, origin.h + (ev.clientY - startY)))
      setStreamSize({ w, h })
      setStreamPos((p) => ({
        x: Math.max(6, Math.min(p.x, window.innerWidth - w - 6)),
        y: Math.max(6, Math.min(p.y, window.innerHeight - h - 6)),
      }))
    }
    const onUp = (ev) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Activities: start one for the room, relay an event, or end it (all scoped to the voice channel).
  const startActivity = (type) => { setShowActivityMenu(false); socketRef.current?.emit('activity:start', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', type }) }
  // `ack` is only used by uploaded apps (the server answers their events so the SDK can keep or
  // roll back an optimistic change). Built-in activities pass none, and none is sent for them.
  // `run` goes with it: it names the run of the app the event is for, and the server drops the
  // event if that is not what the room is running by the time it arrives.
  const sendActivityEvent = (event, ack, run) => {
    const payload = { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', event }
    if (typeof ack !== 'function') { socketRef.current?.emit('activity:event', payload); return }
    payload.app = run
    // An app's panel can outlive its activity by a moment (it says "leave" as it unmounts). Once
    // the room has moved on, that must not land on whatever activity replaced it.
    if (activityTypeRef.current !== 'app' || !socketRef.current) { ack({ ok: false, reason: 'ended' }); return }
    socketRef.current.emit('activity:event', payload, ack)
  }
  // Start an uploaded app for the room. Only the id is sent: the server takes the name, url and
  // icon from its own record of the app.
  const startAppActivity = (app) => {
    setShowActivityMenu(false)
    startedAppRef.current = { appId: app.id, at: Date.now() }
    socketRef.current?.emit('activity:start', { serverId: voiceServerIdRef.current, channelId: voiceChannelId || 'voice1', type: 'app', appId: app.id })
  }
  // Public identity of someone in the room, for the app card and for the app itself: name and
  // avatar, the same things every member can already see. Display name and username are the same
  // thing in LAN Party today.
  const describeAppPerson = (username) => {
    const p = username === name ? profile : (serverState?.members || []).find((m) => m.username === username)?.profile
    const avatar = typeof p?.avatarUrl === 'string' && !p.avatarUrl.startsWith('blob:') ? emojiSrc(p.avatarUrl) : ''
    return { username, displayName: username, avatarUrl: avatar }
  }
  const startedApp = startedAppRef.current
  const appHost = {
    describePerson: describeAppPerson,
    resolveSrc: emojiSrc,
    subscribe: subscribeAppHostRef.current,
    startedAppId: startedApp && Date.now() - startedApp.at < 15000 ? startedApp.appId : null,
    descriptionFor: (appId) => publicApps.find((a) => a.id === appId)?.description || '',
  }
  // What this person may start in a room, which is what the server will accept: any published
  // bundle; their own while it is a draft or in review; and, for an instance owner, anyone's that
  // is waiting for review (to try it with people before deciding). Never a rejected one.
  const appLaunchNote = (a) => {
    const status = a.status || 'published'
    if (status === 'published') return ''
    if (status !== 'draft' && status !== 'pending') return null
    if (a.createdBy === name) return status === 'draft' ? 'Draft — only you can start this' : 'In review — only you can start this'
    return instanceOwner && status === 'pending' ? `In review — by ${a.createdBy || 'someone'}, not approved yet` : null
  }
  const launchableApps = publicApps.filter((a) => a.embeddable && appLaunchNote(a) !== null)
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
    if (sfuRef.current) {
      // SFU mode: one video producer — replaceTrack for swaps (camera↔screen), close for off.
      sfuRef.current.setVideoTrack(newTrack || null).catch((err) => console.warn('SFU video update failed', err))
      if (old && old !== newTrack) { old.stop(); ls.removeTrack(old) }
      if (newTrack && !ls.getVideoTracks().includes(newTrack)) ls.addTrack(newTrack)
      setLocalStream(new MediaStream(ls.getTracks()))
      return
    }
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
    if (sfuRef.current) { sfuRef.current.setVideoBitrate(bitrate); return }
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
      effectsRef.current.onStatus = (status, error) => {
        setEffectsStatus(status)
        // Only a hard failure becomes an error banner; 'loading' is normal and says so in the menu.
        setEffectsError(status === 'unavailable' ? (error || 'Background effects are unavailable') : null)
      }
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
    // Start fetching the segmentation model as the menu opens. It is ~6MB, so warming it here is the
    // difference between blur appearing instantly and showing an unblurred camera while it downloads.
    warmUpEffects().catch(() => {})
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
      // clientWidth/Height include the stage's own padding, so the solver was handed more room than
      // the tiles actually get and picked cells slightly too large (most visible on a phone, where
      // the padding is a big fraction of the width). Measure the content box.
      const pad = getComputedStyle(el)
      const W = el.clientWidth - parseFloat(pad.paddingLeft || 0) - parseFloat(pad.paddingRight || 0)
      const H = el.clientHeight - parseFloat(pad.paddingTop || 0) - parseFloat(pad.paddingBottom || 0)
      if (!W || !H || W < 0 || H < 0 || n < 1) return
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
    // From the mute SETTING, not from track.enabled: in push-to-talk the track is closed whenever the
    // key is up, so reading it would see "already muted" and the button would do nothing.
    const next = !micMuted
    if (track) track.enabled = !next && (!pttEnabled || pttHeld) // unmuting in push-to-talk still needs the key
    setMicMuted(next)
    playUiSound(next ? 'mute' : 'unmute')
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
        if (track) track.enabled = !restore && (!pttEnabled || pttHeld)
        setMicMuted(restore)
      }
      return next
    })
  }

  // Flip noise suppression. Tried on the live track first, so nobody hears a gap; browsers that
  // refuse to change it mid-capture get the mic re-opened with the new setting instead.
  const reopenMicRef = useRef(null)
  const toggleNoiseSuppression = async () => {
    const next = !noiseSuppression
    setNoiseSuppression(next)
    writePref('lanparty_noise_suppression', next ? '1' : '0')
    const track = localStreamRef.current?.getAudioTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ noiseSuppression: next })
      if (track.getSettings?.().noiseSuppression !== next) throw new Error('not applied')
    } catch (_) {
      const deviceId = track.getSettings?.().deviceId || selectedMicId
      if (deviceId) reopenMicRef.current?.(deviceId, next)
    }
  }

  const togglePtt = () => {
    const next = !pttEnabled
    setPttEnabled(next)
    setPttHeld(false)
    writePref('lanparty_ptt', next ? '1' : '0')
  }

  // The ONE place the mic track is switched on or off. Mute, deafen and device changes each set
  // track.enabled themselves; with push-to-talk as a second reason to silence the mic, the last
  // writer would win, and a muted mic could come back on when the talk key was pressed.
  useEffect(() => {
    const track = localStream?.getAudioTracks?.()[0]
    if (!track) return
    track.enabled = !micMuted && (!pttEnabled || pttHeld)
  }, [localStream, micMuted, pttEnabled, pttHeld])

  // Push-to-talk key handling. Web pages only receive keys while focused, so this works when the
  // app is the active window, not while you are tabbed into a game. Losing focus releases the key,
  // otherwise alt-tabbing mid-sentence would leave the mic open with no way to notice.
  useEffect(() => {
    if (pttRebinding) {
      const capture = (e) => {
        e.preventDefault(); e.stopPropagation()
        if (e.code !== 'Escape') { setPttKey(e.code); writePref('lanparty_ptt_key', e.code) }
        setPttRebinding(false)
      }
      window.addEventListener('keydown', capture, true)
      return () => window.removeEventListener('keydown', capture, true)
    }
    if (!pttEnabled || !inVoice) { setPttHeld(false); return undefined }
    const typing = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    const down = (e) => {
      if (e.code !== pttKey || e.repeat) return
      // A key that types a character must not transmit while you are writing a message. Keys that
      // type nothing (F-keys, modifiers) are safe to honour anywhere.
      if (typing(e.target) && e.key.length === 1) return
      e.preventDefault()
      setPttHeld(true)
    }
    const up = (e) => { if (e.code === pttKey) setPttHeld(false) }
    const release = () => setPttHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', release)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', release)
    }
  }, [pttEnabled, pttKey, pttRebinding, inVoice])

  // A readable name for a KeyboardEvent.code: "Backquote" -> "`", "KeyV" -> "V", "F8" -> "F8".
  const keyLabel = (code) => {
    const named = { Backquote: '`', Space: 'Space', CapsLock: 'Caps Lock', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift' }
    if (named[code]) return named[code]
    return String(code || '').replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
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
  const changeMic = async (deviceId, noiseOverride) => {
    setSelectedMicId(deviceId)
    if (!localStreamRef.current) return
    try {
      // The toggle calls this in the same tick it flips the setting, before state has caught up.
      const constraints = micConstraints(deviceId)
      if (typeof noiseOverride === 'boolean') constraints.noiseSuppression = noiseOverride
      const s = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      const nt = s.getAudioTracks()[0]
      if (!nt) return
      nt.enabled = !micMuted && (!pttEnabled || pttHeld) // honor mute and push-to-talk
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

  reopenMicRef.current = changeMic

  // Switch the speaker/output — applied to every remote tile's <video> via the sinkId prop.
  const changeSpeaker = (deviceId) => setSelectedSpeakerId(deviceId)

  const leaveVoice = () => {
    playUiSound('leaveVoice')
    // Never let a bad emit block the local teardown — always tear the call down.
    const chId = typeof voiceChannelId === 'string' ? voiceChannelId : 'voice1'
    try { socket?.emit('voice:leave', { serverId: voiceServerIdRef.current, channelId: chId }) } catch (err) { console.warn('voice:leave emit failed', err) }
    try { sfuRef.current?.close() } catch (err) { /* already closed */ }
    sfuRef.current = null
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
    setViewRestored(false)
    // Whoever signs in here next must not receive this account's notifications. confirmSignOut has
    // normally told the server already; this makes sure the browser itself lets go either way.
    stopPush()
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
    // Paging state describes lists that belong to the account signing out.
    historyMetaRef.current = {}
    setHistoryMeta({})
    messagesChannelRef.current = null
    clearTimeout(pendingJumpRef.current?.timer)
    pendingJumpRef.current = null
    setShowSearch(false)
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
    // Before the token is revoked: have the server forget this browser's push subscription, so the
    // account stops being notified here the moment it signs out. Never blocks signing out.
    await stopPush(authedFetch)
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
  // Ids of pinned messages in the current channel (for the Pin/Unpin menu toggle).
  const pinnedIdSet = useMemo(() => new Set(channelPins.map((p) => p.id)), [channelPins])
  // Total unreads per server for the rail badges.
  const serverUnreadTotals = Object.fromEntries(
    Object.entries(channelUnreads).map(([sid, chans]) => [sid, Object.values(chans).reduce((a, b) => a + b, 0)])
  )
  const serverMentionTotals = Object.fromEntries(
    Object.entries(channelMentions).map(([sid, chans]) => [sid, Object.values(chans).reduce((a, b) => a + b, 0)])
  )
  // ---- Picking up a new deploy without being relaunched ----
  // Reloading is only done on the user's behalf when it costs them nothing: no call or activity to
  // drop, nothing half-typed or half-uploaded, no dialog mid-edit. Anything else gets the bar instead.
  busyForReloadRef.current = Boolean(
    inVoice || call || activity || uploadingFile || promptModal || editingProfile || editingSettings ||
    text.trim() || composerStack.length
  )
  useEffect(() => {
    let lastCheck = 0
    let stopped = false
    // `arriving`: the user is just coming back to the window (or is not looking at it at all), which
    // is the moment a reload goes unnoticed. A periodic check while they are actively using the app
    // never reloads under them; it only raises the bar.
    const check = async (arriving) => {
      const now = Date.now()
      if (now - lastCheck < 60 * 1000) return
      lastCheck = now
      const build = await findNewerBuild()
      if (stopped || !build) return
      const unseen = arriving || document.hidden || !document.hasFocus()
      if (unseen && !busyForReloadRef.current && !alreadyReloadedFor(build)) { reloadForBuild(build); return }
      setNewBuild(build)
    }
    checkForUpdateRef.current = check
    const onFocus = () => check(true)
    const onVisible = () => { if (!document.hidden) check(true) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    // The desktop app keeps its page "visible" while hidden in the tray, so nothing above fires
    // there until it is opened. This catches it beforehand, while nobody is looking.
    const timer = setInterval(() => check(false), 15 * 60 * 1000)
    return () => {
      stopped = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])

  const activeChannelObj = serverChannels.find((c) => c.id === activeChannel)
  const activeChannelType = activeChannelObj ? activeChannelObj.type : 'text'
  const activeChannelName = activeChannelObj?.name || activeChannel
  const showHomeChat = isHomeView && homeChat
  // Group DMs only. In a server the side panel's own Members tab covers this, so a topbar button was
  // a second control for the same list. A group chat has no channel list to share a panel with, so
  // there the slide-over is still the only way to see who's in it.
  const showMembersButton = Boolean(showHomeChat) && homeChat?.type === 'group'
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
      const username = participant?.peerUsername || participantName
      map.set(participantId, {
        id: participantId,
        name: participantName,
        // Carried so a group member can be privately messaged or removed.
        username,
        role: username === activeGroupChat.ownerUsername ? 'owner' : 'member',
        online: (participant?.status || 'offline') !== 'offline',
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
      username: member.username || null,
      role: member.role || (member.username === serverState?.server?.owner ? 'owner' : 'member'),
      online: member.online !== false,
      isYou: member.id === socket?.id || member.username === name || memberName === name,
    }
  })
  const membersPanelUsers = isHomeView ? groupParticipants : serverMembers

  // Clears the composer's media slot — an attached file or a staged GIF. Called on chat/channel
  // switches too, so staged media never follows you into a different conversation.
  const clearPendingAttachment = () => {
    setPendingFile(null)
    setComposerStack([])
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
    setAddToGroupId(null)
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

  const pickedNewChatUsers = () => newChatSelectedIds
    .map((id) => newChatUsers.find((user) => String(user.id) === String(id)))
    .filter(Boolean)

  // One person opens a DM; two or more create a group chat on the server, which tells everyone in it.
  const createNewChat = async () => {
    if (addToGroupId) { addPeopleToGroup(); return }
    const selectedUsers = pickedNewChatUsers()
    if (selectedUsers.length === 0 || groupBusy) return
    if (selectedUsers.length === 1) {
      setSelectedServerId('home')
      setLeftNav('messages')
      clearPendingAttachment()
      openPeerChat('dm', selectedUsers[0])
      closeNewChatModal()
      return
    }
    setGroupBusy(true)
    try {
      const { group } = await groupRequest('POST', '/groups', {
        name: newChatGroupName.trim(),
        members: selectedUsers.map((u) => u.peerUsername || u.name),
      })
      const chat = upsertGroupChat(group)
      setSelectedServerId('home')
      setLeftNav('messages')
      closeNewChatModal()
      handleSelectGroup(chat)
    } catch (err) {
      setToast(err.message || "Couldn't create the group")
    } finally {
      setGroupBusy(false)
    }
  }

  // ---- Group chat management (members panel) ----
  const openAddToGroup = (groupId) => {
    setNewChatSelectedIds([])
    setNewChatGroupName('')
    setAddToGroupId(groupId)
    setShowMembersPanel(false)
    setShowNewChatModal(true)
  }

  const addPeopleToGroup = async () => {
    const usernames = pickedNewChatUsers().map((u) => u.peerUsername || u.name)
    if (!addToGroupId || usernames.length === 0 || groupBusy) return
    setGroupBusy(true)
    try {
      const { group } = await groupRequest('POST', `/groups/${encodeURIComponent(addToGroupId)}/members`, { usernames })
      upsertGroupChat(group)
      closeNewChatModal()
      setToast(`Added ${usernames.join(', ')}`)
    } catch (err) {
      setToast(err.message || "Couldn't add them")
    } finally {
      setGroupBusy(false)
    }
  }

  const renameGroup = async (group) => {
    if (!group) return
    const next = await askPrompt({
      title: 'Rename group',
      label: 'Group name',
      placeholder: 'Leave empty to use everyone’s names',
      initial: group.rawName || '',
      submitLabel: 'Save',
    })
    if (next === null || next === undefined) return
    try {
      const { group: updated } = await groupRequest('PATCH', `/groups/${encodeURIComponent(group.id)}`, { name: next })
      upsertGroupChat(updated)
    } catch (err) {
      setToast(err.message || "Couldn't rename the group")
    }
  }

  const leaveGroup = async (group) => {
    if (!group) return
    if (!window.confirm(`Leave ${group.name}? You won't see its messages any more unless someone adds you back.`)) return
    const me = localStorage.getItem('lanparty_user') || name
    leavingGroupsRef.current.add(String(group.id))
    try {
      await groupRequest('DELETE', `/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(me)}`)
      dropGroupChat(group.id)
      setToast(`You left ${group.name}`)
    } catch (err) {
      leavingGroupsRef.current.delete(String(group.id))
      setToast(err.message || "Couldn't leave the group")
    }
  }

  const removeFromGroup = async (groupId, username) => {
    if (!groupId || !username) return
    if (!window.confirm(`Remove ${username} from this group?`)) return
    try {
      await groupRequest('DELETE', `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(username)}`)
    } catch (err) {
      setToast(err.message || `Couldn't remove ${username}`)
    }
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
    // Optimistic update; the server stores it and reaction:updated reconciles everyone's copy.
    setHomeMessages((prev) => ({
      ...prev,
      [chatKey]: (prev[chatKey] || []).map((message) =>
        String(message.id) === String(messageId) ? applyReactionToMessage(message, emoji) : message
      ),
    }))
    if ((homeChat.type === 'friend' || homeChat.type === 'dm') && socket) {
      socket.emit('reaction:toggle', { scope: 'dm', messageId, emoji })
    } else if (homeChat.type === 'group' && socket) {
      socket.emit('reaction:toggle', { scope: 'group', messageId, emoji })
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
    await ensureLiveHistory()
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

  // Edits show straight away and are then saved on the server, which tells everyone else. If the
  // server refuses (or never answers), the old text comes back and the user is told — an edit that
  // silently exists only on your own screen is exactly what this used to be.
  const editHomeMessage = async (messageId, newText) => {
    if (!homeChat || !messageId) return
    const chatKey = chatStorageKey(homeChat.id)
    const prior = (homeMessages[chatKey] || []).find((m) => String(m.id) === String(messageId))
    const showText = (text, edited) => setHomeMessages((prev) => ({
      ...prev,
      [chatKey]: (prev[chatKey] || []).map((m) =>
        String(m.id) === String(messageId) ? { ...m, text, edited } : m
      ),
    }))
    showText(newText, true)
    const isGroup = homeChat.type === 'group'
    if (!isGroup && homeChat.type !== 'friend' && homeChat.type !== 'dm') return
    try {
      const t = token || localStorage.getItem('lanparty_token')
      const url = isGroup
        ? `${SERVER_URL}/groups/${encodeURIComponent(homeChat.id)}/messages/${encodeURIComponent(messageId)}`
        : `${SERVER_URL}/messages/${encodeURIComponent(messageId)}`
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ text: newText }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Couldn't save your edit") }
      if (!isGroup) loadMessagesData() // the edited message may be the one the conversation list previews
    } catch (err) {
      if (prior) showText(prior.text, !!prior.edited)
      setToast(err.message || "Couldn't save your edit")
    }
  }

  const editChannelMessage = (messageId, newText) => {
    if (!messageId || !socket) return
    const prior = messages.find((m) => String(m.id) === String(messageId))
    if (!prior) return
    const showText = (text, edited) => setMessages((prev) =>
      prev.map((m) => (String(m.id) === String(messageId) ? { ...m, text, edited } : m))
    )
    showText(newText, true)
    socket.timeout(8000).emit('message:edit', { id: messageId, text: newText }, (err, res) => {
      if (!err && res && res.ok) return
      showText(prior.text, !!prior.edited)
      setToast("Couldn't save your edit")
    })
  }

  // Delete a channel message (server verifies ownership, then broadcasts message:deleted).
  const deleteChannelMessage = (messageId) => {
    if (!socket || !messageId) return
    socket.emit('message:delete', { serverId: currentServerId(), channelId: activeChannel, id: messageId })
  }

  // ---- Pinning (channel messages) ----
  const pinMessage = (messageId) => { if (socket && messageId) socket.emit('message:pin', { id: messageId }) }
  const unpinMessage = (messageId) => { if (socket && messageId) socket.emit('message:unpin', { id: messageId }) }
  // Scroll a message of the conversation on screen into view and flash it. Used from the pin bar,
  // the View Pins list and search results.
  const jumpToMessage = (messageId) => {
    setShowPinsModal(false)
    setPinBarMenu(null)
    if (flashMessage(messageId, true)) return
    // Not in the loaded window. History is paged, so that is the normal case for anything old:
    // fetch the page around it instead of doing nothing.
    const target = currentHistoryTarget()
    if (target) loadHistoryAround(target, messageId)
  }

  // Open the conversation a search result came from and show that message in it.
  const jumpToSearchResult = async (result) => {
    const messageId = result?.message?.id
    if (!messageId) return
    setShowSearch(false)
    setMobileNavOpen(false) // reveal the chat on phones
    if (result.kind === 'channel') {
      const s = socketRef.current
      if (!s) return
      const sameServer = selectedServerId === result.serverId
      const held = messagesChannelRef.current
      if (sameServer && activeChannel === result.channelId && held?.channelId === result.channelId) {
        jumpToMessage(messageId)
        return
      }
      // Somewhere else: ask the socket to take us there, and let messages:init finish the jump once
      // that channel's history is in. If we are never let in (channel deleted, access removed) the
      // request is dropped rather than left armed for the next time that channel is opened.
      clearTimeout(pendingJumpRef.current?.timer)
      const jump = { serverId: result.serverId, channelId: result.channelId, messageId, timer: null }
      jump.timer = setTimeout(() => {
        if (pendingJumpRef.current !== jump) return
        pendingJumpRef.current = null
        setToast("Couldn't open that message")
      }, 8000)
      pendingJumpRef.current = jump
      if (sameServer) { joinChannel(result.channelId); return }
      // Another server: entering it lands in its first channel, and only then can we move on to the
      // one we want (the same two-step, for the same reason, as opening a notification).
      const hop = () => s.emit('joinChannel', { serverId: result.serverId, channelId: result.channelId })
      const onJoined = ({ serverId, channelId } = {}) => {
        if (serverId !== result.serverId) return
        s.off('channel:joined', onJoined)
        clearTimeout(giveUp)
        if (channelId !== result.channelId) hop()
      }
      const giveUp = setTimeout(() => s.off('channel:joined', onJoined), 8000)
      s.on('channel:joined', onJoined)
      handleSelectServer(result.serverId)
      return
    }
    if (result.kind === 'dm') {
      const matches = (item) => (item.peerUsername || item.name) === result.peer
      if (showHomeChat && homeChat.type !== 'group' && matches(homeChat)) { jumpToMessage(messageId); return }
      const known = dmConversations.find(matches) || friends.find(matches)
      if (!known) { setToast("Couldn't open that conversation"); return }
      setSelectedServerId('home')
      setLeftNav('messages')
      openPeerChat('dm', { ...known, peerUsername: known.peerUsername || known.name }, messageId)
      return
    }
    if (result.kind === 'group') {
      if (showHomeChat && homeChat.type === 'group' && String(homeChat.id) === String(result.groupId)) { jumpToMessage(messageId); return }
      const find = (list) => (list || []).find((g) => String(g.id) === String(result.groupId))
      // Not in the list we have: it may simply be newer than our last load.
      const group = find(groupChats) || find(await loadGroupsData())
      if (!group) { setToast("Couldn't open that conversation"); return }
      setSelectedServerId('home')
      setLeftNav('messages')
      openGroupChat(group, messageId)
    }
  }

  // ---- Quoted replies (Teams-style) ----
  // Stage a message as a quote on the next send. Any number of different messages can be
  // quoted at once, but the same message can't be quoted twice.
  const quoteMessage = (message) => {
    if (!message) return
    if (pendingQuotes.some((q) => String(q.id) === String(message.id))) {
      setToast("You're already replying to that message")
      return
    }
    if (pendingQuotes.length >= 10) {
      setToast('You can quote up to 10 messages per reply')
      return
    }
    const text = (message.text || '').slice(0, 300) || (message.attachment ? `📎 ${message.attachment.name || 'attachment'}` : '')
    setPendingQuotes((prev) => [...prev, { id: message.id, author: message.author, ts: message.ts || message.createdAt || message.created_at || Date.now(), text }])
  }
  const removePendingQuote = (id) => setPendingQuotes((prev) => prev.filter((q) => String(q.id) !== String(id)))

  // ---- Forwarding: copy a message's content to another channel or DM ----
  const openForward = (message) => setForwardMsg(message)
  const forwardToTarget = async (target) => {
    const m = forwardMsg
    setForwardMsg(null)
    if (!m || !target) return
    const payload = { text: m.text || '', attachment: m.attachment || null }
    try {
      if (target.kind === 'channel') {
        socket?.emit('message', { serverId: target.serverId, channelId: target.channelId, ...payload })
      } else if (target.kind === 'dm') {
        const t = token || localStorage.getItem('lanparty_token')
        const res = await fetch(`${SERVER_URL}/messages/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ toUsername: target.peerUsername, ...payload }),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Forward failed')
        loadMessagesData()
      }
      setToast(`Forwarded to ${target.label}`)
    } catch (e) { setToast(e.message || 'Could not forward') }
  }
  // Destinations for the forward picker: text channels in the current server + existing DM threads.
  const forwardTargets = () => {
    const chans = (serverChannels || [])
      .filter((c) => c.type === 'text')
      .map((c) => ({ kind: 'channel', serverId: currentServerId(), channelId: c.id, label: `# ${c.name}` }))
    const dms = (dmConversations || [])
      .filter((c) => c.peerUsername || c.name)
      .map((c) => ({ kind: 'dm', peerUsername: c.peerUsername || c.name, label: `@ ${c.peerUsername || c.name}` }))
    return { chans, dms }
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
    if (homeChat.type !== 'group') return
    try {
      await groupRequest('DELETE', `/groups/${encodeURIComponent(homeChat.id)}/messages/${encodeURIComponent(messageId)}`)
      setHomeMessages((prev) => ({ ...prev, [chatKey]: (prev[chatKey] || []).filter((m) => String(m.id) !== String(messageId)) }))
    } catch (err) {
      setToast(err.message || "Couldn't delete that message")
    }
  }

  // Open a home chat on the page around one message rather than on its newest page. What is cached
  // for it is dropped first, so the chat opens straight onto that page instead of showing the newest
  // messages for a moment and then leaping away from them. Opening counts as reading it only if the
  // page reaches the newest messages (markRead, see loadHistoryAround).
  const openHistoryAround = (target, messageId, loadNewest) => {
    setHomeMessages((prev) => {
      if (!(target.key in prev)) return prev
      const next = { ...prev }
      delete next[target.key]
      return next
    })
    dropHistoryMeta(target.key)
    loadHistoryAround(target, messageId, { markRead: true, onFail: loadNewest })
  }

  // `aroundMessageId` opens the chat at that message (a search result) instead of at the newest.
  const openPeerChat = (type, item, aroundMessageId) => {
    const peerUsername = item.peerUsername || item.name
    const chatId = chatStorageKey(item.id)
    // Capture unread count before it's cleared so the scroll lands on the first unread message.
    pendingUnreadScrollRef.current = unreadByChatId[chatId] || 0
    setShowMembersPanel(false)
    setMobileNavOpen(false) // reveal the conversation on phones, even if it was already selected
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
      if (aroundMessageId) {
        openHistoryAround({ kind: 'dm', key: chatId, peer: peerUsername }, aroundMessageId, () => loadHomeChatHistory(peerUsername, chatId))
      } else {
        loadHomeChatHistory(peerUsername, chatId)
      }
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

  // Takes only the group: it is handed to the conversation list as a click handler.
  const handleSelectGroup = (group) => openGroupChat(group)

  const openGroupChat = (group, aroundMessageId) => {
    pendingUnreadScrollRef.current = groupUnread[group.id] || 0
    setShowMembersPanel(false)
    setMobileNavOpen(false) // reveal the conversation on phones, as DMs do
    clearPendingAttachment()
    setSelectedGroupId(group.id)
    setSelectedFriendId(null)
    setSelectedDmId(null)
    setHomeChat({ type: 'group', id: group.id, name: group.name })
    if (aroundMessageId) {
      openHistoryAround({ kind: 'group', key: chatStorageKey(group.id), groupId: group.id }, aroundMessageId, () => loadGroupHistory(group.id))
    } else {
      loadGroupHistory(group.id)
    }
    // Opened at an old message, the unread ones may not be on the page: the badge stays until they are.
    if (!aroundMessageId) setGroupUnread((prev) => {
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
    setShowGifPicker(false)
    setUploadError(null)
    setUploadingFile(true)
    await ensureLiveHistory()
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
          body: JSON.stringify({ toUsername: peerUsername, text: body, attachment, quotes: pendingQuotes.length > 0 ? pendingQuotes : undefined }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Send failed')
        appendHomeMessage(homeChat.id, data.message)
        updateDmConversationPreview(homeChat.id, peerUsername, data.message, 0)
        setPendingQuotes([])
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
    if (homeChat.type !== 'group') { setUploadingFile(false); return }
    try {
      const data = await groupRequest('POST', `/groups/${encodeURIComponent(homeChat.id)}/messages`, {
        text: body,
        attachment,
        quotes: pendingQuotes.length > 0 ? pendingQuotes : undefined,
      })
      // group:message brings the same message to this tab too; appendHomeMessage de-dupes by id.
      appendHomeMessage(homeChat.id, data.message)
      updateGroupConversationPreview(homeChat.id, data.message)
      setPendingQuotes([])
      clearPendingAttachment()
    } catch (err) {
      console.warn('sendHomeMessage (group)', err)
      setUploadError(err.message)
      setText(body)
    } finally {
      setUploadingFile(false)
    }
  }

  const homeChatMessages = homeChat ? homeMessages[chatStorageKey(homeChat.id)] || [] : []
  // name -> url lookup for rendering :shortcode: custom emojis in chat (personal + all servers).
  const emojiMap = (() => {
    const map = {}
    for (const list of Object.values(serverEmojis)) for (const c of list) map[c.name] = c.url
    for (const c of customEmojis) map[c.name] = c.url // personal takes precedence
    return map
  })()
  // On Home with no conversation open there is no channel to name — the last server channel is
  // still in state, but its server isn't loaded, so it would show as a raw channel id.
  const topbarChannelLabel = showHomeChat
    ? homeChat.type === 'group'
      ? homeChat.name
      : `@ ${homeChat.name}`
    : isHomeView
      ? 'Home'
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

  // Stage a picked GIF as the next block in the composer stack. Whatever is currently typed is
  // committed as a text block first, so the order you built things in is the order they send: type,
  // add a GIF, type again, add another — the Teams behaviour.
  const stageGif = (gif) => {
    if (!gif?.url) return
    setShowEmojiPicker(false)
    setShowGifPicker(false)
    setUploadError(null)
    // An uploaded file is a genuinely different thing (it needs uploading), so it still owns its own
    // slot and can't be interleaved. Say so rather than silently dropping it.
    if (pendingFile) {
      clearPendingAttachment()
      setToast('Replaced the attached file with the GIF')
    }
    setComposerStack((stack) => {
      const typed = text.trim()
      const next = typed ? [...stack, { kind: 'text', text: typed }] : [...stack]
      next.push({ kind: 'gif', url: gif.url, name: gif.name || 'gif' })
      return next
    })
    setText('')
  }

  const removeStackPart = (index) => setComposerStack((stack) => stack.filter((_, i) => i !== index))

  /**
   * Flatten the stack plus whatever is still in the input into one message body. Each part gets its own
   * line, which is exactly what messageBlocks() reads back as ordered blocks.
   */
  const composerStackBody = () => {
    const parts = composerStack.map((p) => (p.kind === 'text' ? p.text : p.url))
    const typed = text.trim()
    if (typed) parts.push(typed)
    return parts.filter(Boolean).join('\n')
  }

  // Deliver the stacked message. Everything travels in the body as text + media urls, so a message can
  // carry several GIFs; the single attachment slot stays reserved for real uploads.
  const sendStackedMessage = async () => {
    const body = composerStackBody()
    if (!body) return
    // Clear first: the send is async, and a second Enter must not double-post.
    setComposerStack([])
    setText('')
    await deliverGifMessage(null, body)
  }

  // Route a GIF message to whatever is on screen: a DM, a local group chat, or a server channel.
  const deliverGifMessage = async (attachment, body) => {
    await ensureLiveHistory()
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

  // Is Tenor configured on the server (has an API key)?
  const tenorStatus = async () => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return false
    try {
      const res = await fetch(`${SERVER_URL}/tenor/status`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return false
      const data = await res.json()
      return !!data.configured
    } catch {
      return false
    }
  }

  // Fetch a page of Tenor results (featured/trending when query is empty) via our server proxy.
  // Tenor paginates with an opaque `pos` cursor, echoed back as `next` for infinite scroll.
  // Returns { results: [{ id, url, preview, description }], next }.
  const fetchTenor = async (query, pos = '') => {
    const empty = { results: [], next: '' }
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) return empty
    const q = (query || '').trim()
    const params = new URLSearchParams(pos ? { pos } : {})
    if (q) params.set('q', q)
    const path = `${q ? '/tenor/search' : '/tenor/featured'}${params.toString() ? `?${params}` : ''}`
    try {
      const res = await fetch(`${SERVER_URL}${path}`, { headers: { Authorization: `Bearer ${t}` } })
      if (!res.ok) return empty
      const data = await res.json()
      return { results: data.results || [], next: data.next || '' }
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
  // Put a list the server sent on screen, unless a newer one already is. A plain GET is numbered
  // when it STARTS (the later-started fetch wins); a change is numbered when its ANSWER arrives,
  // see appsRequest.
  const applyAppList = (seq, data) => {
    if (seq < appsAppliedRef.current) return
    appsAppliedRef.current = seq
    setPublicApps(Array.isArray(data?.apps) ? data.apps : [])
    if (typeof data?.instanceOwner === 'boolean') setInstanceOwner(data.instanceOwner)
  }
  const loadPublicApps = async (authToken) => {
    const t = authToken || token || localStorage.getItem('lanparty_token')
    if (!t) return
    const seq = ++appsSeqRef.current
    // A refresh that fails keeps the list already on screen; only a first load can end in 'error'.
    setPublicAppsStatus((s) => (s === 'ready' ? s : 'loading'))
    try {
      const res = await fetch(`${SERVER_URL}/apps`, { headers: { Authorization: `Bearer ${t}` } })
      if (res.ok) { applyAppList(seq, await res.json()); setPublicAppsStatus('ready') }
      else setPublicAppsStatus((s) => (s === 'ready' ? s : 'error'))
    } catch (err) {
      console.warn('loadPublicApps failed', err)
      setPublicAppsStatus((s) => (s === 'ready' ? s : 'error'))
    }
  }

  const openAppDirectory = () => { setShowAppDirectory(true); loadPublicApps() }

  // An app somebody else started is one this client may never have listed. Fetch the directory once
  // so its Join card can show the uploader's description (the activity state does not carry it).
  const activeAppId = activity?.type === 'app' ? activity.state?.appId : null
  useEffect(() => {
    if (activeAppId != null && !publicApps.some((a) => a.id === activeAppId)) loadPublicApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAppId])

  // Every change to an app goes through here (upload, edit, submit, approve, delete...; the
  // directory's tabs build the calls). The server answers each with the caller's whole list, and
  // that list replaces the one on screen: nothing is guessed ahead of the answer. Rejects with the
  // server's own message.
  const appsRequest = async (path, { method = 'GET', json, form } = {}) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) throw new Error('You must be signed in.')
    const headers = { Authorization: `Bearer ${t}` }
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetch(`${SERVER_URL}${path}`, { method, headers, body: form || (json !== undefined ? JSON.stringify(json) : undefined) })
    } catch (_) {
      throw new Error('Could not reach the server.')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `The server refused that (${res.status}).`)
    // Numbered now, not when the request started: the list in this answer was read after the
    // change was written, so it is newer than any GET that began while a slow upload was still on
    // its way — and that GET, numbered lower, can no longer replace it. Numbered at the start, a
    // refresh landing mid-upload made the upload's own answer look stale: the new app was missing
    // from My apps, and a replaced bundle kept the url of files the server had just deleted.
    if (Array.isArray(data.apps)) applyAppList(++appsSeqRef.current, data)
    return data
  }
  // An app's icon is an ordinary upload; the app only stores its /uploads/ path.
  const uploadAppIcon = async (iconFile) => {
    const t = token || localStorage.getItem('lanparty_token')
    if (!t) throw new Error('You must be signed in.')
    if (iconFile.size > MAX_FILE_SIZE) throw new Error('Icon is larger than 100 MB.')
    const fd = new FormData()
    fd.append('file', iconFile)
    const up = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: fd })
    const upData = await up.json().catch(() => ({}))
    if (!up.ok || !upData.attachment?.url) throw new Error(upData.error || 'Icon upload failed')
    return upData.attachment.url
  }
  // Signing out: the next account must not see this one's drafts or its Review tab, and an answer
  // still on its way for this account must not land in the next one's list.
  useEffect(() => {
    if (isAuthenticated) return
    appsAppliedRef.current = ++appsSeqRef.current
    setPublicApps([])
    setInstanceOwner(false)
    setPublicAppsStatus('idle')
  }, [isAuthenticated])
  const pendingAppReviews = instanceOwner ? publicApps.filter((a) => a.status === 'pending').length : 0

  // Custom emojis for the server currently on screen.
  const serverEmojiGroups = serverState?.server
    ? [{ serverId: serverState.server.id, serverName: serverState.server.name || 'Server', emojis: serverEmojis[serverState.server.id] || [] }]
    : []

  // ---- History paging: what the message list shows at its edges ----
  const activeHistoryMeta = historyMeta[showHomeChat ? chatStorageKey(homeChat.id) : CHANNEL_HISTORY_KEY]
  // Top of the list. While older messages exist the row is always there, at a fixed height, and
  // only its text comes and goes: a row that appeared when loading began would itself shove the
  // messages down under the reader's eyes.
  const renderHistoryStart = () => {
    if (!activeHistoryMeta) return null
    if (activeHistoryMeta.hasMore) {
      return (
        <div className="history-edge" aria-live="polite">
          {activeHistoryMeta.loadingOlder ? 'Loading earlier messages…' : '\u00a0'}
        </div>
      )
    }
    if (activeHistoryMeta.hasMore === false) return <div className="history-edge start">Beginning of the conversation</div>
    return null
  }
  // Bottom of a detached window: more of the conversation follows, and loads on reaching it.
  const renderHistoryEnd = () => (activeHistoryMeta?.detached
    ? <div className="history-edge" aria-live="polite">{activeHistoryMeta.loadingNewer ? 'Loading newer messages…' : '\u00a0'}</div>
    : null)
  // The way back from a detached window. Outside the scrolling list so it is always in reach.
  const renderPresentBar = () => {
    if (!activeHistoryMeta?.detached) return null
    const missed = activeHistoryMeta.missed || 0
    return (
      <button type="button" className="history-present-bar" onClick={jumpToPresent}>
        <span className="history-present-note">
          {missed ? `${missed} new message${missed === 1 ? '' : 's'} since you jumped back` : "You're viewing older messages"}
        </span>
        <span className="history-present-go">Jump to present ↓</span>
      </button>
    )
  }

  // What "This conversation" means to the search panel right now (null: nothing to search here,
  // e.g. the Home landing or a voice channel, where only "Everywhere" makes sense).
  const searchHere = showHomeChat
    ? homeChat.type === 'group'
      ? { key: `group:${homeChat.id}`, label: homeChat.name, params: { scope: 'group', groupId: String(homeChat.id) } }
      : { key: `dm:${homeChat.peerUsername || homeChat.name}`, label: `@${homeChat.peerUsername || homeChat.name}`, params: { scope: 'dm', with: homeChat.peerUsername || homeChat.name } }
    : !isHomeView && activeChannelType === 'text' && activeChannel
      ? { key: `channel:${selectedServerId}:${activeChannel}`, label: `#${activeChannelName}`, params: { scope: 'channel', serverId: selectedServerId, channelId: activeChannel } }
      : null
  const searchServer = isHomeView ? null : { id: selectedServerId, name: serverName }
  // An unnamed group comes back from search with an empty name; the list already knows what to call it.
  const searchGroupLabel = (groupId) => groupChats.find((g) => String(g.id) === String(groupId))?.name || ''

  const renderComposer = (placeholder, onSend) => {
    const canSend = Boolean(text.trim() || pendingFile || composerStack.length) && !uploadingFile
    // A stack has its own delivery path: everything in it is already hosted, so there is nothing to
    // upload and the whole thing goes as one body. Routing Enter and Send through here keeps them in
    // step. A plain typed message with no stack still takes the normal path.
    const handleSend = () => {
      if (!canSend) return
      lastTypingSentRef.current = 0 // the next thing typed should announce itself straight away
      if (composerStack.length) { sendStackedMessage(); return }
      onSend()
    }

    // Which conversation this composer belongs to. The same keys the 'typing' listener files under.
    const inHomeChat = Boolean(showHomeChat && homeChat)
    const convKey = inHomeChat
      ? (homeChat.type === 'group' ? `group:${homeChat.id}` : `dm:${homeChat.peerUsername || homeChat.name}`)
      : `channel:${currentServerId()}:${activeChannel}`
    const typingNames = Object.keys(typingBy[convKey] || {})
    const typingLabel = typingNames.length === 0 ? ''
      : typingNames.length === 1 ? `${typingNames[0]} is typing…`
        : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…`
          : 'Several people are typing…'

    // Tell the others, at most once every few seconds: the receiving side keeps the line up for
    // TYPING_SHOWN_MS, so a steady typist stays "typing" without an event per keystroke.
    const noteTyping = () => {
      const now = Date.now()
      if (now - lastTypingSentRef.current < 2500) return
      lastTypingSentRef.current = now
      const s = socketRef.current
      if (!s) return
      if (inHomeChat) {
        if (homeChat.type === 'group') s.emit('typing', { scope: 'group', groupId: homeChat.id })
        else s.emit('typing', { scope: 'dm', to: homeChat.peerUsername || homeChat.name })
      } else {
        s.emit('typing', { scope: 'channel', serverId: currentServerId(), channelId: activeChannel })
      }
    }

    // @mention autocomplete: offered while the text ends in "@partial". People who can actually be
    // named here — the server's members in a channel, the group's members in a group. A 1:1 chat has
    // nobody to pick between, so it offers nothing.
    const mentionMatch = /(^|\s)@([\w.-]*)$/.exec(text)
    const mentionPool = inHomeChat ? (homeChat.type === 'group' ? groupParticipants : []) : serverMembers
    const mentionOptions = mentionMatch && mentionDismissedFor !== text
      ? mentionPool
        .filter((m) => !m.isYou)
        .map((m) => m.username || m.name)
        .filter((n, i, all) => n && all.indexOf(n) === i)
        .filter((n) => n.toLowerCase().startsWith(mentionMatch[2].toLowerCase()))
        .slice(0, 6)
      : []
    const mentionOpen = mentionOptions.length > 0
    const mentionActive = Math.min(mentionIndex, Math.max(0, mentionOptions.length - 1))
    const pickMention = (who) => {
      if (!mentionMatch) return
      setText(`${text.slice(0, mentionMatch.index + mentionMatch[1].length)}@${who} `)
      setMentionIndex(0)
    }
    const onComposerKeyDown = (e) => {
      if (mentionOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((mentionActive + 1) % mentionOptions.length); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((mentionActive - 1 + mentionOptions.length) % mentionOptions.length); return }
        // Enter picks a name here rather than sending: sending a half-typed "@sa" is never what was meant.
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionOptions[mentionActive]); return }
        if (e.key === 'Escape') { e.preventDefault(); setMentionDismissedFor(text); return }
      }
      if (e.key === 'Enter') handleSend()
    }
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
        {/* The stack, in send order. Text you typed before adding a GIF is committed as its own block,
            so what you see here is exactly what the message will look like. */}
        {composerStack.length > 0 && (
          <div className="composer-stack" aria-label="Message being composed">
            {composerStack.map((part, i) => (
              <div className={`composer-stack-part ${part.kind}`} key={`${part.kind}-${i}`}>
                {part.kind === 'text' ? (
                  <span className="composer-stack-text">{part.text}</span>
                ) : (
                  <span className="composer-stack-thumb"><img src={emojiSrc(part.url)} alt={part.name} /></span>
                )}
                <button
                  type="button"
                  className="composer-stack-remove"
                  onClick={() => removeStackPart(i)}
                  aria-label={part.kind === 'text' ? 'Remove this text' : `Remove ${part.name}`}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="composer-stack-hint">Keep typing to add more below · Enter sends the whole thing</div>
          </div>
        )}
        {uploadError && <div className="composer-error">{uploadError}</div>}
        {showEmojiPicker && (
          <EmojiPicker
            personalEmojis={customEmojis}
            serverEmojiGroups={serverEmojiGroups}
            skinTones={emojiSkinTones}
            resolveSrc={emojiSrc}
            onSelectEmoji={handleSelectEmoji}
            onSelectCustom={handleSelectCustomEmoji}
            onSetSkinTone={handleSetEmojiSkinTone}
            onUploadPersonal={handleUploadCustomEmoji}
            onUploadServer={handleUploadServerEmoji}
            onDeletePersonal={deletePersonalEmoji}
            onDeleteServer={deleteServerEmoji}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        {showGifPicker && (
          <GifPicker
            gifs={gifLibrary}
            resolveSrc={emojiSrc}
            onSelectGif={stageGif}
            onFetchTenor={fetchTenor}
            onTenorStatus={tenorStatus}
            onUploadGif={uploadGif}
            onDeleteGif={deleteGif}
            onClose={() => setShowGifPicker(false)}
          />
        )}
        {pendingQuotes.length > 0 && (
          <div className="composer-quotes" aria-label="Replying to">
            {pendingQuotes.map((q) => (
              <div className="composer-quote" key={q.id}>
                <div className="composer-quote-body">
                  <div className="composer-quote-head">
                    <span className="composer-quote-author">{q.author}</span>
                    {formatMessageTime(q.ts) && <span className="composer-quote-time">{formatMessageTime(q.ts)}</span>}
                  </div>
                  <QuoteBody text={q.text} className="composer-quote-text" />
                </div>
                <button type="button" className="composer-quote-remove" onClick={() => removePendingQuote(q.id)} aria-label={`Stop replying to ${q.author}`}>✕</button>
              </div>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div className="mention-popup" role="listbox" aria-label="Mention someone">
            {mentionOptions.map((who, i) => (
              <button
                key={who}
                type="button"
                role="option"
                aria-selected={i === mentionActive}
                className={`mention-option${i === mentionActive ? ' active' : ''}`}
                // mousedown, not click: a click would blur the input first and close the list.
                onMouseDown={(e) => { e.preventDefault(); pickMention(who) }}
                onMouseEnter={() => setMentionIndex(i)}
              >
                <span className="mention-at">@</span>{who}
              </button>
            ))}
            <span className="mention-hint">↑↓ to choose · Enter to pick · Esc to dismiss</span>
          </div>
        )}
        {/* Always rendered at a fixed height, so the message list does not jump every time someone
            starts or stops typing. */}
        <div className="typing-line" aria-live="polite">
          {typingLabel && (<><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingLabel}</>)}
        </div>
        <div className="composer-inner">
          <button type="button" className="attach" onClick={() => fileInputRef.current?.click()} title="Attach file" aria-label="Attach file">
            <PaperclipIcon />
          </button>
          <button type="button" className="attach gif-toggle" onClick={() => { setShowEmojiPicker(false); setShowGifPicker((open) => { if (!open) loadGifs(); return !open }) }} title="GIF" aria-label="GIF" aria-expanded={showGifPicker}>
            <span className="gif-toggle-label">GIF</span>
          </button>
          <button type="button" className="attach emoji-toggle" onClick={() => { setShowGifPicker(false); setShowEmojiPicker((open) => { if (!open) loadServerEmojis(currentServerId()); return !open }) }} title="Emoji" aria-label="Emoji" aria-expanded={showEmojiPicker}>
            <span style={{fontSize:22,lineHeight:1}}>😊</span>
          </button>
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setMentionIndex(0)
              if (e.target.value.trim()) noteTyping()
            }}
            placeholder={placeholder}
            onKeyDown={onComposerKeyDown}
            onPaste={handleComposerPaste}
          />
          <button className="send" onClick={handleSend} disabled={!canSend} aria-disabled={!canSend}>
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

  // Steer phones/tablets to the installed app. Skipped in the Electron shell, when already running
  // standalone (installed), and once the user opts to continue in the browser for this session.
  const showInstallGate = !isDesktopApp && !isStandalone() && !installedNow && !installGateSkipped
    && detectPlatform().isMobile

  return (
    <div className={`app${mobileNavOpen ? ' mobile-nav-open' : ''}`}>

      {!bootDone && (
        <BootSplash
          steps={bootSteps}
          note={bootNote}
          resolveSrc={(u) => import.meta.env.BASE_URL + u}
        />
      )}

      {/* Tile image picker + cropper. The input is hidden; the rail's context menus drive it. */}
      <input
        ref={tileFileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={onTileFilePicked}
      />
      <PrivateMessageModal
        open={!!pmTarget}
        recipient={pmTarget}
        sending={pmSending}
        error={pmError}
        onCancel={closePrivateMessage}
        onSend={sendPrivateMessage}
      />

      <ImageCropModal
        open={!!tileCrop}
        file={tileCrop?.file || null}
        title={tileCrop?.target?.kind === 'home' ? 'Crop your Home tile' : `Crop the ${tileCrop?.target?.name || 'server'} icon`}
        onCancel={() => setTileCrop(null)}
        onConfirm={uploadTileImage}
      />

      <ImageCropModal
        open={!!avatarCrop}
        file={avatarCrop}
        title="Crop your profile picture"
        hint="Everyone sees this square, shown as a circle."
        outputPx={256}
        onCancel={() => setAvatarCrop(null)}
        onConfirm={async (cropped) => { await uploadProfileAvatar(cropped); setAvatarCrop(null) }}
      />

      {showInstallGate && (
        <MobileInstallGate
          deferredPrompt={deferredPrompt}
          onInstalled={() => setInstalledNow(true)}
          onDismiss={() => { rememberInstallGateDismissed(); setInstallGateSkipped(true) }}
        />
      )}

      {/* Phone layout: the left nav is an off-canvas drawer, so tapping the backdrop dismisses it. */}
      <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />

      <AppLeftPane
        displayName={name}
        profile={profile}
        resolveAvatarSrc={emojiSrc}
        onOpenAppDirectory={openAppDirectory}
        appReviewCount={pendingAppReviews}
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
        onFriendVoiceChat={(friend) => startCall(friend?.peerUsername || friend?.name, false)}
        onViewProfile={(person) => openMemberProfile(person?.peerUsername || person?.name)}
        onRemoveFriend={removeFriend}
        onLeaveGroup={leaveGroup}
        askPrompt={askPrompt}
        savedHomeLayout={userSettings ? (userSettings.homeLayout ?? null) : undefined}
        onHomeLayoutChange={saveHomeLayout}
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
        onManageAccess={(id, chName) => setManageAccessChannel({ id, name: chName })}
        activeChannel={activeChannel}
        onJoinChannel={joinChannel}
        voiceChannelId={voiceChannelId}
        voiceServerId={inVoice ? voiceServerIdRef.current : null}
        onJoinVoice={joinVoiceChannel}
        onLeaveVoice={leaveVoice}
        members={serverMembers}
        paneTab={serverPaneTab}
        onPaneTabChange={setServerPaneTab}
        homeTileUrl={userSettings?.homeTileUrl || null}
        resolveTileSrc={emojiSrc}
        onChangeTileImage={openTileImagePicker}
        onResetTileImage={resetTileImage}
        onPrivateMessage={openPrivateMessage}
        socketId={socket?.id}
        onSelectMember={openMemberProfile}
        myRole={serverState?.myRole || 'member'}
        serverOwner={serverState?.server?.owner || null}
        currentUsername={name}
        onInviteServer={openServerInvite}
        onLeaveServer={leaveServer}
        onKickMember={kickMember}
        onSetMemberRole={setMemberRole}
        channelUnreads={channelUnreads[selectedServerId] || {}}
        serverUnreadTotals={serverUnreadTotals}
        channelMentions={channelMentions[selectedServerId] || {}}
        serverMentionTotals={serverMentionTotals}
      />

      <div className="main">
            <div className="topbar">
              <div className="topbar-inner" style={{justifyContent:'space-between'}}>
                  <div className="topbar-left" style={{display:'flex',gap:12,alignItems:'center'}}>
                    {/* Only rendered on phone widths (CSS-gated) — opens the nav drawer. */}
                    <button
                      type="button"
                      className="mobile-nav-toggle"
                      onClick={() => setMobileNavOpen((v) => !v)}
                      aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
                      aria-expanded={mobileNavOpen}
                    >
                      <span aria-hidden="true">☰</span>
                    </button>
                    {/* In a server the name is already the header above the channel list, so
                        repeating it here is redundant. In DM/group view this slot is the "Direct
                        Message" / "Group Message" qualifier, which appears nowhere else — keep it. */}
                    {showHomeChat && <div className="topbar-server">{topbarServerLabel}</div>}
                    <div className="topbar-channel">{topbarChannelLabel}</div>
                  </div>

                  <div className="topbar-right" style={{display:'flex',gap:8,alignItems:'center'}}>
                    <button
                      type="button"
                      className="topbar-icon-btn"
                      onClick={() => setShowSearch(true)}
                      title="Search messages"
                      aria-label="Search messages"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                        <circle cx="10.5" cy="10.5" r="6.5" />
                        <path d="M15.5 15.5 21 21" />
                      </svg>
                    </button>
                    {!isDesktopApp && (
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
                      }}>Download App</button>
                    )}
                    {showHomeChat && homeChat?.peerUsername && !call && (
                      <button className="call-btn" title={`Call ${homeChat.peerUsername}`} onClick={() => startCall(homeChat.peerUsername, false)}>
                        <span aria-hidden>📞</span> Call
                      </button>
                    )}
                    {/* Group DMs only — see showMembersButton. Servers use the side panel's tab. */}
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
                ) : (<>
                  {renderHistoryStart()}
                  {homeChatMessages.map((m, i) => (
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
                      quickReactions={quickReactions}
                      skinTones={emojiSkinTones}
                      onReply={quoteMessage}
                      onOpenMedia={(attachment) => openLightbox(homeChatMessages, attachment)}
                      emojiMap={emojiMap}
                      onSaveEmoji={saveCustomEmojiFromChat}
                      onForward={openForward}
                    />
                  ))}
                  {renderHistoryEnd()}
                </>)}
              </div>

              {renderPresentBar()}
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
              {channelPins.length > 0 && (
                <button
                  type="button"
                  className="pin-bar"
                  onClick={() => jumpToMessage(channelPins[0].id)}
                  onContextMenu={openPinBarMenu}
                  {...longPressProps(openPinBarMenu)}
                  title="Tap to view · long-press (or right-click) for options"
                >
                  <span className="pin-bar-icon">📌</span>
                  <span className="pin-bar-body">
                    <span className="pin-bar-author">{channelPins[0].author}</span>
                    <span className="pin-bar-text">{pinPreview(channelPins[0])}</span>
                  </span>
                  {channelPins.length > 1 && <span className="pin-bar-count">{channelPins.length} pins</span>}
                </button>
              )}
              <div ref={messagesListRef} className={`${messages.length === 0 ? 'messages empty' : 'messages'} flow-${messageFlow}`}>
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">#</div>
                    <div className="empty-title">No messages yet</div>
                    <div className="empty-sub">Be the first to say something!</div>
                  </div>
                ) : (<>
                  {renderHistoryStart()}
                  {messages.map((m, i) => (
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
                      quickReactions={quickReactions}
                      skinTones={emojiSkinTones}
                      onReply={quoteMessage}
                      onOpenMedia={(attachment) => openLightbox(messages, attachment)}
                      emojiMap={emojiMap}
                      onSaveEmoji={saveCustomEmojiFromChat}
                      onForward={openForward}
                      onPin={pinMessage}
                      onUnpin={unpinMessage}
                      isPinned={pinnedIdSet.has(m.id)}
                    />
                  ))}
                  {renderHistoryEnd()}
                </>)}
              </div>

              {renderPresentBar()}
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
                  ...participantIds.map((id) => ({ key: id, stream: remoteStreams[id] || null, label: peerNames[id] || 'Guest', muted: deafened, sinkId: selectedSpeakerId, isScreen: !!screenSharingPeers[id], volume: peerVolumes[peerNames[id]] ?? 1, onVolume: peerNames[id] ? (v) => setPeerVolume(peerNames[id], v) : undefined })),
                ]
                const start = voicePageClamped * VOICE_TILES_PER_PAGE
                const pageTiles = tiles.slice(start, start + VOICE_TILES_PER_PAGE)
                return (
                  <>
                    <div className="video-stage-wrap">
                      {activity ? (
                        <ActivityPanel activity={activity} me={name} onEvent={sendActivityEvent} onClose={closeActivity} askPrompt={askPrompt} appHost={appHost} />
                      ) : (
                        <>
                          <div className="video-stage" ref={videoStageRef} style={{ gridTemplateColumns: `repeat(${voiceGrid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${voiceGrid.rows}, minmax(0, 1fr))` }}>
                            {pageTiles.map((t) => (
                              <VideoTile key={t.key} stream={t.stream} label={t.label} muted={t.muted} sinkId={t.sinkId} isScreen={t.isScreen} volume={t.volume} onVolume={t.onVolume} onExpand={(s, l) => setFullscreenStream({ stream: s, label: l })} />
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
                            {/* Says what the pipeline is doing. A model that is still downloading looks
                                identical to one that is broken — both show an unblurred camera. */}
                            {effectsStatus === 'loading' && <div className="voice-effects-status loading">Preparing background effects…</div>}
                            {effectsStatus === 'unavailable' && <div className="voice-effects-status error">{effectsError || 'Background effects are unavailable'}</div>}
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
                            onClick={() => { warmUpEffects().catch(() => {}); setShowEffectsMenu((v) => !v) }}
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
                          <div className="voice-quality-menu activity-launcher" role="menu" aria-label="Things To Do">
                            {/* The scroll lives on an inner box: the menu's tail arrow hangs outside
                                the menu, and overflow on the menu itself would clip it. */}
                            <div className="activity-launch-scroll">
                              <div className="voice-quality-title">🎉 Things To Do</div>
                              {ACTIVITY_TYPES.map((a) => (
                                <button key={a.id} type="button" role="menuitem" className="activity-launch-opt" onClick={() => startActivity(a.id)}>
                                  <span className="activity-launch-icon">{a.icon}</span>
                                  <span className="activity-launch-text">
                                    <span className="activity-launch-label">{a.label}</span>
                                    <span className="activity-launch-hint">{a.hint}</span>
                                  </span>
                                </button>
                              ))}
                              <div className="voice-quality-title activity-launch-section">🧩 Community apps</div>
                              {launchableApps.map((a) => (
                                <button key={a.id} type="button" role="menuitem" className="activity-launch-opt" onClick={() => startAppActivity(a)}>
                                  {a.iconUrl
                                    ? <img className="activity-launch-icon activity-launch-appicon" src={emojiSrc(a.iconUrl)} alt="" />
                                    : <span className="activity-launch-icon activity-launch-appicon activity-launch-appicon-fallback">{(a.name || '?').slice(0, 1).toUpperCase()}</span>}
                                  <span className="activity-launch-text">
                                    <span className="activity-launch-label">{a.name}</span>
                                    {appLaunchNote(a) && <span className="activity-launch-draft">{appLaunchNote(a)}</span>}
                                    <span className="activity-launch-hint">{a.description || `by ${a.createdBy || 'someone'}`}</span>
                                  </span>
                                </button>
                              ))}
                              {launchableApps.length === 0 && publicAppsStatus === 'ready' && (
                                <div className="activity-launch-empty">
                                  No apps yet. Upload a mini-app in the App Directory: you can start your own here straight away, and everyone can once it is approved.
                                  <button type="button" className="activity-launch-link" onClick={() => { setShowActivityMenu(false); openAppDirectory() }}>Open App Directory</button>
                                </div>
                              )}
                              {launchableApps.length === 0 && publicAppsStatus === 'error' && (
                                <div className="activity-launch-empty" role="alert">
                                  Could not load the apps.
                                  <button type="button" className="activity-launch-link" onClick={() => loadPublicApps()}>Try again</button>
                                </div>
                              )}
                              {launchableApps.length === 0 && publicAppsStatus !== 'ready' && publicAppsStatus !== 'error' && (
                                <div className="activity-launch-empty">Loading apps…</div>
                              )}
                            </div>
                          </div>
                        )}
                        <button className={`voice-ctrl${activity ? ' toggled' : ''}`} onClick={() => { if (!showActivityMenu) loadPublicApps(); setShowActivityMenu((v) => !v) }} title="Things To Do" aria-label="Things To Do" aria-pressed={!!activity} aria-haspopup="menu">
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
                            <div className="voice-effects-section">🎚️ Voice</div>
                            <button type="button" role="menuitemcheckbox" aria-checked={noiseSuppression} className={`voice-quality-opt voice-toggle-opt${noiseSuppression ? ' active' : ''}`} onClick={toggleNoiseSuppression}>
                              <span>Noise suppression</span><span className="voice-toggle-state">{noiseSuppression ? 'On' : 'Off'}</span>
                            </button>
                            <button type="button" role="menuitemcheckbox" aria-checked={pttEnabled} className={`voice-quality-opt voice-toggle-opt${pttEnabled ? ' active' : ''}`} onClick={togglePtt}>
                              <span>Push to talk</span><span className="voice-toggle-state">{pttEnabled ? 'On' : 'Off'}</span>
                            </button>
                            {pttEnabled && (
                              <>
                                <button type="button" className="voice-quality-opt voice-toggle-opt" onClick={() => setPttRebinding(true)}>
                                  <span>Talk key</span><span className="voice-toggle-state">{pttRebinding ? 'Press a key…' : keyLabel(pttKey)}</span>
                                </button>
                                <div className="voice-effects-hint">Hold the key to talk. Works while this window is focused; a browser can't see keys pressed in another app.</div>
                              </>
                            )}
                            <div className="voice-effects-hint">🔒 Your mic &amp; speakers are only accessed while you're in a call.</div>
                          </div>
                        )}
                        <button ref={micBtnRef} className={`voice-ctrl voice-ctrl-mic${micMuted ? ' toggled' : ''}${pttEnabled && !micMuted ? (pttHeld ? ' ptt-live' : ' ptt-idle') : ''}`} onClick={toggleMute} title={micMuted ? 'Unmute' : pttEnabled ? `Push to talk: hold ${keyLabel(pttKey)}` : 'Mute'} aria-label="Toggle microphone" aria-pressed={micMuted}>
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
      {/* Create-channel modal (name + type + privacy) */}
      <CreateChannelModal
        open={showChannelModal}
        initialType={channelModalType}
        serverName={serverName}
        members={(serverState?.members || []).filter((m) => m.username && m.role !== 'owner' && m.role !== 'admin' && m.username !== name)}
        onCreate={submitCreateChannel}
        onClose={() => setShowChannelModal(false)}
      />
      <ManageChannelAccessModal
        open={!!manageAccessChannel}
        serverId={currentServerId()}
        channel={manageAccessChannel}
        roster={(serverState?.members || []).filter((m) => m.username !== name)}
        serverUrl={SERVER_URL}
        token={token || localStorage.getItem('lanparty_token')}
        onClose={() => setManageAccessChannel(null)}
      />
      {/* Public profile card (click a member) */}
      {profileCard && (
        <div className="profilecard-overlay" onClick={() => setProfileCard(null)}>
          <div className="profilecard" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="discover-close profilecard-close" onClick={() => setProfileCard(null)} aria-label="Close">✕</button>
            {profileCard.loading ? (
              <div className="profilecard-loading">Loading…</div>
            ) : profileCard.notFound ? (
              <div className="profilecard-loading">Couldn't load @{profileCard.username}.</div>
            ) : (
              <>
                <div className="profilecard-head">
                  <ProfileAvatar name={profileCard.username} profile={profileCard.profile || {}} size={72} resolveSrc={emojiSrc} />
                  <div className="profilecard-id">
                    <span className="profilecard-name" style={nameStyleToCss(profileCard.profile?.nameStyle, profileCard.profile?.nameFont)}>{profileCard.username}</span>
                    <span className={`profilecard-status dc-status-${profileCard.status || 'offline'}`}>{(profileCard.status || 'offline')[0].toUpperCase() + (profileCard.status || 'offline').slice(1)}</span>
                    {(profileCard.profile?.tags || []).length > 0 && (
                      <span className="profile-preview-tags">
                        {profileCard.profile.tags.map((t) => <span key={`${t.type}-${t.label}`} className={`profile-tag profile-tag-${t.type}`}>{t.label}</span>)}
                      </span>
                    )}
                  </div>
                </div>
                {profileCard.profile?.statusMessage && <div className="profilecard-statusmsg">{profileCard.profile.statusMessage}</div>}
                {profileCard.profile?.bio && <div className="profilecard-bio">{profileCard.profile.bio}</div>}
                {((profileCard.gamingProfile?.genres || []).length > 0 || profileCard.gamingProfile?.currentGames) && (
                  <div className="profilecard-gaming">
                    <div className="profilecard-section">🎮 Gaming</div>
                    {(profileCard.gamingProfile.genres || []).length > 0 && (
                      <div className="discover-genres">{profileCard.gamingProfile.genres.map((g) => <span key={g} className="discover-genre">{g}</span>)}</div>
                    )}
                    {profileCard.gamingProfile.currentGames && (
                      <div className="profilecard-games"><span className="profilecard-games-label">Playing lately:</span> {profileCard.gamingProfile.currentGames}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {toast && <div className="app-toast" role="status">{toast}</div>}
      {/* Only shown when the update could not simply be applied: mid-call, mid-sentence, and so on. */}
      {newBuild && (
        <div className="update-bar" role="status">
          <span>A new version of LAN Party is ready.</span>
          <button type="button" onClick={() => reloadForBuild(newBuild)}>Reload</button>
        </div>
      )}

      {/* Message search. Kept mounted so the last query and its results are still there on reopening. */}
      <SearchPanel
        open={showSearch}
        onClose={() => setShowSearch(false)}
        authedFetch={authedFetch}
        here={searchHere}
        server={searchServer}
        onJump={jumpToSearchResult}
        formatTime={formatMessageTime}
        groupLabel={searchGroupLabel}
      />

      {/* Right-click menu on the pin bar: View Pins / Unpin the latest */}
      {pinBarMenu && createPortal(
        <>
          <div className="dc-ctx-backdrop" onClick={() => setPinBarMenu(null)} onContextMenu={(e) => { e.preventDefault(); setPinBarMenu(null) }} />
          <div className="dc-ctx-menu" style={{ left: pinBarMenu.x, top: pinBarMenu.y }} role="menu">
            <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setPinBarMenu(null); setShowPinsModal(true) }}>📌 View pins</button>
            <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { const top = channelPins[0]; setPinBarMenu(null); if (top) unpinMessage(top.id) }}>✖ Unpin latest</button>
          </div>
        </>,
        document.body
      )}

      {/* View Pins modal — every pinned message; click one to jump to it */}
      {showPinsModal && createPortal(
        <div className="pins-overlay" onClick={() => setShowPinsModal(false)}>
          <div className="pins-modal" role="dialog" aria-label="Pinned messages" onClick={(e) => e.stopPropagation()}>
            <div className="pins-head">
              <span>📌 Pinned messages — {channelPins.length}</span>
              <button type="button" className="discover-close" onClick={() => setShowPinsModal(false)} aria-label="Close">✕</button>
            </div>
            <div className="pins-list">
              {channelPins.length === 0 && <div className="pins-empty">No pinned messages.</div>}
              {channelPins.map((p) => (
                <div key={p.id} className="pins-item">
                  <button type="button" className="pins-item-main" onClick={() => jumpToMessage(p.id)}>
                    <span className="pins-item-author">{p.author}</span>
                    <span className="pins-item-text">{pinPreview(p)}</span>
                    {p.pinnedBy && <span className="pins-item-by">pinned by {p.pinnedBy}</span>}
                  </button>
                  <button type="button" className="pins-item-unpin" title="Unpin" onClick={() => unpinMessage(p.id)}>✖</button>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Forward picker — send a copy of a message to a channel or DM */}
      {forwardMsg && createPortal(
        <div className="pins-overlay" onClick={() => setForwardMsg(null)}>
          <div className="pins-modal" role="dialog" aria-label="Forward message" onClick={(e) => e.stopPropagation()}>
            <div className="pins-head">
              <span>↪ Forward message</span>
              <button type="button" className="discover-close" onClick={() => setForwardMsg(null)} aria-label="Close">✕</button>
            </div>
            <div className="fwd-preview"><span className="pins-item-author">{forwardMsg.author}</span> <span className="pins-item-text">{pinPreview(forwardMsg)}</span></div>
            {(() => { const { chans, dms } = forwardTargets(); return (
              <div className="pins-list">
                {chans.length > 0 && <div className="fwd-group">Channels in {serverName}</div>}
                {chans.map((t) => (
                  <button key={`c-${t.channelId}`} type="button" className="fwd-target" onClick={() => forwardToTarget(t)}>{t.label}</button>
                ))}
                {dms.length > 0 && <div className="fwd-group">Direct messages</div>}
                {dms.map((t, i) => (
                  <button key={`d-${t.peerUsername}-${i}`} type="button" className="fwd-target" onClick={() => forwardToTarget(t)}>{t.label}</button>
                ))}
                {chans.length === 0 && dms.length === 0 && <div className="pins-empty">Nowhere to forward to yet — join a server or start a DM.</div>}
              </div>
            ) })()}
          </div>
        </div>,
        document.body
      )}

      {/* Watch / Discover — who's live right now (in-app screen shares + Twitch/YouTube/Kik) */}
      {showDiscover && (() => {
        const visibleStreams = discoverStreams.filter((s) => !hiddenStreamIds.has(s.id))
        const hiddenCount = discoverStreams.length - visibleStreams.length
        const inAppStreams = visibleStreams.filter((s) => s.kind !== 'external')
        const externalStreamsList = visibleStreams.filter((s) => s.kind === 'external')
        const PLATFORM_META = { twitch: { label: 'Twitch', cls: 'twitch' }, youtube: { label: 'YouTube', cls: 'youtube' }, kik: { label: 'Kik', cls: 'kik' } }
        return (
        <div className="discover-overlay" onClick={() => setShowDiscover(false)}>
          <div className="discover-modal" role="dialog" aria-label="Discover live streams" onClick={(e) => e.stopPropagation()}>
            <div className="discover-head">
              <div className="discover-title">📡 Live now</div>
              <div className="discover-head-actions">
                {/* No "stop announcing" here any more: your own card carries an X that takes it down,
                    which keeps every card's remove affordance in the same place. */}
                {!myExternalStream && (
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
            {hiddenCount > 0 && (
              <div className="discover-hidden-note">
                {hiddenCount} stream{hiddenCount === 1 ? '' : 's'} hidden for you
                <button type="button" className="discover-unhide" onClick={unhideAllStreams}>Show {hiddenCount === 1 ? 'it' : 'them'} again</button>
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
                      <button
                        type="button"
                        className="discover-card-x"
                        onClick={(e) => { e.stopPropagation(); dismissStream(s) }}
                        title={isMyAnnouncement(s) ? 'Stop announcing your stream' : `Hide ${s.name || 'this stream'} for me`}
                        aria-label={isMyAnnouncement(s) ? 'Stop announcing your stream' : `Hide ${s.name || 'this stream'} for me`}
                      >
                        ✕
                      </button>
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
                      <button
                        type="button"
                        className="discover-card-x"
                        onClick={(e) => { e.stopPropagation(); dismissStream(s) }}
                        title={isMyAnnouncement(s) ? 'Stop announcing your stream' : `Hide ${s.name || 'this stream'} for me`}
                        aria-label={isMyAnnouncement(s) ? 'Stop announcing your stream' : `Hide ${s.name || 'this stream'} for me`}
                      >
                        ✕
                      </button>
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
      {/* In-app viewer for an external Twitch/YouTube stream. Clicking outside shrinks it to a
          draggable picture-in-picture (the iframe stays mounted, so playback never restarts). */}
      {externalViewer && (
        <div
          className={`extviewer-overlay ${streamMini ? 'mini' : ''}`}
          onClick={() => { if (!streamMini) minimizeStream() }}
          style={streamMini ? { left: streamPos.x, top: streamPos.y, width: streamSize.w, height: streamSize.h } : undefined}
        >
          <div className="extviewer-frame" onClick={(e) => e.stopPropagation()}>
            <div
              className={`extviewer-head ${streamMini ? 'drag' : ''}`}
              onPointerDown={streamMini ? startDragStream : undefined}
            >
              <span className="extviewer-title">🔴 {externalViewer.name}{streamMini ? '' : ` — ${externalViewer.title || externalViewer.channel}${externalViewer.game ? ` · 🎮 ${externalViewer.game}` : ''}`}</span>
              <div className="extviewer-head-btns">
                <button type="button" className="extviewer-mini-btn" title={streamMini ? 'Expand' : 'Minimize to a movable player'} onClick={(e) => { e.stopPropagation(); streamMini ? setStreamMini(false) : minimizeStream() }}>{streamMini ? '⤢' : '—'}</button>
                <button type="button" className="discover-close" onClick={(e) => { e.stopPropagation(); setExternalViewer(null); setStreamMini(false) }} aria-label="Close viewer">✕</button>
              </div>
            </div>
            {externalEmbedUrl(externalViewer) ? (
              <iframe className="extviewer-embed" src={externalEmbedUrl(externalViewer)} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen title="Live stream" />
            ) : (
              <div className="discover-empty">This stream can't be embedded — check the link the streamer shared.</div>
            )}
          </div>
          {streamMini && <div className="extviewer-resize" onPointerDown={startResizeStream} title="Resize" />}
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
                  <button type="button" className="profile-link-btn" onClick={() => setShowMicTest((v) => !v)} aria-expanded={showMicTest}>
                    {showMicTest ? 'Hide microphone test' : 'Test microphone'}
                  </button>
                  {showMicTest && (
                    <MicTest
                      devices={audioInputs}
                      selectedDeviceId={selectedMicId}
                      onSelectDevice={preJoinSelectMic}
                    />
                  )}
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
        users={addToGroupId
          ? newChatUsers.filter((u) => !(groupChats.find((g) => String(g.id) === String(addToGroupId))?.members || [])
            .some((m) => m.name === (u.peerUsername || u.name)))
          : newChatUsers}
        selectedIds={newChatSelectedIds}
        groupName={newChatGroupName}
        addToGroupName={addToGroupId ? (groupChats.find((g) => String(g.id) === String(addToGroupId))?.name || 'this group') : null}
        busy={groupBusy}
        onToggleUser={toggleNewChatUser}
        onGroupNameChange={setNewChatGroupName}
        onClose={closeNewChatModal}
        onCreate={createNewChat}
      />

      <div className={`overlay ${showMembersPanel || showInstallPanel || showSignOutConfirm || showStatusMenu || showAddFriendModal ? 'open' : ''}`} onClick={() => { setShowMembersPanel(false); setShowInstallPanel(false); setShowSignOutConfirm(false); setShowStatusMenu(false); closeAddFriendModal() }} />
      <div className={`members-panel ${showMembersPanel ? 'open' : ''}`} role="dialog" aria-hidden={!showMembersPanel}>
        <div className="members-panel-header">
          <div>{isHomeView ? 'Members' : 'Server Members'} — {membersPanelUsers.length}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!isHomeView && (serverState?.myRole === 'owner' || serverState?.myRole === 'admin') && currentServerId() !== 'demo' && (
              <button className="members-invite-btn" title="Invite people" onClick={() => openServerInvite(currentServerId(), serverState?.server?.name)}>+ Invite</button>
            )}
            {activeGroupChat && (
              <>
                <button className="members-invite-btn" title="Add people to this group" onClick={() => openAddToGroup(activeGroupChat.id)}>+ Add</button>
                <button className="members-invite-btn" title="Rename this group" onClick={() => renameGroup(activeGroupChat)}>Rename</button>
              </>
            )}
            <button className="members-close" onClick={() => setShowMembersPanel(false)}>✕</button>
          </div>
        </div>
        <div className="members-panel-body">
          {membersPanelUsers.length > 0 ? (
            <ul className="members-panel-list">
              {membersPanelUsers.map((member) => {
                const myRole = serverState?.myRole
                const isStaff = myRole === 'owner' || myRole === 'admin'
                const role = member.role || 'member'
                const canManage = !isHomeView && currentServerId() !== 'demo' && isStaff && !member.isYou && member.username
                  && role !== 'owner' && !(myRole === 'admin' && role === 'admin')
                // Everyone gets a menu (for Private message); only staff get the manage entries. This
                // is the group-chat path, which is why it can't be staff-gated like it used to be.
                const hasMenu = Boolean(member.username) && !member.isYou
                return (
                  <li key={member.id}>
                    <button
                      type="button"
                      className="members-panel-row"
                      onClick={() => member.username && openMemberProfile(member.username)}
                      onContextMenu={hasMenu ? (e) => openMemberMenu(e, member, role, canManage) : undefined}
                      {...(hasMenu ? longPressProps((e) => openMemberMenu(e, member, role, canManage)) : {})}
                      title={member.username ? `View ${member.name}'s profile${hasMenu ? ' — right-click for more' : ''}` : undefined}
                    >
                      {(!isHomeView || activeGroupChat) && <span className={`dc-member-dot ${member.online ? 'online' : 'offline'}`} />}
                      <span className="members-panel-name">{member.name}{member.isYou ? ' (you)' : ''}</span>
                      {role === 'owner' && <span className="dc-member-role owner" title="Owner">👑</span>}
                      {role === 'admin' && <span className="dc-member-role admin" title="Admin">🛡️</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div style={{ color: '#9fb0bf', fontSize: 14 }}>No members found for this chat.</div>
          )}
          {activeGroupChat && (
            <button type="button" className="members-leave-btn" onClick={() => leaveGroup(activeGroupChat)}>Leave group</button>
          )}
        </div>
      </div>

      {/* Right-click manage menu for a member (kick / promote), staff only */}
      {memberMenu && createPortal(
        <>
          <div className="dc-ctx-backdrop" onClick={() => setMemberMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMemberMenu(null) }} />
          <div className="dc-ctx-menu" style={{ left: memberMenu.x, top: memberMenu.y }} role="menu">
            <div className="dc-ctx-title">{memberMenu.name}{memberMenu.role !== 'member' ? ` · ${memberMenu.role}` : ''}</div>
            <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setMemberMenu(null); openPrivateMessage({ username: memberMenu.username, name: memberMenu.name }) }}>✉️ Private message</button>
            {/* Manage entries are staff-only; the menu itself now opens for every member. */}
            {memberMenu.canManage && serverState?.myRole === 'owner' && memberMenu.role === 'member' && (
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setMemberMenu(null); setMemberRole(memberMenu.username, 'admin') }}>🛡️ Make admin</button>
            )}
            {memberMenu.canManage && serverState?.myRole === 'owner' && memberMenu.role === 'admin' && (
              <button type="button" role="menuitem" className="dc-ctx-item" onClick={() => { setMemberMenu(null); setMemberRole(memberMenu.username, 'member') }}>⬇️ Remove admin</button>
            )}
            {memberMenu.canManage && (
              <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { setMemberMenu(null); kickMember(memberMenu.username) }}>🚫 Remove from server</button>
            )}
            {activeGroupChat && activeGroupChat.ownerUsername === name && memberMenu.username !== name && (
              <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={() => { const groupId = activeGroupChat.id; setMemberMenu(null); removeFromGroup(groupId, memberMenu.username) }}>🚫 Remove from group</button>
            )}
          </div>
        </>,
        document.body
      )}

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
            <img className="auth-logo" src={import.meta.env.BASE_URL + 'icons/logo-192.png'} alt="LAN Party logo" width="84" height="84" />
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
            <InviteJoinNotice invite={inviteJoin.state} onDismiss={inviteJoin.dismiss} onRetry={inviteJoin.retry} resolveSrc={emojiSrc} />
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

                <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}>
                  <button type="submit" className="connect-btn" disabled={!canCreate} aria-disabled={!canCreate}>{authLoading ? 'Creating...' : 'Create Account'}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* First-login onboarding: a welcome screen, then the gaming profile (moved out of signup) */}
      {isAuthenticated && showOnboarding && (
        <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onb-title">
          <div className="onboarding-card">
            {onbStep === 0 ? (
              <>
                <img className="onboarding-logo" src={import.meta.env.BASE_URL + 'icons/logo-192.png'} alt="LAN Party logo" width="72" height="72" />
                <div className="onboarding-eyebrow">Welcome to LAN Party</div>
                <h2 id="onb-title" className="onboarding-title">Hey {name}! 🎉</h2>
                <p className="onboarding-lede">
                  This is your place for game nights — text &amp; voice channels, camera and screen
                  share, party activities like synced music and Sketch &amp; Guess, and watching
                  Twitch, YouTube &amp; Kik streams together. Create a server or hop into a friend's to
                  get going.
                </p>
                <div className="onboarding-actions">
                  <button className="onboarding-btn primary" onClick={() => setOnbStep(1)}>Get started →</button>
                </div>
              </>
            ) : (
              <>
                <div className="onboarding-eyebrow">Step 2 of 2</div>
                <h2 id="onb-title" className="onboarding-title">🎮 What do you love playing?</h2>
                <p className="onboarding-lede">Pick your favorite genres so friends can find you on Discover — totally optional, and you can change it later in your profile.</p>
                <div className="reg-genres onboarding-genres">
                  {GAME_GENRES.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`reg-genre${onbGenres.includes(g) ? ' active' : ''}`}
                      onClick={() => setOnbGenres((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g])}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <label className="onboarding-label">What are you playing right now? <span className="reg-optional">(past 2 weeks)</span></label>
                <input
                  className="onboarding-input"
                  type="text"
                  placeholder="e.g. Valorant, Baldur's Gate 3"
                  maxLength={200}
                  value={onbCurrentGames}
                  onChange={(e) => setOnbCurrentGames(e.target.value)}
                />
                <div className="onboarding-actions between">
                  <button className="onboarding-btn ghost" onClick={() => finishOnboarding(true)} disabled={onbSaving}>Skip</button>
                  <button className="onboarding-btn primary" onClick={() => finishOnboarding(false)} disabled={onbSaving}>{onbSaving ? 'Saving…' : 'Finish'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* In-app text prompt — replaces window.prompt (unsupported in the Electron desktop app) */}
      {promptModal && (
        <div className="prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onMouseDown={(e) => { if (e.target === e.currentTarget) resolvePrompt(null) }}>
          <div className="prompt-card">
            <div id="prompt-title" className="prompt-title">{promptModal.title}</div>
            {promptModal.label && <label className="prompt-label" htmlFor="prompt-input">{promptModal.label}</label>}
            <input
              id="prompt-input"
              className="prompt-input"
              autoFocus
              type="text"
              maxLength={80}
              placeholder={promptModal.placeholder}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); resolvePrompt(promptValue) }
                else if (e.key === 'Escape') { e.preventDefault(); resolvePrompt(null) }
              }}
            />
            <div className="prompt-actions">
              <button className="prompt-btn ghost" onClick={() => resolvePrompt(null)}>Cancel</button>
              <button className="prompt-btn primary" onClick={() => resolvePrompt(promptValue)}>{promptModal.submitLabel}</button>
            </div>
          </div>
        </div>
      )}

      {/* Invite friends to a server — friends already in the server show a ✓ instead of Add. */}
      {inviteModal && (
        <div className="invite-overlay" role="dialog" aria-modal="true" aria-labelledby="invite-title" onMouseDown={(e) => { if (e.target === e.currentTarget) setInviteModal(null) }}>
          <div className={`invite-card${inviteModalIsStaff ? ' has-links' : ''}`}>
            <div className="invite-header">
              <span id="invite-title" className="invite-title">Invite friends to <strong>{inviteModal.serverName}</strong></span>
              <button className="invite-close" aria-label="Close" onClick={() => setInviteModal(null)}>✕</button>
            </div>

            {friends.length === 0 ? (
              <div className="invite-empty">You don’t have any friends yet. Add friends first, then invite them here.</div>
            ) : (() => {
              const q = inviteQuery.trim().toLowerCase()
              const shown = q ? friends.filter((f) => f.name.toLowerCase().includes(q)) : friends
              return (
                <>
                  <input
                    className="invite-search"
                    type="text"
                    value={inviteQuery}
                    onChange={(e) => setInviteQuery(e.target.value)}
                    placeholder="Search friends…"
                    aria-label="Search friends"
                    autoFocus
                  />
                  {shown.length === 0 ? (
                    <div className="invite-empty">No friends match “{inviteQuery.trim()}”.</div>
                  ) : (
                    <ul className="invite-list">
                      {shown.map((f) => {
                        const uname = f.name
                        const already = inviteMembers.has(uname)
                        const busy = inviteBusy.has(uname)
                        return (
                          <li key={f.id || uname} className="invite-row">
                            <div className="invite-row-main">
                              <ProfileAvatar name={uname} profile={f.profile || {}} size={34} resolveSrc={emojiSrc} />
                              <span className="invite-row-name" style={f.profile ? nameStyleToCss(f.profile.nameStyle, f.profile.nameFont) : undefined}>{uname}</span>
                            </div>
                            {already ? (
                              <span className="invite-added" title="Already in this server">✓ In server</span>
                            ) : (
                              <button className="invite-add-btn" disabled={busy} onClick={() => inviteFriendToServer(uname)}>
                                {busy ? 'Adding…' : 'Add'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </>
              )
            })()}
            {inviteLoadingMembers && <div className="invite-loading">Checking who’s already in…</div>}

            {/* Links are minted by owner/admins only; the server enforces it, this just hides the controls. */}
            {inviteModalIsStaff && <InviteLinkSection serverId={inviteModal.serverId} authedFetch={authedFetch} />}

            <div className="invite-actions">
              <button className="feedback-btn primary" onClick={() => setInviteModal(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Arrived through an invite link: confirm before joining. Held back until the boot splash and
          first-login onboarding are out of the way, so it is never fighting them for the screen. */}
      <InviteJoinDialog
        open={isAuthenticated && bootDone && !showOnboarding}
        invite={inviteJoin.state}
        resolveSrc={emojiSrc}
        onAccept={acceptServerInvite}
        onDismiss={inviteJoin.dismiss}
        onRetry={inviteJoin.retry}
      />

      {/* Direct friend call: incoming ring, or the in-call bar (remote audio plays via RemoteMedia) */}
      {call && (
        <>
          <RemoteMedia stream={callRemoteStream} video={call.video} />
          {call.status === 'incoming' ? (
            <div className="call-overlay" role="dialog" aria-modal="true" aria-label={`Incoming call from ${call.peer}`}>
              <div className="call-ring-card">
                <div className="call-ring-avatar">{(call.peer || '?').slice(0, 1).toUpperCase()}</div>
                <div className="call-ring-name">{call.peer}</div>
                <div className="call-ring-sub">Incoming {call.video ? 'video ' : ''}call…</div>
                <div className="call-ring-actions">
                  <button className="call-ring-btn decline" onClick={declineCall}>Decline</button>
                  <button className="call-ring-btn accept" onClick={acceptCall}>Accept</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="call-bar">
              <div className="call-bar-info">
                <span className="call-bar-avatar">{(call.peer || '?').slice(0, 1).toUpperCase()}</span>
                <span className="call-bar-text">
                  <span className="call-bar-name">{call.peer}</span>
                  <span className="call-bar-status">{call.status === 'outgoing' ? 'Calling…' : call.status === 'connecting' ? 'Connecting…' : formatDuration(callElapsed)}</span>
                </span>
              </div>
              <div className="call-bar-actions">
                {(call.status === 'connected' || call.status === 'connecting') && (
                  <button className={`call-bar-btn ${callMuted ? 'active' : ''}`} title={callMuted ? 'Unmute' : 'Mute'} onClick={toggleCallMute}>{callMuted ? '🔇' : '🎙️'}</button>
                )}
                <button className="call-bar-btn hangup" title="Hang up" onClick={hangUpCall}>📞</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Email-link account flows: password reset / deactivation confirm (works signed-out too) */}
      {(accountFlow || flowDone) && (
        <div className="account-flow-overlay" role="dialog" aria-modal="true">
          <div className="account-flow-card">
            {flowDone ? (
              <>
                <div className="account-flow-logo">🎮</div>
                <h2 className="account-flow-title">All set</h2>
                <p className="account-flow-text">{flowDone}</p>
                <div className="account-flow-actions single"><button className="account-flow-btn primary" onClick={() => setFlowDone(null)}>Continue</button></div>
              </>
            ) : accountFlow.type === 'reset' ? (
              <>
                <h2 className="account-flow-title">Reset your password</h2>
                <p className="account-flow-text">Set a new password for <b>{accountFlow.email}</b>.</p>
                <input className="account-flow-input" type="password" placeholder="New password" value={flowPassword} onChange={(e) => setFlowPassword(e.target.value)} />
                <input className="account-flow-input" type="password" placeholder="Confirm new password" value={flowPasswordConfirm} onChange={(e) => setFlowPasswordConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitReset() }} />
                {flowError && <div className="account-flow-error">{flowError}</div>}
                <div className="account-flow-actions">
                  <button className="account-flow-btn ghost" onClick={() => setAccountFlow(null)}>Cancel</button>
                  <button className="account-flow-btn primary" disabled={flowBusy || !flowPassword} onClick={submitReset}>{flowBusy ? 'Saving…' : 'Reset password'}</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="account-flow-title">Confirm deactivation</h2>
                <p className="account-flow-text">This permanently deletes the account for <b>{accountFlow.email}</b> and all its data. This can’t be undone.</p>
                {flowError && <div className="account-flow-error">{flowError}</div>}
                <div className="account-flow-actions">
                  <button className="account-flow-btn ghost" onClick={() => setAccountFlow(null)}>Cancel</button>
                  <button className="account-flow-btn danger" disabled={flowBusy} onClick={submitDeactivateConfirm}>{flowBusy ? 'Deleting…' : 'Delete Account'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Public app directory */}
      <AppDirectoryModal
        open={showAppDirectory}
        apps={publicApps}
        instanceOwner={instanceOwner}
        onClose={() => setShowAppDirectory(false)}
        onRefresh={loadPublicApps}
        request={appsRequest}
        uploadIcon={uploadAppIcon}
        onOpenApp={(app) => { viewerFromDirectoryRef.current = true; setViewerApp(app); setShowAppDirectory(false) }}
        me={describeAppPerson(name)}
        currentUser={name}
        resolveSrc={emojiSrc}
      />

      {/* Sandboxed viewer for embedded (uploaded) mini-apps. Opened from the directory, it sits
          under that modal, so the directory steps aside for it and comes back when it closes. */}
      <AppViewer
        app={viewerApp}
        resolveSrc={emojiSrc}
        me={describeAppPerson(name)}
        onClose={() => {
          setViewerApp(null)
          if (viewerFromDirectoryRef.current) { viewerFromDirectoryRef.current = false; openAppDirectory() }
        }}
      />

      {/* Install panel (fallback) */}
      <div className={`members-panel install-panel ${showInstallPanel ? 'open' : ''}`} role="dialog" aria-hidden={!showInstallPanel}>
        <div className="members-panel-header">
          <div>Install LAN Party</div>
          <button className="members-close" onClick={() => setShowInstallPanel(false)}>✕</button>
        </div>
        <div className="members-panel-body install-panel-body">
          <a className="install-option" href={`${SERVER_URL}/downloads/LAN-Party-Setup.exe`} download>
            <span className="install-option-title">⬇ Windows app</span>
            <span className="install-option-desc">Windows 10 &amp; 11. Updates itself, keeps calls going from the tray.</span>
          </a>
          <a className="install-option" href={`${SERVER_URL}/downloads/LAN-Party.apk`} download>
            <span className="install-option-title">⬇ Android app</span>
            <span className="install-option-desc">Android 5+. Open the file once it downloads, and allow installs from your browser if asked.</span>
          </a>
          <p className="install-panel-note">Or install it from your browser: look for “Install app” in the address bar or the browser menu.</p>
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
          <h2 id="profile-settings-title">{showProfileEditor ? 'Edit Profile' : 'Settings'}</h2>
          <button type="button" className="members-close" onClick={() => setShowSettingsPanel(false)} aria-label="Close">✕</button>
        </div>
        {/* In Edit Profile mode the non-profile tabs are hidden so the popup is focused on the profile. */}
        {!showProfileEditor && (
        <div className="profile-settings-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={settingsTab === 'profile'} className={`profile-settings-tab${settingsTab === 'profile' ? ' active' : ''}`} onClick={() => setSettingsTab('profile')}>Profile</button>
          <button type="button" role="tab" aria-selected={settingsTab === 'appearance'} className={`profile-settings-tab${settingsTab === 'appearance' ? ' active' : ''}`} onClick={() => setSettingsTab('appearance')}>Appearance</button>
          <button type="button" role="tab" aria-selected={settingsTab === 'messages'} className={`profile-settings-tab${settingsTab === 'messages' ? ' active' : ''}`} onClick={() => setSettingsTab('messages')}>Messages</button>
          <button type="button" role="tab" aria-selected={settingsTab === 'feedback'} className={`profile-settings-tab${settingsTab === 'feedback' ? ' active' : ''}`} onClick={() => { setFeedbackResult(null); setFeedbackSubmitting(false); setSettingsTab('feedback') }}>Feedback</button>
        </div>
        )}
        <div className="profile-settings-body" ref={settingsBodyRef}>
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
              {!showProfileEditor && (
                <button
                  type="button"
                  className="profile-edit-toggle"
                  aria-expanded={showProfileEditor}
                  onClick={() => setShowProfileEditor(true)}
                >
                  Edit Profile
                </button>
              )}
            </div>

            {/* Gaming profile — set during onboarding; not part of the Edit Profile popup */}
            {!showProfileEditor && (
            <div className="gaming-profile-card">
              <div className="settings-section-head">
                <h3 className="profile-settings-section-title">🎮 Gaming Profile</h3>
                <button type="button" className="settings-edit-btn" onClick={() => setEditGenresOpen((v) => !v)} aria-expanded={editGenresOpen}>
                  {editGenresOpen ? 'Done' : 'Edit'}
                </button>
              </div>
              {/* The full genre grid is long, so it stays behind Edit; the chosen genres read back as
                  a summary line. */}
              {editGenresOpen ? (
                <>
                  <div className="gaming-sub">Favorite genres</div>
                  <div className="reg-genres">
                    {GAME_GENRES.map((g) => (
                      <button key={g} type="button" className={`reg-genre${(editingGaming.genres || []).includes(g) ? ' active' : ''}`} onClick={() => toggleEditGenre(g)}>{g}</button>
                    ))}
                  </div>
                </>
              ) : (
                (editingGaming.genres || []).length > 0 && (
                  <div className="settings-readback">{(editingGaming.genres || []).join(' · ')}</div>
                )
              )}
              <div className="gaming-sub">Recently Played</div>
              <input
                type="text"
                className="profile-text-input"
                placeholder="e.g. Valorant, Baldur's Gate 3"
                maxLength={200}
                value={editingGaming.currentGames || ''}
                onChange={(e) => updateGamingProfile({ currentGames: e.target.value })}
              />
            </div>
            )}

            {showProfileEditor && (
            <div className="profile-editor-panel">
            {/* Avatar */}
            <h3 className="profile-settings-section-title">Profile Picture</h3>
            <div className="profile-edit-row">
              <button type="button" className="connect-btn" onClick={() => profileAvatarInputRef.current?.click()}>Upload image / GIF</button>
              {editingProfile.avatarUrl && <button type="button" className="profile-link-btn" onClick={() => updateProfileDraft({ avatarUrl: '' })}>Remove</button>}
              <input ref={profileAvatarInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { pickProfileAvatar(e.target.files?.[0]); if (e.target) e.target.value = '' }} />
            </div>
            <div className="profile-edit-row">
              <input
                type="text"
                className="profile-text-input"
                placeholder="…or paste an image URL"
                value={editingProfile.avatarUrl || ''}
                onChange={(e) => updateProfileDraft({ avatarUrl: e.target.value })}
              />
            </div>
            {editingProfile.avatarUrl ? (
              <div className="profile-pic-confirm">
                <img className="profile-pic-confirm-thumb" src={emojiSrc(editingProfile.avatarUrl)} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
                <span>✓ Picture set — click <b>Save Profile</b> to apply it.</span>
              </div>
            ) : null}

            {/* Entrance sound — your own recording, played for others when you join voice chat */}
            <h3 className="profile-settings-section-title">Entrance Sound</h3>
            <EntranceSoundRecorder
              url={editingProfile.entranceSound || ''}
              onRecorded={uploadEntranceSound}
              onRemove={removeEntranceSound}
              resolveSrc={emojiSrc}
              busy={entranceBusy}
            />

            {/* Border decoration — preset dropdown, with an optional colour re-tint */}
            <h3 className="profile-settings-section-title">Border Decoration</h3>
            <div className="profile-edit-row">
              <select className="profile-select" value={editingProfile.border?.preset || 'none'} onChange={(e) => selectBorderPreset(e.target.value)} aria-label="Border decoration">
                {BORDER_PRESETS.map((bp) => <option key={bp.id} value={bp.id}>{bp.label}</option>)}
                <option value="custom">Custom…</option>
              </select>
              {(editingProfile.border?.preset || 'none') !== 'none' && (
                <>
                  <label className="profile-inline-label">Color
                    <input
                      type="color"
                      value={editingProfile.border?.tint || borderPresetColor(editingProfile.border)}
                      onChange={(e) => updateProfileBorder({ tint: e.target.value })}
                      aria-label="Border color"
                    />
                  </label>
                  {editingProfile.border?.tint && (
                    <button type="button" className="profile-link-btn" onClick={() => updateProfileBorder({ tint: '' })}>Reset color</button>
                  )}
                </>
              )}
            </div>
            {editingProfile.border?.preset === 'custom' && (
              <div className="profile-edit-row">
                <label className="profile-inline-label">Width
                  <input type="range" min="0" max="8" value={editingProfile.border.width || 0} onChange={(e) => updateProfileBorder({ width: Number(e.target.value) })} />
                  <span>{editingProfile.border.width || 0}px</span>
                </label>
                <select className="profile-select" value={editingProfile.border.style || 'solid'} onChange={(e) => updateProfileBorder({ style: e.target.value })} aria-label="Border style">
                  {BORDER_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}

            {/* Animation overlay — dropdown + colour */}
            <h3 className="profile-settings-section-title">Animation Overlay</h3>
            <div className="profile-edit-row">
              <select className="profile-select" value={editingProfile.overlay || 'none'} onChange={(e) => selectOverlay(e.target.value)} aria-label="Animation overlay">
                {AVATAR_OVERLAYS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {(editingProfile.overlay || 'none') !== 'none' && (
                <>
                  <label className="profile-inline-label">Color
                    <input
                      type="color"
                      value={editingProfile.overlayColor || editingSettings?.accentEnd || '#0b86ff'}
                      onChange={(e) => updateProfileDraft({ overlayColor: e.target.value })}
                      aria-label="Overlay color"
                    />
                  </label>
                  {editingProfile.overlayColor && (
                    <button type="button" className="profile-link-btn" onClick={() => updateProfileDraft({ overlayColor: '' })}>Reset color</button>
                  )}
                </>
              )}
            </div>

            {/* Name styling — font + style dropdowns, with colours for the chosen style */}
            <h3 className="profile-settings-section-title">Username Style</h3>
            <div className="profile-edit-row">
              <select className="profile-select" value={editingProfile.nameFont} onChange={(e) => updateProfileDraft({ nameFont: e.target.value })} aria-label="Username font">
                {NAME_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label} font</option>)}
              </select>
              <select className="profile-select" value={editingProfile.nameStyle?.id || 'plain'} onChange={(e) => selectNameStyle(e.target.value)} aria-label="Username style">
                {NAME_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            {(() => {
              const styleId = editingProfile.nameStyle?.id || 'plain'
              const preset = NAME_STYLES.find((s) => s.id === styleId) || NAME_STYLES[0]
              const ns = editingProfile.nameStyle || {}
              const dirty = ns.color || ns.from || ns.to
              if (preset.kind === 'flashy') {
                return <div className="profile-hint">Rainbow cycles through colors on its own.</div>
              }
              return (
                <div className="profile-edit-row">
                  {preset.kind === 'gradient' ? (
                    <>
                      <label className="profile-inline-label">From
                        <input type="color" value={ns.from || preset.from || '#2bc3ff'} onChange={(e) => updateNameStyle({ from: e.target.value })} aria-label="Gradient start color" />
                      </label>
                      <label className="profile-inline-label">To
                        <input type="color" value={ns.to || preset.to || '#a855f7'} onChange={(e) => updateNameStyle({ to: e.target.value })} aria-label="Gradient end color" />
                      </label>
                    </>
                  ) : (
                    <label className="profile-inline-label">Color
                      <input type="color" value={ns.color || preset.color || editingSettings?.fontColor || '#edf6ff'} onChange={(e) => updateNameStyle({ color: e.target.value })} aria-label="Username color" />
                    </label>
                  )}
                  {dirty && (
                    <button type="button" className="profile-link-btn" onClick={() => updateNameStyle({ color: '', from: '', to: '' })}>Reset color</button>
                  )}
                </div>
              )
            })()}
            </div>
            )}

            {/* Status message + bio. Collapsed by default: only what's filled in is shown, so the
                panel stays quiet until the user chooses to edit. */}
            <div className="settings-section-head">
              <h3 className="profile-settings-section-title">About</h3>
              <button type="button" className="settings-edit-btn" onClick={() => setEditAboutOpen((v) => !v)} aria-expanded={editAboutOpen}>
                {editAboutOpen ? 'Done' : 'Edit'}
              </button>
            </div>
            {editAboutOpen ? (
              <>
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
              </>
            ) : (
              (editingProfile.statusMessage || editingProfile.bio) ? (
                <div className="settings-readback">
                  {editingProfile.statusMessage && <div className="settings-readback-status">{editingProfile.statusMessage}</div>}
                  {editingProfile.bio && <div className="settings-readback-bio">{editingProfile.bio}</div>}
                </div>
              ) : (
                <div className="profile-hint">Nothing added yet.</div>
              )
            )}

            {/* Tags. The selected tags are visible on the profile preview at the top of this panel,
                so they aren't echoed again here — only the selectable options are shown. */}
            <div className="settings-section-head">
              <h3 className="profile-settings-section-title">Clan / Server Tags</h3>
              <button type="button" className="settings-edit-btn" onClick={() => setAddTagOpen((v) => !v)} aria-expanded={addTagOpen}>
                {addTagOpen ? 'Done' : 'Add'}
              </button>
            </div>
            <p className="profile-hint">Tags can be previewed in the user profile on the top.</p>
            <div className="profile-chip-row">
              <button type="button" className={`profile-chip${(editingProfile.tags || []).some((t) => t.type === 'server' && t.label === serverName) ? ' active' : ''}`} onClick={() => toggleServerTag(serverName)}>{serverName}</button>
              {/* Custom tags stay selectable/removable here so they aren't stranded once the input is
                  collapsed. */}
              {(editingProfile.tags || []).filter((t) => t.type === 'custom').map((t) => (
                <button key={`custom-${t.label}`} type="button" className="profile-chip active" onClick={() => removeTag(t)} title={`Remove ${t.label}`}>
                  {t.label} ×
                </button>
              ))}
            </div>
            {addTagOpen && (
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
            )}

            {/* Microphone — check the mic works without having to join a call first. */}
            <h3 className="profile-settings-section-title">🎙️ Microphone</h3>
            <p className="profile-hint">Check your mic is heard, and hear yourself back before you join a call.</p>
            <MicTest
              devices={audioInputs}
              selectedDeviceId={selectedMicId}
              onSelectDevice={(id) => { setSelectedMicId(id); loadAudioDevices() }}
            />

            {/* Desktop notifications */}
            <h3 className="profile-settings-section-title">🔔 Notifications</h3>
            <div className="notify-setting">
              <button
                type="button"
                role="switch"
                aria-checked={notifyEnabled}
                className={`notify-toggle ${notifyEnabled ? 'on' : ''}`}
                onClick={toggleNotifications}
              >
                <span className="notify-knob" aria-hidden="true" />
              </button>
              <div className="notify-setting-text">
                <span className="notify-setting-title">Desktop notifications</span>
                <span className="notify-setting-hint">{pushSupported() ? 'Receive Message notifications, even when LAN Party is closed.' : 'Receive Message notifications.'}</span>
              </div>
            </div>

            {/* Account info */}
            <h3 className="profile-settings-section-title">Account</h3>
            <div className="profile-settings-fields">
              <div className="profile-settings-field">
                <span className="profile-settings-label">Username</span>
                {showProfileEditor ? (
                  <span className="username-edit-row">
                    <input
                      className="profile-text-input username-edit-input"
                      value={editUsername}
                      maxLength={20}
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(e) => setEditUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); changeUsername() } }}
                    />
                    <button
                      type="button"
                      className="username-change-btn"
                      disabled={usernameSaving || !editUsername.trim() || editUsername.trim() === name}
                      onClick={changeUsername}
                    >
                      {usernameSaving ? 'Saving…' : 'Change'}
                    </button>
                  </span>
                ) : (
                  <span className="profile-settings-value">{name || 'Guest'}</span>
                )}
              </div>
              <div className="profile-settings-field"><span className="profile-settings-label">Email</span><span className="profile-settings-value">{userEmail || '—'}</span></div>
            </div>

            {isAuthenticated && (
              <>
                {/* The heading sits INSIDE the danger zone so it lands below that div's border-top —
                    the divider should separate the account details from this section, not sit under
                    its heading. */}
                <div className="profile-danger-zone">
                  <h3 className="profile-settings-section-title profile-danger-title">Account Removal</h3>
                  <button type="button" className="profile-deactivate-btn" onClick={requestDeactivate}>Delete Account</button>
                  <span className="profile-danger-hint">Permanently deletes your account &amp; data. We email a confirmation link first.</span>
                </div>
              </>
            )}

            <div className="profile-settings-actions">
              {isAuthenticated && (
                <button type="button" className="profile-settings-signout" onClick={() => { setShowSettingsPanel(false); setShowSignOutConfirm(true) }}>Sign out</button>
              )}
              {/* Hidden while the floating unsaved-changes bar is up so there's only one Save/Cancel pair. */}
              {!profileDirty && (
                <div className="profile-settings-actions-right">
                  {showProfileEditor && (
                    <button type="button" className="profile-cancel-btn" onClick={cancelProfileEdit}>Cancel</button>
                  )}
                  <button type="button" className="connect-btn profile-save-btn" onClick={saveProfile}>Save Profile</button>
                </div>
              )}
            </div>
          </section>
          )}

          {settingsTab === 'appearance' && (
          <>
          <section className="profile-settings-section">
            <h3 className="profile-settings-section-title">Color Scheme</h3>
            <div className="scheme-grid">
              {COLOR_SCHEMES.map((scheme) => {
                const active = matchSchemeId(editingSettings || userSettings) === scheme.id
                const { railColor, headerColor, panelColor, sidebarColor, accentStart, accentEnd, leftTileColor } = scheme.colors
                return (
                  <button
                    key={scheme.id}
                    type="button"
                    className={`scheme-card${active ? ' active' : ''}`}
                    onClick={() => selectScheme(scheme)}
                    aria-pressed={active}
                  >
                    <div className="scheme-preview" aria-hidden="true">
                      <div className="scheme-preview-rail" style={{ backgroundColor: railColor }} />
                      <div className="scheme-preview-main" style={{ backgroundColor: sidebarColor }}>
                        <div className="scheme-preview-header" style={{ backgroundColor: headerColor }} />
                        <div className="scheme-preview-panel" style={{ backgroundColor: panelColor }}>
                          <div className="scheme-preview-tile" style={{ backgroundColor: leftTileColor }} />
                          <div
                            className="scheme-preview-accent"
                            style={{ backgroundImage: `linear-gradient(90deg, ${accentStart}, ${accentEnd})` }}
                          />
                        </div>
                      </div>
                    </div>
                    <span className="scheme-name">{scheme.name}{active ? ' ✓' : ''}</span>
                  </button>
                )
              })}
            </div>
          </section>
          <section className="profile-settings-section" data-no-uitap>
            <h3 className="profile-settings-section-title">Sounds</h3>
            <p className="profile-settings-note">Play short sound effects for actions — clicks, sending &amp; receiving messages, joining a call, mute. Only affects you.</p>
            <div className="sound-settings-row">
              <button
                type="button"
                className={`sound-toggle${uiSoundsEnabled ? ' on' : ''}`}
                onClick={toggleUiSounds}
                role="switch"
                aria-checked={uiSoundsEnabled}
              >
                <span className="sound-toggle-track"><span className="sound-toggle-knob" /></span>
                <span className="sound-toggle-label">{uiSoundsEnabled ? 'Sound effects on' : 'Sound effects off'}</span>
              </button>
            </div>
            <div className={`sound-settings-row${uiSoundsEnabled ? '' : ' disabled'}`}>
              <label className="app-field-label" htmlFor="ui-sound-volume">Volume</label>
              <input
                id="ui-sound-volume"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={uiSoundVolume}
                disabled={!uiSoundsEnabled}
                onChange={(e) => changeUiSoundVolume(parseFloat(e.target.value))}
                className="sound-volume-slider"
                aria-label="Sound effects volume"
              />
              <span className="sound-volume-value">{Math.round(uiSoundVolume * 100)}%</span>
            </div>
          </section>
          </>
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
            <h3 className="profile-settings-section-title" style={{ marginTop: 24 }}>Quick Reactions</h3>
            <p className="profile-settings-note">These emojis appear when you hover a message. Click one to swap it for a different emoji.</p>
            <div className="quick-reactions-row">
              {quickReactions.map((emoji, index) => (
                <button
                  key={`${emoji}-${index}`}
                  type="button"
                  className={`quick-reaction-slot${editingQuickReaction?.index === index ? ' editing' : ''}`}
                  onMouseDown={(e) => e.stopPropagation() /* keep the picker's outside-mousedown close from firing before this toggle */}
                  onClick={(e) => { editingQuickReaction?.index === index ? setEditingQuickReaction(null) : openQuickReactionEditor(index, e) }}
                  title="Click to change"
                  aria-label={`Change quick reaction ${index + 1} (currently ${emoji})`}
                >
                  {emoji}
                </button>
              ))}
              <button type="button" className="quick-reactions-reset" onClick={resetQuickReactions} disabled={quickReactions.join() === MESSAGE_REACTIONS.join()}>
                Reset to defaults
              </button>
            </div>
            {editingQuickReaction && (
              <ReactionPicker
                pos={editingQuickReaction}
                skinTones={emojiSkinTones}
                onPick={(emoji) => { setQuickReactionAt(editingQuickReaction.index, emoji); setEditingQuickReaction(null) }}
                onClose={() => setEditingQuickReaction(null)}
              />
            )}
          </section>
          )}
          {settingsTab === 'feedback' && (
          <section className="profile-settings-section">
            <h3 className="profile-settings-section-title">Send Feedback</h3>
            <p className="profile-settings-note">Share feedback, request a feature, or report a bug — it goes straight to our tracker.</p>
            {feedbackResult?.ok ? (
              <div className="feedback-success">
                <div className="feedback-success-icon" aria-hidden="true">✓</div>
                <p className="feedback-success-msg">{feedbackResult.message}</p>
                <div className="feedback-actions">
                  <button className="feedback-btn ghost" onClick={() => setFeedbackResult(null)}>Send another</button>
                  <button className="feedback-btn primary" onClick={() => setShowSettingsPanel(false)}>Done</button>
                </div>
              </div>
            ) : (
              <>
                <div className="feedback-types" role="radiogroup" aria-label="Type">
                  {[{ id: 'feedback', label: 'Feedback', icon: '💬' }, { id: 'request', label: 'Feature request', icon: '✨' }, { id: 'bug', label: 'Bug report', icon: '🐞' }].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={feedbackType === t.id}
                      className={`feedback-type-btn${feedbackType === t.id ? ' active' : ''}`}
                      onClick={() => setFeedbackType(t.id)}
                    >
                      <span aria-hidden="true">{t.icon}</span> {t.label}
                    </button>
                  ))}
                </div>
                <label className="feedback-label" htmlFor="feedback-subject">Subject <span className="feedback-optional">(optional)</span></label>
                <input
                  id="feedback-subject"
                  className="feedback-input"
                  type="text"
                  maxLength={160}
                  placeholder={feedbackType === 'bug' ? 'e.g. Save button does nothing on mobile' : 'Short summary'}
                  value={feedbackTitle}
                  onChange={(e) => setFeedbackTitle(e.target.value)}
                />
                <label className="feedback-label" htmlFor="feedback-message">{feedbackType === 'bug' ? 'What happened?' : 'Your message'}</label>
                <textarea
                  id="feedback-message"
                  className="feedback-textarea"
                  rows={5}
                  maxLength={8000}
                  placeholder={feedbackType === 'bug' ? 'Describe the bug, and the steps to reproduce it…' : feedbackType === 'request' ? 'Describe the feature you’d like to see…' : 'Tell us what you think…'}
                  value={feedbackMessage}
                  onChange={(e) => setFeedbackMessage(e.target.value)}
                />
                <div className="feedback-attach-row">
                  {feedbackPreview ? (
                    <div className="feedback-thumb">
                      <img src={feedbackPreview} alt="Screenshot preview" />
                      <button type="button" className="feedback-thumb-remove" aria-label="Remove screenshot" onClick={() => { setFeedbackFile(null); if (feedbackFileInputRef.current) feedbackFileInputRef.current.value = '' }}>✕</button>
                    </div>
                  ) : (
                    <button type="button" className="feedback-attach-btn" onClick={() => feedbackFileInputRef.current?.click()}>
                      📎 Attach screenshot
                    </button>
                  )}
                  <input
                    ref={feedbackFileInputRef}
                    type="file"
                    accept="image/*"
                    className="file-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f && f.size > 15 * 1024 * 1024) { setFeedbackResult({ ok: false, message: 'Screenshot must be under 15 MB.' }); if (e.target) e.target.value = ''; return }
                      setFeedbackFile(f || null)
                    }}
                  />
                </div>
                <p className="feedback-note">We’ll include your username and basic device info (browser/OS) to help us investigate.</p>
                {feedbackResult && !feedbackResult.ok && <p className="feedback-error">{feedbackResult.message}</p>}
                <div className="feedback-actions">
                  <button className="feedback-btn primary" onClick={submitFeedback} disabled={feedbackSubmitting || !feedbackMessage.trim()}>
                    {feedbackSubmitting ? 'Sending…' : 'Submit'}
                  </button>
                </div>
              </>
            )}
          </section>
          )}
        </div>
        {/* Floating Save/Cancel bar: pinned below the scrollable body whenever the profile draft
            has unsaved changes, so saving never requires scrolling to the bottom of the form. */}
        {settingsTab === 'profile' && profileDirty && (
          <div className="profile-unsaved-bar" role="region" aria-label="Unsaved changes">
            <span className="profile-unsaved-text">You have unsaved changes</span>
            <div className="profile-unsaved-actions">
              <button type="button" className="profile-cancel-btn" onClick={cancelProfileEdit}>Cancel</button>
              <button type="button" className="connect-btn profile-save-btn" onClick={saveProfile}>Save Profile</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
