import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** One hit, as GET /search returns it. Every key is always present; null where it does not apply. */
export interface SearchResult {
  kind: 'channel' | 'dm' | 'group'
  serverId: string | null
  serverName: string | null
  channelId: string | null
  channelName: string | null
  /** The other person's username, for a DM (whoever wrote the message). */
  peer: string | null
  groupId: string | null
  /** '' for a group nobody has named. */
  groupName: string | null
  message: {
    id: number
    author: string
    text: string
    ts: number
    attachment: { name?: string } | null
  }
}

/** The conversation on screen, as search parameters. */
interface SearchHere {
  /** Changes when the conversation does, so the search is run again for the new one. */
  key: string
  label: string
  params: Record<string, string>
}

interface SearchPanelProps {
  open: boolean
  onClose: () => void
  authedFetch: AuthedFetch
  /** null when there is no conversation on screen (Home landing, a voice channel). */
  here: SearchHere | null
  /** The server on screen, if any: adds the "This server" scope. */
  server: { id: string; name: string } | null
  onJump: (result: SearchResult) => void
  formatTime: (ts: number) => string
  /** What the app calls a group the server has no name for. */
  groupLabel: (groupId: string) => string
}

type Scope = 'here' | 'server' | 'all'

interface SearchState {
  status: 'idle' | 'loading' | 'done' | 'error'
  /** The query these results answer. Emphasis is built from this, not from what is being typed. */
  q: string
  results: SearchResult[]
  hasMore: boolean
  nextCursor: string | null
  error: string
  loadingMore: boolean
}

const EMPTY: SearchState = { status: 'idle', q: '', results: [], hasMore: false, nextCursor: null, error: '', loadingMore: false }

const Q_MIN = 2 // mirrors Q_MIN / Q_MAX in server/routes/search.js
const Q_MAX = 100
// Long enough that a word typed at normal speed is one request, not one per letter. The endpoint is
// rate limited per address, so this is also what keeps a fast typist under it.
const DEBOUNCE_MS = 300
const EXCERPT_MAX = 240

