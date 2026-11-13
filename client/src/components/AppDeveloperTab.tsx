// The App Directory's Developer tab: what an app needs to talk to LAN Party, the upload form, and
// the viewer's own apps with whatever can be done to each in the status it is in.
import { useEffect, useRef, useState } from 'react'
import type { BridgePerson } from '../appBridge'
import { APP_CHECK_MS, startAppCheck, type AppCheckResult, type AppCheckRun } from '../appCheck'
import {
  AppIcon, OpenAppControl, RowButton, StatusChip, bundleFileProblem, formatWhen, hostedUrlProblem, isBundleApp, runsInside, safeLinkUrl, statusOf,
  type AppDialogKind, type AppsRequest, type DirectoryApp,
} from './AppDirectoryParts'

const SDK_TAG = '<script src="/sdk/lanparty.js"></script>'
// Six lines that do something visible with shared state: a counter everyone in the app sees.
const STARTER = [
  SDK_TAG,
  '<script>LANParty.connect().then(function (lp) {',
  "  function show() { document.body.textContent = 'Hi ' + lp.me.displayName + '. Count: ' + (lp.state.count || 0) + ' (click to add)'; }",
  '  document.onclick = function () { lp.setState({ count: (lp.state.count || 0) + 1 }); };',
  "  lp.on('state', show); show();",
  '});</script>',
].join('\n')

interface CheckEntry { url: string; running: boolean; result: AppCheckResult | null }

interface DeveloperTabProps {
  /** Whether the directory is on screen. A check must not keep running behind a closed modal. */
  open: boolean
  /** The viewer's own apps, newest first. */
  apps: DirectoryApp[]
  instanceOwner: boolean
  me: BridgePerson
  /** `<app id>:<action>` of the request in flight, if any. */
  busyKey: string | null
  resolveSrc: (url: string) => string
  request: AppsRequest
  uploadIcon: (file: File) => Promise<string>
  onOpenApp: (app: DirectoryApp) => void
  onAction: (app: DirectoryApp, action: 'submit' | 'withdraw' | 'approve') => void
  onDialog: (kind: AppDialogKind, app: DirectoryApp, file?: File) => void
}

