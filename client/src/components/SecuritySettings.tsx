import { useEffect, useMemo, useState, type FormEvent } from 'react'
import qrcode from 'qrcode-generator'
import { ChangeEmailForm } from './EmailVerification'

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** GET /auth/2fa. Never carries the secret or a code. */
interface TwoFactorStatus {
  enabled: boolean
  enabledAt: number | null
  recoveryCodesRemaining: number
  setupPending: boolean
}

/** POST /auth/2fa/setup: the only response that ever holds the secret. */
interface PendingSetup {
  secret: string
  otpauthUri: string
}

interface SecuritySettingsProps {
  authedFetch: AuthedFetch
  username: string
  email: string
  /** Whether the account counts as verified (always true on an instance with no mailer). */
  emailVerified: boolean
  /** Ask the server to email the verification link again; resolves to what to tell the person. */
  onResendVerification: () => Promise<string>
  /** Correct a mistyped, unverified address; resolves to the saved address (or null) and what to say. */
  onChangeEmail: (email: string, password: string) => Promise<{ email: string | null; message: string }>
  /** Instance owners get the "clear someone's two-step sign-in" tool. Shown, not trusted: the server checks. */
  instanceOwner: boolean
  /** The app's in-app confirm dialog (window.confirm does nothing in the desktop app). */
  askConfirm: (opts: { title?: string; message?: string; submitLabel?: string }) => Promise<true | null>
  /** Tell the rest of the app that two-factor was turned on or off. */
  onTwoFactorChange?: (enabled: boolean) => void
}

/**
 * The QR code an authenticator app scans, drawn here from the otpauth:// address. The address
 * contains the secret, so it is never sent to a QR service or put in an image URL: the modules are
 * computed in this page and rendered as one SVG path.
 */