// A long message is cut down to the part that matched, so the hit is on screen without opening it.
function excerpt(text: string, q: string): string {
  if (text.length <= EXCERPT_MAX) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  const start = Math.max(0, (at < 0 ? 0 : at) - 80)
  const end = Math.min(text.length, start + EXCERPT_MAX)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

// The text with every occurrence of the query wrapped in <mark>. Built as React nodes, so message
// text is only ever rendered as text: it is somebody else's input and must never be parsed as HTML.
function emphasise(text: string, q: string): ReactNode {
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  // A few characters change length when lowercased, which would put the marks in the wrong place.
  if (!needle || lower.length !== text.length) return text
  const parts: ReactNode[] = []
  let from = 0
  let at = lower.indexOf(needle)
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at} className="search-hit">{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

export default function SearchPanel({ open, onClose, authedFetch, here, server, onJump, formatTime, groupLabel }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('here')
  const [state, setState] = useState<SearchState>(EMPTY)
  const inputRef = useRef<HTMLInputElement>(null)
  // Each search (and each "load more") takes a number; an answer is used only if it is still the
  // latest, so a slow response for an old query can never overwrite a newer one.
  const requestRef = useRef(0)

  // The chosen scope may not exist where the panel is opened next (no conversation on Home, no
  // server in a DM), so the one actually used is the nearest that does.
  const usedScope: Scope = scope === 'here' && !here ? (server ? 'server' : 'all') : scope === 'server' && !server ? 'all' : scope
  const scopeParams: Record<string, string> =
    usedScope === 'here' && here ? here.params
      : usedScope === 'server' && server ? { scope: 'server', serverId: server.id }
        : { scope: 'all' }
  const scopeKey = JSON.stringify(scopeParams)
  const q = query.trim()

  const run = async (text: string, params: Record<string, string>, cursor: string | null, signal?: AbortSignal) => {
    const id = ++requestRef.current
    try {
      const qs = new URLSearchParams({ q: text, ...params, ...(cursor ? { cursor } : {}) })
      const res = await authedFetch(`/search?${qs.toString()}`, { signal })
      const data = await res.json().catch(() => ({}))
      if (requestRef.current !== id) return
      if (!res.ok) {
        // 429 carries the server's own "wait a moment" wording; the rest get theirs too.
        const error = data.error || "Search didn't work. Try again."
        setState((prev) => (cursor ? { ...prev, loadingMore: false, error } : { ...EMPTY, status: 'error', q: text, error }))
        return
      }
      const results: SearchResult[] = Array.isArray(data.results) ? data.results : []
      setState((prev) => ({
        status: 'done',
        q: text,
        results: cursor ? [...prev.results, ...results] : results,
        hasMore: !!data.hasMore,
        nextCursor: data.nextCursor || null,
        error: '',
        loadingMore: false,
      }))
    } catch (err) {
      if (requestRef.current !== id || (err instanceof DOMException && err.name === 'AbortError')) return
      const error = "Couldn't reach the server. Check your connection and try again."
      setState((prev) => (cursor ? { ...prev, loadingMore: false, error } : { ...EMPTY, status: 'error', q: text, error }))
    }
  }

  // Search as you type, once the typing pauses. Also re-runs when the scope changes, or when the
  // panel is reopened (the conversation may have moved on since the results were fetched).
  useEffect(() => {
    if (!open) return undefined
    requestRef.current += 1 // whatever was in flight is for an older query
    if (q.length < Q_MIN) {
      setState(EMPTY)
      return undefined
    }
    setState((prev) => ({ ...prev, status: 'loading', error: '', loadingMore: false }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => { run(q, scopeParams, null, ctrl.signal) }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
    // scopeParams is covered by scopeKey; run only closes over props that do not change the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, scopeKey])

  useEffect(() => {
    if (!open) return undefined
    inputRef.current?.focus()
    inputRef.current?.select()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    // Capture, so Esc closes the panel before anything underneath it reacts to the same key.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const loadMore = () => {
    if (!state.nextCursor || state.loadingMore) return
    setState((prev) => ({ ...prev, loadingMore: true, error: '' }))
    run(state.q, scopeParams, state.nextCursor)
  }

  const where = (r: SearchResult): string => {
    if (r.kind === 'channel') return `#${r.channelName || 'channel'} in ${r.serverName || 'a server'}`
    if (r.kind === 'dm') return `@${r.peer || 'direct message'}`
    return r.groupName || (r.groupId ? groupLabel(r.groupId) : '') || 'Group chat'
  }

  const scopes: { id: Scope; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'here', label: 'This conversation', hint: here ? here.label : 'No conversation open', disabled: !here },
    ...(server ? [{ id: 'server' as const, label: 'This server', hint: server.name }] : []),
    { id: 'all', label: 'Everywhere', hint: 'All your servers, DMs and groups' },
  ]
  const usedHint = scopes.find((s) => s.id === usedScope)?.hint || ''

  return createPortal(
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" role="dialog" aria-label="Search messages" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <svg className="search-head-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5 21 21" />
          </svg>
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            maxLength={Q_MAX}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <button type="button" className="discover-close" onClick={onClose} aria-label="Close search">✕</button>
        </div>

        <div className="search-scopes" role="radiogroup" aria-label="Where to search">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={usedScope === s.id}
              className={`search-scope${usedScope === s.id ? ' active' : ''}`}
              disabled={s.disabled}
              title={s.hint}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="search-scope-hint">{usedHint}</div>

        <div className="search-results" aria-live="polite" aria-busy={state.status === 'loading'}>
          {state.status === 'idle' && (
            <div className="search-empty">
              {q.length === 0 ? 'Search the messages you can see.' : `Type at least ${Q_MIN} characters.`}
            </div>
          )}
          {state.status === 'loading' && state.results.length === 0 && <div className="search-empty">Searching…</div>}
          {state.status === 'error' && <div className="search-empty error" role="alert">{state.error}</div>}
          {state.status === 'done' && state.results.length === 0 && (
            <div className="search-empty">No messages match “{state.q}”.</div>
          )}

          {state.status !== 'error' && state.results.map((r) => (
            <button
              key={`${r.kind}-${r.message.id}`}
              type="button"
              className={`search-result${state.status === 'loading' ? ' stale' : ''}`}
              onClick={() => onJump(r)}
            >
              <span className="search-result-where">{where(r)}</span>
              <span className="search-result-head">
                <span className="search-result-author">{r.message.author}</span>
                <span className="search-result-time">{formatTime(r.message.ts)}</span>
              </span>
              <span className="search-result-text">{emphasise(excerpt(r.message.text || '', state.q), state.q)}</span>
              {r.message.attachment && (
                <span className="search-result-attach">📎 {r.message.attachment.name || 'attachment'}</span>
              )}
            </button>
          ))}

          {state.status === 'done' && state.error && <div className="search-empty error" role="alert">{state.error}</div>}
          {state.status === 'done' && state.hasMore && (
            <button type="button" className="search-more" onClick={loadMore} disabled={state.loadingMore}>
              {state.loadingMore ? 'Loading…' : 'Load more results'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
