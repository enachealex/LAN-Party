// Small pieces the App Directory's tabs share: the shape of an app as GET /apps returns it, the
// status wording, and the icon / status chip / action button every row is built from.
import type { ReactNode } from 'react'
import { hostedAppFrame } from '../appBridge'

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
  /** An uploaded bundle that runs in the opaque sandbox. Only that: a hosted app also runs inside
   *  LAN Party but says so with `hosted`, never with this, because clients from before hosted apps
   *  existed read `embeddable` as "frame it in the bundle sandbox" — where a hosted site is a blank
   *  page. Those clients show a hosted app as a plain link instead. Ask runsInside() or
   *  isBundleApp() rather than reading this directly. */
  embeddable?: boolean
  /** A link app set to run inside LAN Party: a site on its own server, framed on its real origin. */
  hosted?: boolean
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

/** An uploaded bundle: files this server hosts, run in the opaque sandbox. Everything else is a
 *  link app, hosted (runs inside LAN Party) or plain (opens in a new tab). */
export const isBundleApp = (app: DirectoryApp): boolean => app.hosted !== true && !!app.embeddable
/** It can be opened in the viewer and started in a voice room: a hosted app, or a bundle. `hosted`
 *  is asked first; a server from before this split said `embeddable` for both, and `hosted` is what
 *  told them apart then as well. */
export const runsInside = (app: DirectoryApp): boolean => app.hosted === true || !!app.embeddable

/** Why `url` cannot be the address of an app that runs inside LAN Party, or '' when it can. The
 *  same rules the frame itself is held to (hostedAppFrame); the server has the last word. */
export function hostedUrlProblem(url: string, ownAddresses: string[] = []): string {
  const frame = hostedAppFrame(url.trim(), ownAddresses)
  if (frame.ok) return ''
  return frame.problem === 'own-origin'
    ? 'An app cannot run inside LAN Party from LAN Party’s own address. Host it somewhere else, or upload it as a bundle.'
    : 'To run inside LAN Party the address has to be a full https:// one, with no username or password in it.'
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

/** Open an app to look at it: a bundle or a hosted app in the solo viewer, a plain link in a new
 *  tab (when it is one). A hosted app is still a site of its own, so it keeps the new-tab way too. */
export function OpenAppControl({ app, onOpenApp, label = 'Open' }: { app: DirectoryApp; onOpenApp: (app: DirectoryApp) => void; label?: string }) {
  const href = isBundleApp(app) ? '' : safeLinkUrl(app.url)
  return (
    <>
      {runsInside(app) && <RowButton onClick={() => onOpenApp(app)}>{label}</RowButton>}
      {href && <a className="app-row-btn" href={href} target="_blank" rel="noreferrer noopener">{runsInside(app) ? 'Open in new tab ↗' : 'Open link ↗'}</a>}
    </>
  )
}
