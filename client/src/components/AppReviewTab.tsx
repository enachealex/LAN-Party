// The App Directory's Review tab, shown only to an instance owner: what is waiting for a decision,
// what is already published, and the rest. Showing it grants nothing — the server checks who is
// asking on every one of these actions.
import {
  AppIcon, OpenAppControl, RowButton, StatusChip, formatWhen, isBundleApp, runsInside, safeLinkUrl, statusOf,
  type AppDialogKind, type DirectoryApp,
} from './AppDirectoryParts'

interface ReviewTabProps {
  /** Every app on the instance (an instance owner is listed all of them), newest first. */
  apps: DirectoryApp[]
  busyKey: string | null
  resolveSrc: (url: string) => string
  /** The uploader changed this app after the reviewer opened it — replaced the bundle, or edited a
   *  link's address or whether it runs inside LAN Party: it is not what was seen. */
  changedSinceOpened: (app: DirectoryApp) => boolean
  onOpenApp: (app: DirectoryApp) => void
  onAction: (app: DirectoryApp, action: 'approve') => void
  onDialog: (kind: AppDialogKind, app: DirectoryApp) => void
}

export default function AppReviewTab({ apps, busyKey, resolveSrc, changedSinceOpened, onOpenApp, onAction, onDialog }: ReviewTabProps) {
  // Longest-waiting first: the queue is worked from the top.
  const pending = apps.filter((a) => statusOf(a) === 'pending').sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0))
  const published = apps.filter((a) => statusOf(a) === 'published')
  const others = apps.filter((a) => statusOf(a) === 'draft' || statusOf(a) === 'rejected')

  const row = (app: DirectoryApp) => {
    const status = statusOf(app)
    const busy = !!busyKey && busyKey.startsWith(`${app.id}:`)
    const link = safeLinkUrl(app.url)
    const bundle = isBundleApp(app)
    // The server refuses to publish anything other than what was opened; this says so before the
    // click. An app that can still be opened here has to be opened again first. One that cannot (it
    // was switched to a plain link) has nothing to open: its row is the whole of it, so the change
    // is pointed out and the decision left to the reviewer.
    const changed = status !== 'published' && changedSinceOpened(app)
    const swapped = changed && runsInside(app)
    return (
      <div className="app-row" key={app.id}>
        <AppIcon app={app} resolveSrc={resolveSrc} />
        <div className="app-row-body">
          <div className="app-row-head">
            <span className="app-row-name">{app.name}</span>
            <StatusChip status={status} />
          </div>
          <div className="app-row-status">
            Uploaded by <b>{app.createdBy || 'someone'}</b>
            {status === 'pending' && app.submittedAt ? ` · submitted ${formatWhen(app.submittedAt)}` : ''}
            {status !== 'pending' && app.reviewedBy ? ` · last decided by ${app.reviewedBy}${app.reviewedAt ? `, ${formatWhen(app.reviewedAt)}` : ''}` : ''}
          </div>
          <div className="app-row-desc app-row-desc-full">{app.description || <i>No description.</i>}</div>
          {bundle ? (
            <div className="app-row-kindline"><b>Uploaded bundle</b> — hosted by this server, runs in the sandbox.</div>
          ) : app.hosted ? (
            // What is being approved here is an address AND that it is framed. The site stays its
            // owner's: nothing in a review can pin what it serves tomorrow, and the row says so.
            <div className="app-row-kindline">
              <b>Hosted app</b> — a site on its own server that runs inside LAN Party, framed from: <span className="app-row-url">{app.url || '(no address given)'}</span>
              <br />
              It runs as that site, not in the sandbox: it keeps its own storage and talks to its own server, it is told the name and avatar of whoever opens it, and its owner can change what it serves without it coming back here.
            </div>
          ) : (
            // The address in full, as text: what a reviewer approves is where the link goes.
            <div className="app-row-kindline">
              <b>Link</b> — opens outside LAN Party, at: <span className="app-row-url">{app.url || '(no address given)'}</span>
              {app.url && !link && <span className="app-row-warn"> Not a web address; it will not be clickable.</span>}
            </div>
          )}
          {status === 'rejected' && <div className="app-row-note"><b>Note to the uploader:</b> {app.reviewNote || 'none.'}</div>}
          {swapped && <div className="app-row-note" role="status"><b>{bundle ? 'The bundle was replaced after you opened it.' : 'The address of this app was changed after you opened it.'}</b> What you looked at is not what would be published. Open it again before you decide.</div>}
          {changed && !swapped && <div className="app-row-note" role="status"><b>This app was changed after you opened it.</b> It no longer runs inside LAN Party: it is now a plain link to the address above, which is what would be published.</div>}
          <div className="app-row-actions">
            <OpenAppControl app={app} onOpenApp={onOpenApp} label="Open to test" />
            {status !== 'published' && <RowButton tone="primary" onClick={() => onAction(app, 'approve')} disabled={busy || swapped} title={swapped ? 'Open it again first' : undefined}>{status === 'pending' ? 'Approve' : 'Publish'}</RowButton>}
            {status === 'published' && <RowButton onClick={() => onDialog('unpublish', app)} disabled={busy}>Unpublish</RowButton>}
            {(status === 'pending' || status === 'published') && <RowButton tone="danger" onClick={() => onDialog('reject', app)} disabled={busy}>Reject…</RowButton>}
            <RowButton tone="danger" onClick={() => onDialog('delete', app)} disabled={busy}>Delete</RowButton>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-review">
      <h3 className="app-dir-section app-dir-section-first">Waiting for review ({pending.length})</h3>
      {pending.length === 0
        ? <div className="app-dir-empty app-dir-empty-small">Nothing is waiting for review.</div>
        : <div className="app-rows">{pending.map(row)}</div>}

      <h3 className="app-dir-section">Published ({published.length})</h3>
      {published.length === 0
        ? <div className="app-dir-empty app-dir-empty-small">No published apps.</div>
        : <div className="app-rows">{published.map(row)}</div>}

      {others.length > 0 && (
        <>
          <h3 className="app-dir-section">Not submitted ({others.length})</h3>
          <div className="app-dev-hint">Drafts and apps sent back for changes. Their uploaders have not asked for a review; you can still publish one directly.</div>
          <div className="app-rows">{others.map(row)}</div>
        </>
      )}
    </div>
  )
}
