// Small pieces the App Directory's tabs share: the shape of an app as GET /apps returns it, the
// status wording, and the icon / status chip / action button every row is built from.
import type { ReactNode } from 'react'

export type AppStatus = 'draft' | 'pending' | 'published' | 'rejected'

/** One app, as the server lists it for this viewer (server/routes/library.js appView). The review
 *  fields are only present for the app's uploader and for instance owners. */
export interface DirectoryApp {
  id: number
  name: string
  description?: string
  /** A bundle's /app-bundles/<dir>/ path (it changes when the bundle is replaced), or a link's URL. */
  url?: string
  iconUrl?: string
  createdBy?: string
  createdAt?: number
  kind?: 'link' | 'bundle'
  embeddable?: boolean
  status?: AppStatus
  reviewNote?: string
  submittedAt?: number | null
  reviewedAt?: number | null
  reviewedBy?: string | null
}

/** What the tabs call to change something. Resolves with the server's answer once the list on
 *  screen has been replaced by the one in it; rejects with the server's message. */
export type AppsRequest = (path: string, options?: { method?: string; json?: unknown; form?: FormData }) => Promise<{ app?: DirectoryApp | null; apps?: DirectoryApp[] }>

export type AppDialogKind = 'edit' | 'replace' | 'delete' | 'unpublish' | 'reject'

export const MAX_BUNDLE_BYTES = 15 * 1024 * 1024 // must match the server's bundleUpload limit
export const REVIEW_NOTE_MAX = 500 // must match the server's REVIEW_NOTE_MAX

// An app listed by a server from before statuses existed has none, and was visible to everyone.
export const statusOf = (app: DirectoryApp): AppStatus => app.status || 'published'

export const STATUS_LABEL: Record<AppStatus, string> = {
  draft: 'Draft',
  pending: 'In review',
  published: 'Published',
  rejected: 'Changes requested',
}

/** A link app's URL is whatever its uploader typed. It only ever becomes a clickable link when it
 *  is plainly a web address; anything else (javascript:, data:, a bare word) is shown as text. */
export const safeLinkUrl = (url?: string): string => (typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : '')

/** Why a picked file cannot be a bundle, or '' when it can be sent. The server checks again. */
export function bundleFileProblem(file: File): string {
  if (!/\.(html?|zip)$/i.test(file.name)) return 'Choose a .html file or a .zip bundle.'
  if (file.size > MAX_BUNDLE_BYTES) return 'Bundle is larger than 15 MB.'
  return ''
}

export const formatWhen = (ts?: number | null): string => {
  if (!ts) return ''
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return '' }
}

export function AppIcon({ app, resolveSrc }: { app: DirectoryApp; resolveSrc: (url: string) => string }) {
  return (
    <div className="app-card-icon">
      {app.iconUrl ? <img src={resolveSrc(app.iconUrl)} alt="" /> : <span>{(app.name || '?').slice(0, 1).toUpperCase()}</span>}
    </div>
  )
}

export function StatusChip({ status }: { status: AppStatus }) {
  return <span className={`app-status-chip app-status-${status}`}>{STATUS_LABEL[status]}</span>
}

interface RowButtonProps {
  children: ReactNode
  onClick: () => void
  tone?: 'primary' | 'danger'
  disabled?: boolean
  title?: string
}
export function RowButton({ children, onClick, tone, disabled, title }: RowButtonProps) {
  return <button type="button" className={`app-row-btn${tone ? ` ${tone}` : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
}

/** Open an app to look at it: a bundle in the solo viewer, a link in a new tab (when it is one). */
export function OpenAppControl({ app, onOpenApp, label = 'Open' }: { app: DirectoryApp; onOpenApp: (app: DirectoryApp) => void; label?: string }) {
  if (app.embeddable) return <RowButton onClick={() => onOpenApp(app)}>{label}</RowButton>
  const href = safeLinkUrl(app.url)
  if (!href) return null
  return <a className="app-row-btn" href={href} target="_blank" rel="noreferrer noopener">Open link ↗</a>
}
