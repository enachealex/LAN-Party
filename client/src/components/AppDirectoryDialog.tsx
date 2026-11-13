// The App Directory's own confirm / edit dialog, drawn inside the directory modal with the in-app
// prompt's look. Not window.confirm or window.prompt: the desktop shell does not support native
// prompts, and the shared prompt modal sits underneath this one.
import { useEffect, useRef, useState } from 'react'
import { AppIcon, REVIEW_NOTE_MAX, hostedUrlProblem, isBundleApp, safeLinkUrl, type AppDialogKind, type AppsRequest, type DirectoryApp } from './AppDirectoryParts'

export interface AppDialogState { kind: AppDialogKind; app: DirectoryApp; file?: File }

interface AppDirectoryDialogProps {
  dialog: AppDialogState
  instanceOwner: boolean
  currentUser: string
  resolveSrc: (url: string) => string
  request: AppsRequest
  uploadIcon: (file: File) => Promise<string>
  /** Close without doing anything, or after it worked. */
  onClose: () => void
  /** The request was refused. The list may be out of date, so the directory fetches it again. */
  onFailed: () => void
  /** Told while a request is in flight, so the directory does not close under an upload. */
  onBusyChange: (busy: boolean) => void
}

export default function AppDirectoryDialog({ dialog, instanceOwner, currentUser, resolveSrc, request, uploadIcon, onClose, onFailed, onBusyChange }: AppDirectoryDialogProps) {
  const { kind, app, file } = dialog
  const mine = !!currentUser && app.createdBy === currentUser
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [name, setName] = useState(app.name || '')
  const [description, setDescription] = useState(app.description || '')
  // A link app's address, and whether it runs inside LAN Party. Unlike the fields above these are
  // what a reviewer approved, so changing either is not a details edit (see the note in the form).
  const isLink = !isBundleApp(app)
  const [url, setUrl] = useState(app.url || '')
  const [embed, setEmbed] = useState(app.hosted === true)
  const urlChanged = isLink && url.trim() !== (app.url || '')
  const embedChanged = isLink && embed !== (app.hosted === true)
  // undefined = leave the icon alone, null = remove it, a File = replace it.
  const [iconChange, setIconChange] = useState<File | null | undefined>(undefined)
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  useEffect(() => {
    if (!(iconChange instanceof File)) { setIconPreview(null); return undefined }
    const u = URL.createObjectURL(iconChange)
    setIconPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [iconChange])

  const confirm = async () => {
    if (busy) return
    const base = `/apps/${app.id}`
    setBusy(true)
    onBusyChange(true)
    setError('')
    try {
      if (kind === 'delete') await request(base, { method: 'DELETE' })
      else if (kind === 'unpublish') await request(`${base}/unpublish`, { method: 'POST', json: {} })
      else if (kind === 'reject') await request(`${base}/reject`, { method: 'POST', json: { note: note.trim() } })
      else if (kind === 'replace') {
        if (!file) throw new Error('Choose a .html file or a .zip bundle.')
        const fd = new FormData()
        fd.append('bundle', file)
        await request(`${base}/bundle`, { method: 'PUT', form: fd })
      } else {
        if (!name.trim()) throw new Error('App name is required.')
        // Only what changed is sent; the server refuses an edit that changes nothing.
        const changes: Record<string, string | boolean> = {}
        if (name.trim() !== (app.name || '')) changes.name = name.trim()
        if (description.trim() !== (app.description || '')) changes.description = description.trim()
        if (urlChanged || embedChanged) {
          // Asked here first so a typo is caught before anything is sent; the server asks again.
          // Only when one of the two is being changed: an old link whose address was never a web
          // address can still be renamed without being made to fix it first.
          if (!safeLinkUrl(url)) throw new Error('Enter the full web address, starting with http:// or https://.')
          const problem = embed ? hostedUrlProblem(url, [resolveSrc('/')]) : ''
          if (problem) throw new Error(problem)
          if (urlChanged) changes.url = url.trim()
          if (embedChanged) changes.embed = embed
        }
        if (iconChange === null && app.iconUrl) changes.iconUrl = ''
        else if (iconChange instanceof File) changes.iconUrl = await uploadIcon(iconChange)
        if (Object.keys(changes).length > 0) await request(base, { method: 'PATCH', json: changes })
      }
      onBusyChange(false)
      onClose()
    } catch (err) {
      onBusyChange(false)
      onFailed()
      if (aliveRef.current) { setBusy(false); setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.') }
    }
  }

  const title = kind === 'delete' ? `Delete “${app.name}”?`
    : kind === 'unpublish' ? `Unpublish “${app.name}”?`
      : kind === 'reject' ? `Reject “${app.name}”?`
        : kind === 'replace' ? `Replace the bundle of “${app.name}”?`
          : 'Edit app details'
  const confirmLabel = kind === 'delete' ? 'Delete' : kind === 'unpublish' ? 'Unpublish' : kind === 'reject' ? 'Reject' : kind === 'replace' ? 'Replace bundle' : 'Save'
  const busyLabel = kind === 'replace' ? 'Uploading…' : 'Working…'
  const shownIcon: DirectoryApp = iconChange === null ? { ...app, iconUrl: '' } : app

  return (
    <div className="app-dir-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dir-dialog-title" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="prompt-card">
        <div id="app-dir-dialog-title" className="prompt-title">{title}</div>

        {kind === 'delete' && (
          <p className="app-dir-dialog-text">
            {mine ? 'The app' : `${app.createdBy || 'Someone'}’s app`} is removed from the directory{isBundleApp(app) ? ' and its files are deleted' : ''}. If it is running in a voice room, it ends there. This cannot be undone.
          </p>
        )}
        {kind === 'unpublish' && (
          <p className="app-dir-dialog-text">
            It goes back to being a draft: it leaves the directory for everyone but {mine ? 'you' : `its uploader${app.createdBy ? `, ${app.createdBy},` : ''} and instance owners`}, and any voice room running it is ended.
            {mine && !instanceOwner ? ' To publish it again it has to be approved again.' : ''}
          </p>
        )}
        {kind === 'replace' && (
          <p className="app-dir-dialog-text">
            <b>{file?.name}</b> takes the place of the files being served now, which are deleted. Any voice room running the app is ended.{' '}
            {instanceOwner
              ? 'You run this instance, so the app keeps its current status.'
              : app.status === 'draft'
                ? 'The app stays a draft.'
                : 'The app goes back to Draft, because what was reviewed is no longer what would run — submit it for review again when it is ready.'}
          </p>
        )}
        {kind === 'reject' && (
          <>
            <p className="app-dir-dialog-text">
              {app.status === 'published' ? 'It leaves the directory, and any voice room running it is ended. ' : ''}
              {app.createdBy || 'The uploader'} is told it was sent back, and can change it and submit it again.
            </p>
            <label className="prompt-label" htmlFor="app-reject-note">Note to the uploader (optional)</label>
            <textarea id="app-reject-note" className="prompt-input app-dir-dialog-area" rows={4} maxLength={REVIEW_NOTE_MAX} autoFocus placeholder="What needs to change?" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="app-dir-dialog-count">{note.length} / {REVIEW_NOTE_MAX}</div>
          </>
        )}
        {kind === 'edit' && (
          <>
            <div className="app-dir-dialog-icon">
              {iconPreview ? <div className="app-card-icon"><img src={iconPreview} alt="New icon preview" /></div> : <AppIcon app={shownIcon} resolveSrc={resolveSrc} />}
              <button type="button" className="app-row-btn" onClick={() => iconInputRef.current?.click()} disabled={busy}>Change icon</button>
              {(iconChange instanceof File || (iconChange === undefined && !!app.iconUrl)) && <button type="button" className="app-row-btn" onClick={() => setIconChange(app.iconUrl ? null : undefined)} disabled={busy}>Remove icon</button>}
              <input ref={iconInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) setIconChange(f); e.target.value = '' }} />
            </div>
            <label className="prompt-label" htmlFor="app-edit-name">App name</label>
            <input id="app-edit-name" className="prompt-input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <label className="prompt-label app-dir-dialog-gap" htmlFor="app-edit-desc">Description</label>
            <textarea id="app-edit-desc" className="prompt-input app-dir-dialog-area" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            <p className="app-dir-dialog-text app-dir-dialog-fine">Changing these does not change the app’s status.</p>
            {isLink && (
              <>
                <label className="prompt-label app-dir-dialog-gap" htmlFor="app-edit-url">Address</label>
                <input id="app-edit-url" className="prompt-input" type="url" inputMode="url" maxLength={2000} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
                <label className="app-embed-toggle app-dir-dialog-gap">
                  <input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} disabled={busy} />
                  <span>Run inside LAN Party</span>
                </label>
                <p className="app-dir-dialog-text app-dir-dialog-fine">
                  {embed
                    ? 'The site is shown in a frame, on its own or as a Thing To Do in a voice room. It needs an https:// address that is not this LAN Party’s own, must allow being framed by this LAN Party, and can use the SDK to learn who is looking and which room it is in.'
                    : 'Off: the link opens in a new browser tab.'}
                </p>
                {/* Said before Save, and only when it is about to happen: this is what was reviewed. */}
                <p className={`app-dir-dialog-text app-dir-dialog-fine${urlChanged || embedChanged ? ' app-dir-dialog-warn' : ''}`}>
                  Changing the address, or whether it runs inside LAN Party, changes what was reviewed. Any voice room running the app is ended, and{' '}
                  {instanceOwner
                    ? 'because you run this instance the app keeps its current status.'
                    : app.status === 'draft'
                      ? 'the app stays a draft.'
                      : 'the app goes back to Draft — submit it for review again when it is ready.'}
                </p>
              </>
            )}
          </>
        )}

        {error && <div className="composer-error" role="alert">{error}</div>}
        <div className="prompt-actions">
          <button type="button" className="prompt-btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`prompt-btn ${kind === 'delete' || kind === 'reject' ? 'danger' : 'primary'}`} onClick={confirm} disabled={busy || (kind === 'edit' && !name.trim())}>{busy ? busyLabel : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