export default function AppDeveloperTab({ open, apps, instanceOwner, me, busyKey, resolveSrc, request, uploadIcon, onOpenApp, onAction, onDialog }: DeveloperTabProps) {
  // ---- Starter snippet ----
  const [copied, setCopied] = useState<'' | 'yes' | 'failed'>('')
  const snippetRef = useRef<HTMLPreElement | null>(null)
  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(STARTER)
      setCopied('yes')
    } catch {
      // No clipboard access (an insecure origin, or permission refused): select the text instead,
      // so one key press finishes the job.
      const node = snippetRef.current
      const selection = window.getSelection()
      if (node && selection) { const range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range) }
      setCopied('failed')
    }
  }
  useEffect(() => {
    if (!copied) return undefined
    const t = setTimeout(() => setCopied(''), 2500)
    return () => clearTimeout(t)
  }, [copied])

  // ---- Upload form ----
  const [showUpload, setShowUpload] = useState(false)
  const [source, setSource] = useState<'bundle' | 'link'>('bundle')
  const [form, setForm] = useState({ name: '', description: '', url: '' })
  // "Run inside LAN Party": the link is framed (a hosted app) instead of opening in a new tab.
  const [embed, setEmbed] = useState(false)
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconPreview, setIconPreview] = useState<string | null>(null)
  const [bundleFile, setBundleFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<{ name: string; published: boolean } | null>(null)
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const bundleInputRef = useRef<HTMLInputElement | null>(null)

  const resetForm = () => { setSource('bundle'); setForm({ name: '', description: '', url: '' }); setEmbed(false); setIconFile(null); setBundleFile(null); setError(null) }
  // A half-filled form does not survive the directory being closed.
  useEffect(() => { if (!open) { setShowUpload(false); setUploaded(null); resetForm() } }, [open])

  // Manage the icon preview object URL.
  useEffect(() => {
    if (!iconFile) { setIconPreview(null); return undefined }
    const u = URL.createObjectURL(iconFile)
    setIconPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [iconFile])

  const pickBundle = (f?: File | null) => {
    if (!f) return
    const problem = bundleFileProblem(f)
    if (problem) { setError(problem); return }
    setError(null)
    setBundleFile(f)
    // Default the name to the file's base name if the user hasn't typed one yet.
    setForm((prev) => (prev.name.trim() ? prev : { ...prev, name: f.name.replace(/\.[^.]+$/, '').slice(0, 80) }))
  }

  // An address that is not a web address is never clickable anywhere, so it is checked here,
  // before there is a draft to fix. One that is to run inside LAN Party is held to more (https, and
  // not LAN Party's own address); the server asks the same and has the last word.
  const linkOk = !!safeLinkUrl(form.url)
  const embedProblem = source === 'link' && embed && linkOk ? hostedUrlProblem(form.url, [resolveSrc('/')]) : ''
  const canSubmit = !!form.name.trim() && (source === 'link' ? linkOk && !embedProblem : !!bundleFile)
  const submit = async () => {
    if (!form.name.trim()) { setError('App name is required.'); return }
    if (source === 'bundle' && !bundleFile) { setError('Choose a .html file or a .zip bundle.'); return }
    if (source === 'link' && !linkOk) { setError('Enter the full web address, starting with http:// or https://.'); return }
    if (embedProblem) { setError(embedProblem); return }
    setSubmitting(true)
    setError(null)
    try {
      const iconUrl = iconFile ? await uploadIcon(iconFile) : ''
      let data
      if (source === 'bundle' && bundleFile) {
        const fd = new FormData()
        fd.append('name', form.name)
        fd.append('description', form.description || '')
        if (iconUrl) fd.append('iconUrl', iconUrl)
        fd.append('bundle', bundleFile)
        data = await request('/apps/bundle', { method: 'POST', form: fd })
      } else {
        data = await request('/apps', { method: 'POST', json: { name: form.name, description: form.description, url: form.url.trim(), iconUrl, embed } })
      }
      // What the server made of it, not what this form expected: an instance owner's upload is
      // published at once, everyone else's starts as a draft.
      setUploaded({ name: data.app?.name || form.name.trim(), published: data.app?.status === 'published' })
      setShowUpload(false)
      resetForm()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Upload failed')
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Replace bundle: pick the file here, confirm in the directory's dialog ----
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const replaceTargetRef = useRef<DirectoryApp | null>(null)
  const [fileProblem, setFileProblem] = useState<{ id: number; text: string } | null>(null)
  const pickReplacement = (app: DirectoryApp) => { replaceTargetRef.current = app; setFileProblem(null); replaceInputRef.current?.click() }
  const onReplacementPicked = (file?: File | null) => {
    const app = replaceTargetRef.current
    replaceTargetRef.current = null
    if (!file || !app) return
    const problem = bundleFileProblem(file)
    if (problem) { setFileProblem({ id: app.id, text: problem }); return }
    onDialog('replace', app, file)
  }

  // ---- Check app ----
  const [checks, setChecks] = useState<Record<number, CheckEntry>>({})
  const runsRef = useRef(new Map<number, AppCheckRun>())
  // Every running check is stopped, and its hidden frame removed, when the directory closes or
  // this tab goes away. (finish() in appCheck.ts removes the frame on every other way out.)
  useEffect(() => {
    const runs = runsRef.current
    return () => { for (const run of runs.values()) run.cancel(); runs.clear() }
  }, [open])
  const checkApp = (app: DirectoryApp) => {
    const url = app.url || ''
    // Bundles only. The check runs the app in a frame with no origin and no storage, which is how a
    // bundle really runs and not at all how a hosted site does: its answers about one would be
    // wrong in both directions, so it is not offered for one.
    if (!isBundleApp(app) || !url) return
    // Only reachable with a check still running when the bundle was replaced under it: that one
    // is about files that no longer exist.
    runsRef.current.get(app.id)?.cancel()
    const run = startAppCheck({ src: resolveSrc(url), me })
    runsRef.current.set(app.id, run)
    setChecks((prev) => ({ ...prev, [app.id]: { url, running: true, result: null } }))
    run.done.then((result) => {
      const current = runsRef.current.get(app.id)
      if (current && current !== run) return // superseded: the row now belongs to a newer check
      runsRef.current.delete(app.id)
      setChecks((prev) => {
        const next = { ...prev }
        // Cancelled: there is nothing to report, so the row goes back to how it was.
        if (result) next[app.id] = { url, running: false, result }
        else delete next[app.id]
        return next
      })
    })
  }

  const renderCheck = (app: DirectoryApp) => {
    const entry = checks[app.id]
    // A result is about the files that were checked. After a bundle replace the url is a new one.
    if (!entry || entry.url !== (app.url || '')) return null
    if (entry.running) return <div className="app-check" role="status">Checking… loading the app out of sight for up to {Math.round(APP_CHECK_MS / 1000)} seconds.</div>
    const r = entry.result
    if (!r) return null
    const answered = r.httpStatus != null
    // A hello can only come from a page whose scripts ran, so it counts as loaded even when the
    // check ended (hello and state both seen) before the frame's load event, which waits for
    // every image.
    const arrived = r.loaded || r.hello
    const pageOk = answered ? r.httpStatus === 200 && arrived : arrived
    const seconds = Math.max(1, Math.round(r.watchedMs / 1000))
    return (
      <div className="app-check" role="status">
        <div className="app-check-title">Check result</div>
        <ul className="app-check-list">
          <li className={pageOk ? 'ok' : 'bad'}>
            <span className="app-check-mark" aria-hidden="true">{pageOk ? '✓' : '✕'}</span>
            <span>
              <b>Page loaded:</b>{' '}
              {pageOk
                ? 'yes.'
                : answered && r.httpStatus !== 200
                  ? `no — the server answered ${r.httpStatus} for the app's page.`
                  : `no — the page had not finished loading after ${seconds} seconds.`}
            </span>
          </li>
          <li className={r.hello ? 'ok' : 'warn'}>
            <span className="app-check-mark" aria-hidden="true">{r.hello ? '✓' : '–'}</span>
            <span>
              <b>SDK connected:</b>{' '}
              {r.hello
                ? 'yes — the app said hello to the bridge.'
                : `no hello within ${seconds} seconds. That is fine for an app that does not use the SDK. If yours should, check that the page loads /sdk/lanparty.js and calls LANParty.connect().`}
            </span>
          </li>
          <li className={r.stateChanges > 0 ? 'ok' : 'warn'}>
            <span className="app-check-mark" aria-hidden="true">{r.stateChanges > 0 ? '✓' : '–'}</span>
            <span>
              <b>Shared state:</b>{' '}
              {r.stateChanges > 0
                ? `set ${r.stateChanges} time${r.stateChanges === 1 ? '' : 's'}; ${r.stateKeys} key${r.stateKeys === 1 ? '' : 's'} at the end.`
                : 'nothing set while it was watched. Many apps only set state once somebody does something, and nobody could here.'}
            </span>
          </li>
        </ul>
        <div className="app-check-note">A quick diagnostic for you, not a security review: nobody looked at what the code does, and it says nothing about whether the app will be approved.</div>
      </div>
    )
  }

  const renderStatusLine = (app: DirectoryApp) => {
    const status = statusOf(app)
    if (status === 'published') return 'Everyone can see it in the directory and start it in a voice room.'
    if (status === 'pending') return `Waiting for an instance owner to review it${app.submittedAt ? ` (submitted ${formatWhen(app.submittedAt)})` : ''}. Until then only you can see it.`
    if (status === 'rejected') return 'The reviewer asked for changes. Only you can see it, and it cannot be started in a room while it is in this state.'
    // A bundle or a hosted app: either can be tried with real people before anyone has approved it.
    return runsInside(app)
      ? 'Only you can see it. You can open it, and start it in a voice room you are in — the others see it marked as not approved.'
      : 'Only you can see it.'
  }

  return (
    <div className="app-dev">
      <div className="app-dev-intro">
        <p>
          An app is a web page you upload: one <code>.html</code> file, or a <code>.zip</code> with an <code>index.html</code>. It runs in a sandbox, on its own or as a Thing To Do in a voice room.
          Anyone can upload and use their own app; it shows up for everyone else once an instance owner has approved it.
        </p>
        <p>
          A site you host yourself can run here too: add it as a <b>Link</b> and turn on <b>Run inside LAN Party</b>. It is framed from its own address, with its own storage and backend, and uses a copy of the same SDK.
        </p>
        <p>To share state with the people who joined, load the SDK this server hosts and connect. Paste this into your page’s <code>&lt;body&gt;</code> to start:</p>
        <div className="app-dev-snippet">
          <pre ref={snippetRef}><code>{STARTER}</code></pre>
          <button type="button" className="app-row-btn app-dev-copy" onClick={copySnippet}>{copied === 'yes' ? 'Copied' : 'Copy'}</button>
        </div>
        {copied === 'failed' && <div className="app-dev-hint" role="status">Could not reach the clipboard. The snippet is selected: press Ctrl+C (⌘C on a Mac).</div>}
        <div className="app-dev-hint">
          <code>lp.me</code> is who is looking, <code>lp.participants</code> who has joined, <code>lp.state</code> / <code>lp.setState(patch)</code> the shared object, <code>lp.emit(data)</code> a one-off message; listen with <code>lp.on('state' | 'participants' | 'message', fn)</code>.
          <code>lp.room</code> is <code>{'{ id }'}</code> in a voice room — an opaque id for that channel, made for your app alone — and <code>null</code> when the app is open on its own.
          An app only ever sees names and avatars.
        </div>
      </div>

      {uploaded && (
        <div className="app-dev-notice" role="status">
          {uploaded.published
            ? `“${uploaded.name}” is uploaded and published.`
            : `“${uploaded.name}” is uploaded as a draft. Only you can see it. Try it, then choose Submit for review when it is ready for everyone.`}
        </div>
      )}

      {!showUpload ? (
        <button type="button" className="connect-btn app-dev-upload-btn" onClick={() => { setShowUpload(true); setUploaded(null) }}>Upload an app</button>
      ) : (
        <div className="app-dir-upload app-dev-upload">
          <div className="app-source-toggle" role="tablist" aria-label="App type">
            <button type="button" role="tab" aria-selected={source === 'bundle'} className={`app-source-btn${source === 'bundle' ? ' active' : ''}`} onClick={() => { setSource('bundle'); setError(null) }}>Upload a mini-app</button>
            <button type="button" role="tab" aria-selected={source === 'link'} className={`app-source-btn${source === 'link' ? ' active' : ''}`} onClick={() => { setSource('link'); setError(null) }}>Link (external URL)</button>
          </div>

          <button type="button" className="app-upload-icon-btn" onClick={() => iconInputRef.current?.click()}>
            {iconPreview ? <img src={iconPreview} alt="App icon preview" /> : <span>+ Icon</span>}
          </button>
          <input ref={iconInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) setIconFile(f); e.target.value = '' }} />

          <label className="app-field-label" htmlFor="app-upload-name">App name</label>
          <input id="app-upload-name" className="profile-text-input" value={form.name} maxLength={80} placeholder="My cool app" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <label className="app-field-label" htmlFor="app-upload-desc">Description</label>
          <textarea id="app-upload-desc" className="profile-textarea" rows={3} maxLength={500} placeholder="What does it do?" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />

          {source === 'link' ? (
            <>
              <label className="app-field-label" htmlFor="app-upload-url">Link (URL)</label>
              <input id="app-upload-url" className="profile-text-input" type="url" inputMode="url" value={form.url} placeholder="https://…" onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
              <div className="app-bundle-hint">
                The full address, starting with <code>http://</code> or <code>https://</code>.
                {form.url.trim() && !linkOk && <span className="app-row-warn"> This is not a web address yet.</span>}
              </div>
              <label className="app-embed-toggle">
                <input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} />
                <span>Run inside LAN Party</span>
              </label>
              <div className="app-bundle-hint">
                {embed
                  ? <>The site is shown in a frame — on its own, or as a Thing To Do in a voice room — instead of opening in a new tab. It needs an <code>https://</code> address that is not this LAN Party’s own, and it must allow being framed by <code>{window.location.origin}</code> (no <code>X-Frame-Options</code> or <code>frame-ancestors</code> that shuts it out). To know who is looking and which room it is in, it can use the SDK: copy <code>/sdk/lanparty.js</code> into the site and call <code>{`LANParty.connect({ hostOrigins: ['${window.location.origin}'] })`}</code>.</>
                  : 'Off: the link opens in a new browser tab, and the site learns nothing from LAN Party.'}
                {embedProblem && <span className="app-row-warn"> {embedProblem}</span>}
              </div>
              <div className="app-bundle-hint">Both can be changed later under Edit details. Changing either on a published app sends it back to draft, to be reviewed again.</div>
            </>
          ) : (
            <>
              <span className="app-field-label">App bundle</span>
              <button type="button" className="app-bundle-pick" onClick={() => bundleInputRef.current?.click()}>
                {bundleFile ? `📦 ${bundleFile.name}` : 'Choose a .html file or .zip bundle…'}
              </button>
              <input ref={bundleInputRef} type="file" accept=".html,.htm,.zip,text/html,application/zip" className="file-input" onChange={(e) => { pickBundle(e.target.files?.[0]); e.target.value = '' }} />
              <div className="app-bundle-hint">A single <code>.html</code> file, or a <code>.zip</code> containing <code>index.html</code> plus its assets. It runs sandboxed inside LAN Party — no access to your account. Max 15 MB.</div>
            </>
          )}

          <div className="app-bundle-hint">
            {instanceOwner
              ? 'You run this instance, so your upload is published straight away.'
              : 'It is saved as a draft that only you can see. Everyone else gets it once an instance owner approves it.'}
          </div>
          {error && <div className="composer-error" role="alert">{error}</div>}
          <div className="app-dir-actions">
            <button type="button" className="connect-btn" onClick={() => { setShowUpload(false); resetForm() }} disabled={submitting}>Cancel</button>
            <button type="button" className="connect-btn" onClick={submit} disabled={submitting || !canSubmit}>{submitting ? 'Uploading…' : instanceOwner ? 'Upload and publish' : 'Upload as draft'}</button>
          </div>
        </div>
      )}

      <h3 className="app-dir-section">My apps{apps.length > 0 ? ` (${apps.length})` : ''}</h3>
      {apps.length === 0 ? (
        <div className="app-dir-empty app-dir-empty-small">You have not uploaded an app yet.</div>
      ) : (
        <div className="app-rows">
          {apps.map((app) => {
            const status = statusOf(app)
            const busy = !!busyKey && busyKey.startsWith(`${app.id}:`)
            const check = checks[app.id]
            const bundle = isBundleApp(app)
            return (
              <div className="app-row" key={app.id}>
                <AppIcon app={app} resolveSrc={resolveSrc} />
                <div className="app-row-body">
                  <div className="app-row-head">
                    <span className="app-row-name">{app.name}</span>
                    <StatusChip status={status} />
                    <span className="app-row-kind">{bundle ? 'bundle' : app.hosted ? 'link · runs inside LAN Party' : 'link'}</span>
                  </div>
                  {app.description && <div className="app-row-desc">{app.description}</div>}
                  {!bundle && (
                    // Where the link goes, in full and as text — it is what a reviewer will be approving.
                    <div className="app-row-kindline">
                      {app.hosted ? 'Runs inside LAN Party, framed from: ' : 'Opens in a new tab: '}<span className="app-row-url">{app.url || '(no address given)'}</span>
                      {!safeLinkUrl(app.url) && <span className="app-row-warn"> Not a web address, so nobody can open it. Choose Edit details and give it one that starts with https://.</span>}
                    </div>
                  )}
                  <div className="app-row-status">{renderStatusLine(app)}</div>
                  {status === 'rejected' && (
                    <div className="app-row-note">
                      <b>Reviewer’s note{app.reviewedAt ? ` (${formatWhen(app.reviewedAt)})` : ''}:</b>{' '}
                      {app.reviewNote ? app.reviewNote : 'none was left.'}
                    </div>
                  )}
                  {fileProblem?.id === app.id && <div className="composer-error" role="alert">{fileProblem.text}</div>}
                  <div className="app-row-actions">
                    <OpenAppControl app={app} onOpenApp={onOpenApp} />
                    {bundle && <RowButton onClick={() => checkApp(app)} disabled={!!check?.running && check.url === app.url} title="Load it out of sight for a few seconds and report what it did">Check app</RowButton>}
                    <RowButton onClick={() => onDialog('edit', app)} disabled={busy}>Edit details</RowButton>
                    {bundle && <RowButton onClick={() => pickReplacement(app)} disabled={busy}>Replace bundle</RowButton>}
                    {/* Whoever runs the instance has nobody to submit to: they publish their own. */}
                    {status !== 'published' && instanceOwner && <RowButton tone="primary" onClick={() => onAction(app, 'approve')} disabled={busy}>Publish</RowButton>}
                    {(status === 'draft' || status === 'rejected') && !instanceOwner && <RowButton tone="primary" onClick={() => onAction(app, 'submit')} disabled={busy}>{status === 'rejected' ? 'Submit again' : 'Submit for review'}</RowButton>}
                    {status === 'pending' && <RowButton onClick={() => onAction(app, 'withdraw')} disabled={busy}>Withdraw</RowButton>}
                    {status === 'published' && <RowButton onClick={() => onDialog('unpublish', app)} disabled={busy}>Unpublish</RowButton>}
                    <RowButton tone="danger" onClick={() => onDialog('delete', app)} disabled={busy}>Delete</RowButton>
                  </div>
                  {renderCheck(app)}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <input ref={replaceInputRef} type="file" accept=".html,.htm,.zip,text/html,application/zip" className="file-input" onChange={(e) => { onReplacementPicked(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}