function SetupQr({ uri }: { uri: string }) {
  const { size, path } = useMemo(() => {
    // Lowest error correction: the code is shown on a clean screen, and fewer, larger modules scan
    // more easily from a phone than a denser code with redundancy it does not need.
    const qr = qrcode(0, 'L')
    qr.addData(uri)
    qr.make()
    const count = qr.getModuleCount()
    const quiet = 4 // the blank border scanners need
    let d = ''
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`
      }
    }
    return { size: count + quiet * 2, path: d }
  }, [uri])
  return (
    <svg className="security-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code to scan with your authenticator app" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

const readError = async (res: Response, fallback: string) => {
  const data = await res.json().catch(() => null)
  return (data && typeof data.error === 'string' && data.error) || fallback
}
const digits = (value: string) => value.replace(/\D/g, '').slice(0, 6)
const grouped = (secret: string) => (secret.match(/.{1,4}/g) || [secret]).join(' ')

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (_) {
    return false
  }
}

/** The recovery codes, the one time they can be seen: copy them, download them, then say so. */
function RecoveryCodes({ codes, username, onDone }: { codes: string[]; username: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const asText = () => [
    `LAN Party recovery codes for ${username}`,
    `Saved ${new Date().toLocaleString()}`,
    '',
    'Each code signs you in once if you cannot use your authenticator app.',
    'Keep them somewhere safe. Anyone with a code and your password can sign in as you.',
    '',
    ...codes,
    '',
  ].join('\r\n')
  const download = () => {
    const url = URL.createObjectURL(new Blob([asText()], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `lan-party-recovery-codes-${username}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setSaved(true)
  }
  const copy = async () => {
    if (await copyText(codes.join('\n'))) { setCopied(true); setSaved(true) }
  }
  return (
    <div className="security-card security-recovery" role="group" aria-label="Recovery codes">
      <strong className="security-card-title">Save your recovery codes</strong>
      <p className="security-warning">
        You will not see these again. Each one signs you in once if you lose your phone. Without them, and without your authenticator app, only the person who runs this LAN Party can let you back in.
      </p>
      <ul className="security-codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="security-actions">
        <button type="button" className="feedback-btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="feedback-btn ghost" onClick={download}>Download (.txt)</button>
        <button type="button" className="feedback-btn primary" onClick={onDone} disabled={!saved} title={saved ? undefined : 'Copy or download the codes first'}>I saved them</button>
      </div>
      {!saved && <p className="profile-settings-note security-after">Copy or download the codes to continue.</p>}
    </div>
  )
}

/**
 * Settings → Security: the account's email verification, two-step sign-in (set up, recovery codes,
 * turn off) and, for an instance owner, clearing it for someone who is locked out. All of it is
 * enforced by the server (routes/security.js); this is only the forms.
 */
export default function SecuritySettings({ authedFetch, username, email, emailVerified, onResendVerification, onChangeEmail, instanceOwner, askConfirm, onTwoFactorChange }: SecuritySettingsProps) {
  const [changingEmail, setChangingEmail] = useState(false)
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Which form is open: none, the password that starts setup, the QR + confirm step, the forms
  // for new recovery codes and for turning it off.
  const [mode, setMode] = useState<'idle' | 'start' | 'confirm' | 'regen' | 'off'>('idle')
  const [pending, setPending] = useState<PendingSetup | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [offWithRecovery, setOffWithRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [resendNote, setResendNote] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [clearName, setClearName] = useState('')
  const [clearNote, setClearNote] = useState<string | null>(null)

  const load = async () => {
    try {
      const res = await authedFetch('/auth/2fa')
      if (!res.ok) throw new Error(await readError(res, 'Could not load your security settings.'))
      setStatus(await res.json())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof TypeError ? "Couldn't reach the server." : (err as Error).message)
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setMode('idle'); setPending(null); setPassword(''); setCode(''); setRecovery(''); setOffWithRecovery(false); setError(null); setSecretCopied(false) }

  /** POST a JSON body; returns the parsed answer, or null after putting the server's words in `error`. */
  const post = async (path: string, body: unknown, fallback: string): Promise<any | null> => {
    setBusy(true)
    setError(null)
    try {
      const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) { setError(await readError(res, fallback)); return null }
      return await res.json()
    } catch (_) {
      setError("Couldn't reach the server. Please try again.")
      return null
    } finally {
      setBusy(false)
    }
  }

  const startSetup = async (e: FormEvent) => {
    e.preventDefault()
    const data = await post('/auth/2fa/setup', { password }, 'Could not start setup.')
    if (!data) return
    setPassword('')
    setPending({ secret: data.secret, otpauthUri: data.otpauthUri })
    setMode('confirm')
  }
  const confirmSetup = async (e: FormEvent) => {
    e.preventDefault()
    const data = await post('/auth/2fa/confirm', { code }, 'That code did not work.')
    if (!data) { setCode(''); return }
    reset()
    setCodes(data.recoveryCodes)
    onTwoFactorChange?.(true)
    await load()
  }
  const regenerate = async (e: FormEvent) => {
    e.preventDefault()
    const data = await post('/auth/2fa/recovery-codes', { code }, 'That code did not work.')
    if (!data) { setCode(''); return }
    reset()
    setCodes(data.recoveryCodes)
    await load()
  }
  const turnOff = async (e: FormEvent) => {
    e.preventDefault()
    const sure = await askConfirm({
      title: 'Turn off two-step sign-in?',
      message: 'Your account will be protected by your password alone, and your recovery codes will stop working.',
      submitLabel: 'Turn off',
    })
    if (!sure) return
    const data = await post('/auth/2fa/disable', offWithRecovery ? { password, recoveryCode: recovery } : { password, code }, 'Could not turn it off.')
    if (!data) { setCode(''); return }
    reset()
    setNotice('Two-step sign-in is off.')
    onTwoFactorChange?.(false)
    await load()
  }

  const resend = async () => {
    setResending(true)
    setResendNote(null)
    try { setResendNote(await onResendVerification()) } finally { setResending(false) }
  }

  const clearFor = async (e: FormEvent) => {
    e.preventDefault()
    const target = clearName.trim()
    if (!target) return
    const sure = await askConfirm({
      title: `Clear two-step sign-in for ${target}?`,
      message: `${target} will be able to sign in with their password alone. Only do this if you are sure the request really came from them. It is written to the server log.`,
      submitLabel: 'Clear it',
    })
    if (!sure) return
    setClearNote(null)
    try {
      const res = await authedFetch(`/admin/users/${encodeURIComponent(target)}/2fa/clear`, { method: 'POST', body: '{}' })
      if (!res.ok) { setClearNote(await readError(res, 'Could not clear it.')); return }
      const data = await res.json()
      setClearNote(data.wasEnabled ? `Cleared. ${target} can sign in with their password now.` : `${target} did not have two-step sign-in on.`)
      setClearName('')
      if (target === username) { onTwoFactorChange?.(false); await load() }
    } catch (_) {
      setClearNote("Couldn't reach the server.")
    }
  }

  const codeField = (id: string, label = 'Code from your authenticator app') => (
    <>
      <label className="security-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="feedback-input security-code-input"
        value={code}
        onChange={(e) => setCode(digits(e.target.value))}
        placeholder="123456"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoComplete="one-time-code"
      />
    </>
  )
  const passwordField = (id: string) => (
    <>
      <label className="security-label" htmlFor={id}>Your password</label>
      <input id={id} className="feedback-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
    </>
  )

  return (
    <>
      <section className="profile-settings-section">
        <h3 className="profile-settings-section-title">Email</h3>
        {emailVerified ? (
          <p className="profile-settings-note"><span className="security-badge on">Verified</span> {email || 'Your email address'}</p>
        ) : (
          <>
            <p className="profile-settings-note">
              <span className="security-badge off">Not verified</span> {email || 'Your email address'}
              <br />
              Until you open the link we emailed you, you can look around but not post in the public server, send direct messages or friend requests, create invites, upload files or make calls.
            </p>
            {changingEmail ? (
              <ChangeEmailForm
                onCancel={() => setChangingEmail(false)}
                onSubmit={async (next, pw) => {
                  const result = await onChangeEmail(next, pw)
                  if (result.email) { setChangingEmail(false); setResendNote(result.message) }
                  return result
                }}
              />
            ) : (
              <div className="security-actions start">
                <button type="button" className="feedback-btn primary" onClick={resend} disabled={resending}>{resending ? 'Sending...' : 'Resend the email'}</button>
                <button type="button" className="feedback-btn ghost" onClick={() => { setResendNote(null); setChangingEmail(true) }}>Wrong address?</button>
              </div>
            )}
            {resendNote && <p className="profile-settings-note security-after" role="status">{resendNote}</p>}
          </>
        )}
      </section>

      <section className="profile-settings-section">
        <h3 className="profile-settings-section-title">Two-step sign-in</h3>
        <p className="profile-settings-note">
          Ask for a 6-digit code from an authenticator app (Google Authenticator, Aegis, 1Password and the like) as well as your password when you sign in.
          It applies to new sign-ins: devices that are already signed in stay signed in.
        </p>
        {loadError && <p className="auth-error" role="alert">{loadError} <button type="button" className="link" onClick={load}>Try again</button></p>}
        {notice && <p className="profile-settings-note" role="status">{notice}</p>}

        {codes && <RecoveryCodes codes={codes} username={username} onDone={() => setCodes(null)} />}

        {status && !codes && !status.enabled && mode === 'idle' && (
          <div className="security-actions start">
            <span className="security-badge off">Off</span>
            <button type="button" className="feedback-btn primary" onClick={() => { setNotice(null); setMode('start') }}>Set up two-step sign-in</button>
          </div>
        )}

        {mode === 'start' && (
          <form className="security-card" onSubmit={startSetup}>
            <strong className="security-card-title">Confirm it is you</strong>
            {passwordField('security-start-password')}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <div className="security-actions">
              <button type="button" className="feedback-btn ghost" onClick={reset}>Cancel</button>
              <button type="submit" className="feedback-btn primary" disabled={!password || busy}>{busy ? 'Checking...' : 'Continue'}</button>
            </div>
          </form>
        )}

        {mode === 'confirm' && pending && (
          <form className="security-card" onSubmit={confirmSetup}>
            <strong className="security-card-title">1. Scan this with your authenticator app</strong>
            <div className="security-setup">
              <SetupQr uri={pending.otpauthUri} />
              <div className="security-setup-text">
                <span className="profile-settings-note">Can't scan it? Enter this key by hand (time-based, 6 digits):</span>
                <code className="security-secret">{grouped(pending.secret)}</code>
                <button type="button" className="feedback-btn ghost" onClick={async () => setSecretCopied(await copyText(pending.secret))}>{secretCopied ? 'Copied' : 'Copy key'}</button>
              </div>
            </div>
            <strong className="security-card-title">2. Enter the code it shows</strong>
            {codeField('security-confirm-code', 'Current 6-digit code')}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <p className="profile-settings-note">Nothing changes until you confirm. This setup expires in 15 minutes.</p>
            <div className="security-actions">
              <button type="button" className="feedback-btn ghost" onClick={reset}>Cancel</button>
              <button type="submit" className="feedback-btn primary" disabled={code.length !== 6 || busy}>{busy ? 'Checking...' : 'Turn on'}</button>
            </div>
          </form>
        )}

        {status && status.enabled && !codes && mode === 'idle' && (
          <>
            <p className="profile-settings-note">
              <span className="security-badge on">On</span>
              {status.enabledAt ? ` since ${new Date(status.enabledAt).toLocaleDateString()}. ` : ' '}
              {status.recoveryCodesRemaining} of 10 recovery codes left.
              {status.recoveryCodesRemaining <= 2 && ' Make new ones soon.'}
            </p>
            <div className="security-actions start">
              <button type="button" className="feedback-btn ghost" onClick={() => { setNotice(null); setMode('regen') }}>New recovery codes</button>
              <button type="button" className="feedback-btn ghost danger" onClick={() => { setNotice(null); setMode('off') }}>Turn off</button>
            </div>
          </>
        )}

        {mode === 'regen' && (
          <form className="security-card" onSubmit={regenerate}>
            <strong className="security-card-title">New recovery codes</strong>
            <p className="profile-settings-note">Your current recovery codes stop working as soon as the new ones are made.</p>
            {codeField('security-regen-code')}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <div className="security-actions">
              <button type="button" className="feedback-btn ghost" onClick={reset}>Cancel</button>
              <button type="submit" className="feedback-btn primary" disabled={code.length !== 6 || busy}>{busy ? 'Checking...' : 'Make new codes'}</button>
            </div>
          </form>
        )}

        {mode === 'off' && (
          <form className="security-card" onSubmit={turnOff}>
            <strong className="security-card-title">Turn off two-step sign-in</strong>
            <p className="profile-settings-note">Needs your password and a code, so that neither one alone can remove it.</p>
            {passwordField('security-off-password')}
            {offWithRecovery ? (
              <>
                <label className="security-label" htmlFor="security-off-recovery">Recovery code</label>
                <input id="security-off-recovery" className="feedback-input" value={recovery} onChange={(e) => setRecovery(e.target.value.slice(0, 40))} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
              </>
            ) : codeField('security-off-code')}
            <button type="button" className="link security-switch" onClick={() => { setOffWithRecovery((v) => !v); setError(null) }}>
              {offWithRecovery ? 'Use a code from your authenticator app instead' : 'Use a recovery code instead'}
            </button>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <div className="security-actions">
              <button type="button" className="feedback-btn ghost" onClick={reset}>Cancel</button>
              <button type="submit" className="feedback-btn primary" disabled={!password || (offWithRecovery ? recovery.trim().length < 16 : code.length !== 6) || busy}>{busy ? 'Checking...' : 'Turn off'}</button>
            </div>
          </form>
        )}
      </section>

      {instanceOwner && (
        <section className="profile-settings-section">
          <h3 className="profile-settings-section-title">Locked-out accounts</h3>
          <p className="profile-settings-note">
            You run this LAN Party, so you can clear two-step sign-in for someone who has lost both their authenticator app and their recovery codes. A password reset does not do this. Make sure the request is really from them first.
          </p>
          <form className="security-clear" onSubmit={clearFor}>
            <input className="feedback-input" value={clearName} onChange={(e) => setClearName(e.target.value)} placeholder="Username" aria-label="Username to clear two-step sign-in for" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <button type="submit" className="feedback-btn ghost" disabled={!clearName.trim()}>Clear two-step sign-in</button>
          </form>
          {clearNote && <p className="profile-settings-note security-after" role="status">{clearNote}</p>}
        </section>
      )}
    </>
  )
}
