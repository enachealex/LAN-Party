import React, { useEffect, useRef, useState } from 'react'
import AppDeveloperTab from './AppDeveloperTab'
import AppReviewTab from './AppReviewTab'
import AppDirectoryDialog from './AppDirectoryDialog'
import { safeLinkUrl, statusOf } from './AppDirectoryParts'

// Centered modal for community apps. An app is either a LINK (opens an external URL in a new tab)
// or an uploaded BUNDLE (a self-contained .html/.zip that LAN Party hosts + runs sandboxed inside
// the in-app viewer). Three tabs:
//   Browse    — the published apps, for everyone;
//   Developer — the SDK essentials, the upload form and the viewer's own apps in any status;
//   Review    — only for an instance owner: what is waiting for approval, and what is published.
//
// `apps` is the list exactly as GET /apps answered it for this viewer, and every change goes
// through `request`, which replaces that list with the one in the server's answer. Nothing here
// edits the list itself: what is on screen after an action is what the server says is true.
// `instanceOwner` only decides whether the Review tab is DRAWN; the server decides, per request,
// whether the person asking may do any of it.
export default function AppDirectoryModal({ open, apps = [], instanceOwner = false, onClose, onOpenApp, onRefresh, request, uploadIcon, me, currentUser = '', resolveSrc = (u) => u }) {
  const [mode, setMode] = useState('browse') // 'browse' | 'developer' | 'review'
  const [dialog, setDialog] = useState(null) // { kind, app, file? }
  const [dialogBusy, setDialogBusy] = useState(false)
  const [busyKey, setBusyKey] = useState(null) // `<app id>:<action>` of the request in flight
  const [actionError, setActionError] = useState(null)
  // Set when this modal hands an app to the viewer (which closes the directory): the directory
  // comes back on the tab the person was working in, not on Browse.
  const resumeModeRef = useRef(null)
  // The url each bundle had when this person last opened it from here. Approving sends it, so the
  // server can refuse when the uploader has swapped the files since (server/routes/library.js).
  const [openedUrls, setOpenedUrls] = useState({})

  // Reset to browse view each time the modal opens — except when coming back from the viewer.
  useEffect(() => {
    if (!open) return
    setMode(resumeModeRef.current || 'browse')
    resumeModeRef.current = null
    setDialog(null)
    setDialogBusy(false)
    setActionError(null)
  }, [open])

  // Someone who stops being an instance owner while looking at the Review tab is not left on a
  // tab that no longer exists.
  useEffect(() => { if (mode === 'review' && !instanceOwner) setMode('browse') }, [mode, instanceOwner])

  // A dialog about an app that has just gone from the list (deleted from another window, or by an
  // instance owner) has nothing left to act on.
  const dialogAppListed = !dialog || apps.some((a) => a.id === dialog.app.id)
  useEffect(() => {
    if (dialogAppListed || dialogBusy || !dialog) return
    // Said on the tab, because the dialog is about to go: without it an upload dialog (or the
    // error it had just been given) simply vanished along with the app.
    if (dialog.kind !== 'delete') setActionError(`“${dialog.app.name}” is no longer in the directory — it was deleted while this was open, so nothing was changed.`)
    setDialog(null)
  }, [dialogAppListed, dialogBusy, dialog])

  useEffect(() => {
    if (!open) return undefined
    // Escape backs out one layer at a time, and never out from under a request in flight.
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (dialog) { if (!dialogBusy) setDialog(null) } else onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, dialog, dialogBusy])

  const openApp = (app) => {
    resumeModeRef.current = mode
    if (app.embeddable && app.url) setOpenedUrls((prev) => ({ ...prev, [app.id]: app.url }))
    onOpenApp?.(app)
  }
  // Someone else's bundle that was opened from here and has different files now: what was looked
  // at is not what an approval would publish. (Their own app they replaced themselves.)
  const replacedSinceOpened = (app) => !!app.embeddable && app.createdBy !== currentUser && !!openedUrls[app.id] && openedUrls[app.id] !== app.url

  // The one-click status changes (submit, withdraw, approve). The row's buttons are disabled while
  // one is in flight; a refusal is shown, and the list is fetched again because a refusal usually
  // means it was out of date (someone else got there first).
  const runAction = async (app, action) => {
    if (busyKey) return
    setBusyKey(`${app.id}:${action}`)
    setActionError(null)
    try {
      // An approval names the files it is for: the ones this person opened, else the ones listed.
      const json = action === 'approve' ? { url: replacedSinceOpened(app) ? openedUrls[app.id] : app.url } : {}
      await request(`/apps/${app.id}/${action}`, { method: 'POST', json })
    } catch (err) {
      setActionError(`${app.name}: ${err?.message || 'that did not work'}`)
      onRefresh?.()
    } finally {
      setBusyKey(null)
    }
  }
  const openDialog = (kind, app, file) => { setActionError(null); setDialog({ kind, app, file }) }

  const published = apps.filter((a) => statusOf(a) === 'published')
  const mine = currentUser ? apps.filter((a) => a.createdBy === currentUser) : []
  const pendingCount = instanceOwner ? apps.filter((a) => statusOf(a) === 'pending').length : 0
  const tab = (id, label, extra = null) => (
    <button type="button" role="tab" aria-selected={mode === id} className={`app-dir-tab${mode === id ? ' active' : ''}`} onClick={() => { setMode(id); setActionError(null) }}>{label}{extra}</button>
  )

  return (
    <>
      <div className={`auth-overlay ${open ? 'open' : ''}`} onClick={() => { if (!dialogBusy) onClose?.() }} />
      <div className={`auth-modal app-directory-modal ${open ? 'open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!open} onClick={(e) => e.stopPropagation()}>
        <div className="app-dir-header">
          <h2>App Directory</h2>
          <button type="button" className="members-close app-dir-close" onClick={onClose} disabled={dialogBusy} aria-label="Close">✕</button>
        </div>
        <div className="app-dir-tabs" role="tablist">
          {tab('browse', 'Browse')}
          {tab('developer', 'Developer')}
          {instanceOwner && tab('review', 'Review', pendingCount > 0 && <span className="app-dir-tab-badge" title={`${pendingCount} waiting for review`}>{pendingCount > 99 ? '99+' : pendingCount}</span>)}
        </div>

        <div className="app-dir-body">
          {actionError && mode !== 'browse' && <div className="composer-error" role="alert">{actionError}</div>}
          {mode === 'browse' && (
            published.length === 0 ? (
              <div className="app-dir-empty">No published apps yet. Upload one in the Developer tab.</div>
            ) : (
              <div className="app-dir-grid">
                {published.map((app) => {
                  const link = safeLinkUrl(app.url)
                  return (
                    <div className="app-card" key={app.id}>
                      <div className="app-card-icon">
                        {app.iconUrl ? <img src={resolveSrc(app.iconUrl)} alt="" /> : <span>{(app.name || '?').slice(0, 1).toUpperCase()}</span>}
                      </div>
                      <div className="app-card-meta">
                        <div className="app-card-name">
                          {app.name}
                          {app.embeddable && <span className="app-card-badge" title="Runs inside LAN Party">embedded</span>}
                        </div>
                        {app.description && <div className="app-card-desc">{app.description}</div>}
                        <div className="app-card-foot">
                          <span className="app-card-by">by {app.createdBy || 'someone'}</span>
                          {app.embeddable ? (
                            <button type="button" className="app-card-try" onClick={() => openApp(app)}>Open →</button>
                          ) : (
                            link
                              ? <a className="app-card-try" href={link} target="_blank" rel="noreferrer noopener">Try it →</a>
                              // Not a web address, so never a link: shown as the text it is.
                              : app.url && <span className="app-card-address" title="Not a web address, so it cannot be opened from here">{app.url}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}
          {/* Mounted only while it is the tab shown: leaving the Developer tab (or closing the
              directory, which it is told about through `open`) is what stops a running "Check app". */}
          {mode === 'developer' && (
            <AppDeveloperTab
              open={open}
              apps={mine}
              instanceOwner={instanceOwner}
              me={me}
              busyKey={busyKey}
              resolveSrc={resolveSrc}
              request={request}
              uploadIcon={uploadIcon}
              onOpenApp={openApp}
              onAction={runAction}
              onDialog={openDialog}
            />
          )}
          {mode === 'review' && instanceOwner && (
            <AppReviewTab apps={apps} busyKey={busyKey} resolveSrc={resolveSrc} replacedSinceOpened={replacedSinceOpened} onOpenApp={openApp} onAction={runAction} onDialog={openDialog} />
          )}
        </div>

        {open && dialog && (
          <AppDirectoryDialog
            key={`${dialog.kind}:${dialog.app.id}`}
            dialog={dialog}
            instanceOwner={instanceOwner}
            currentUser={currentUser}
            resolveSrc={resolveSrc}
            request={request}
            uploadIcon={uploadIcon}
            onClose={() => { setDialog(null); setDialogBusy(false) }}
            onFailed={() => onRefresh?.()}
            onBusyChange={setDialogBusy}
          />
        )}
      </div>
    </>
  )
}
