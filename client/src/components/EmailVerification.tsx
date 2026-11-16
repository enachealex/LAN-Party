import { useState, type FormEvent } from 'react'

/**
 * What the app shows about an account whose email address has not been confirmed yet. The server
 * decides everything (services/emailVerification.js on the server): these only say what it will
 * say, before the person runs into it.
 */

/** The server's own code for "this account must verify its email first" (403 bodies, socket refusals). */
export const EMAIL_UNVERIFIED = 'email-unverified'

/** The one sentence used wherever a control is switched off for this reason. */
export const VERIFY_FIRST = 'Verify your email first: open the link we emailed you.'

/**
 * Who is asking: a session token, or (on the sign-in form, where an unverified account gets no
 * session) the username and password that were just refused a sign-in.
 */
export type VerifyAuth = string | { username: string; password: string }
const request = (auth: VerifyAuth, body: Record<string, string> = {}): RequestInit => (typeof auth === 'string'
  ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }
  : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, username: auth.username, password: auth.password }) })

/**
 * Ask the server to send the link again and put its answer into words.
 * @returns what to tell the person, and whether the account turned out to be verified already
 */
export async function resendVerification(serverUrl: string, auth: VerifyAuth): Promise<{ message: string; alreadyVerified: boolean }> {
  try {
    const res = await fetch(`${serverUrl}/auth/verify-email/resend`, request(auth))
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.alreadyVerified) return { message: 'Your email is already verified.', alreadyVerified: true }
    if (res.ok) return { message: 'Sent. Check your inbox (and the spam folder).', alreadyVerified: false }
    return { message: data.error || 'The email could not be sent. Try again later.', alreadyVerified: false }
  } catch (_) {
    return { message: "Couldn't reach the server. Try again in a moment.", alreadyVerified: false }
  }
}

/**
 * Put the right address on an account that has not verified one yet (a typo at sign-up), which
 * also emails the link there. The password is asked for: see POST /auth/verify-email/change.
 * @returns the saved address when it worked, and what to tell the person either way
 */
export async function changeUnverifiedEmail(serverUrl: string, auth: VerifyAuth, email: string, password: string): Promise<{ email: string | null; message: string; alreadyVerified: boolean }> {
  try {
    const res = await fetch(`${serverUrl}/auth/verify-email/change`, request(auth, { email, password }))
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      return {
        email: data.email,
        message: data.sent ? `Saved. We emailed a new link to ${data.email}.` : `Saved, but the email to ${data.email} could not be sent. Try Resend in a little while.`,
        alreadyVerified: false,
      }
    }
    return { email: null, message: data.error || 'Could not change the address.', alreadyVerified: !!data.alreadyVerified }
  } catch (_) {
    return { email: null, message: "Couldn't reach the server. Try again in a moment.", alreadyVerified: false }
  }
}

interface ChangeEmailFormProps {
  /** Resolves to the saved address (or null) and what to say about it. */
  onSubmit: (email: string, password: string) => Promise<{ email: string | null; message: string }>
  onCancel: () => void
  /** False on the sign-in form, which already has the password that was just typed. */
  askPassword?: boolean
}

/** "Wrong address?": the new address and the password, for an account that has not verified one. */
export function ChangeEmailForm({ onSubmit, onCancel, askPassword = true }: ChangeEmailFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || (askPassword && !password) || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onSubmit(email.trim(), password)
      if (!result.email) setError(result.message)
    } finally { setBusy(false) }
  }
  return (
    <form className="security-card" onSubmit={submit}>
      <strong className="security-card-title">Use a different address</strong>
      <label className="security-label" htmlFor="verify-change-email">The right email address</label>
      <input id="verify-change-email" className="feedback-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
      {askPassword && (
        <>
          <label className="security-label" htmlFor="verify-change-password">Your password</label>
          <input id="verify-change-password" className="feedback-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </>
      )}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="security-actions">
        <button type="button" className="feedback-btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="feedback-btn primary" disabled={busy || !email.trim() || (askPassword && !password)}>{busy ? 'Saving...' : 'Save and send the link'}</button>
      </div>
    </form>
  )
}

interface VerifyBeforeSignInProps {
  serverUrl: string
  /** The sign-in that was just refused: who, with the password they typed, and the address on file. */
  signIn: { username: string; password: string; email: string }
  /** The address was corrected: keep showing this panel with the new one. */
  onEmailChanged: (email: string) => void
  /** Back to the sign-in form. */
  onBack: () => void
}

/**
 * Shown on the sign-in form in place of a session when the password was right but the account has
 * not opened its verification link. It names the address (a typo there is the usual reason the
 * email never came) and can resend the link or correct the address with the password just typed.
 */
export function VerifyBeforeSignIn({ serverUrl, signIn, onEmailChanged, onBack }: VerifyBeforeSignInProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const creds = { username: signIn.username, password: signIn.password }
  const resend = async () => {
    setBusy(true)
    setNote(null)
    try {
      const { message, alreadyVerified } = await resendVerification(serverUrl, creds)
      setNote(alreadyVerified ? 'Your email is already verified. Sign in again.' : message)
    } finally { setBusy(false) }
  }
  return (
    <div className="auth-form verify-signin" role="status">
      <strong className="verify-signin-title">Confirm your email to sign in</strong>
      <p className="verify-signin-text">
        We sent a link to {signIn.email ? <span className="verify-banner-email">{signIn.email}</span> : 'your email address'}.
        Open it, then sign in. The link works for 24 hours.
      </p>
      {changing ? (
        <ChangeEmailForm
          askPassword={false}
          onCancel={() => setChanging(false)}
          onSubmit={async (email) => {
            const result = await changeUnverifiedEmail(serverUrl, creds, email, signIn.password)
            if (result.email) { onEmailChanged(result.email); setChanging(false); setNote(result.message) }
            return result
          }}
        />
      ) : (
        <div className="verify-signin-actions">
          <button type="button" className="connect-btn" onClick={resend} disabled={busy}>{busy ? 'Sending...' : 'Resend email'}</button>
          <button type="button" className="link" onClick={() => { setNote(null); setChanging(true) }}>Wrong address?</button>
          <button type="button" className="link" onClick={onBack}>Back to sign in</button>
        </div>
      )}
      {note && <p className="muted verify-signin-note">{note}</p>}
    </div>
  )
}

/** What opening an emailed verification link came to. */
export type VerifyLinkResult = { state: 'working' } | { state: 'ok' } | { state: 'failed'; message: string }

/**
 * Spend the token from an emailed link (/app/?verify=TOKEN). Works signed in or out, and never
 * signs anyone in: the answer is only "verified" or "that link is no good".
 */
export async function confirmEmailToken(serverUrl: string, token: string): Promise<VerifyLinkResult> {
  try {
    const res = await fetch(`${serverUrl}/auth/verify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    if (res.ok) return { state: 'ok' }
    const data = await res.json().catch(() => ({}))
    return { state: 'failed', message: data.error || 'This verification link is invalid or has expired.' }
  } catch (_) {
    return { state: 'failed', message: "Couldn't reach the server. Open the link again in a moment." }
  }
}

interface VerifyEmailBannerProps {
  email: string
  /** Sends the email again; resolves to what to say about it. */
  onResend: () => Promise<string>
  /** Open the place to correct a mistyped address (Settings > Security). */
  onFixAddress: () => void
  /** Hide it until the next time the app is opened. */
  onDismiss: () => void
}

/** The slim strip across the top for an account that has not opened its verification link. */
export function VerifyEmailBanner({ email, onResend, onFixAddress, onDismiss }: VerifyEmailBannerProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const resend = async () => {
    setBusy(true)
    try { setNote(await onResend()) } finally { setBusy(false) }
  }
  return (
    <div className="verify-banner" role="status">
      <span className="verify-banner-text">
        {note || <>Check your email{email ? <> (<span className="verify-banner-email">{email}</span>)</> : null} to finish setting up.</>}
      </span>
      <button type="button" className="verify-banner-btn" onClick={resend} disabled={busy}>{busy ? 'Sending...' : 'Resend'}</button>
      <button type="button" className="verify-banner-link" onClick={onFixAddress}>Wrong address?</button>
      <button type="button" className="verify-banner-close" onClick={onDismiss} aria-label="Dismiss until next time" title="Dismiss">×</button>
    </div>
  )
}

interface UnverifiedNoticeProps {
  /** What cannot be done here, e.g. "post in the public server" or "send direct messages". */
  what: string
  onResend: () => Promise<string>
}

/**
 * Stands where a message box (or a Join Voice button) would be while the account is unverified,
 * like the timeout and blocked notices: nothing to type into and then lose.
 */
export function UnverifiedNotice({ what, onResend }: UnverifiedNoticeProps) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const resend = async () => {
    setBusy(true)
    try { setNote(await onResend()) } finally { setBusy(false) }
  }
  return (
    <div className="composer-notice unverified" role="status">
      <span className="composer-notice-icon" aria-hidden="true">✉️</span>
      <div className="composer-notice-text">
        <strong>Verify your email to {what}.</strong>
        <span>{note || 'Open the link we emailed you when you signed up. You can keep reading in the meantime.'}</span>
      </div>
      <button type="button" className="feedback-btn ghost" onClick={resend} disabled={busy}>{busy ? 'Sending...' : 'Resend email'}</button>
    </div>
  )
}

interface VerifyLinkDialogProps {
  result: VerifyLinkResult
  signedIn: boolean
  onClose: () => void
}

/** The confirmation shown when the app was opened from a verification link. */
export function VerifyLinkDialog({ result, signedIn, onClose }: VerifyLinkDialogProps) {
  const title = result.state === 'working' ? 'Verifying your email...' : result.state === 'ok' ? 'Email verified' : 'That link did not work'
  return (
    <div className="verify-link-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="verify-link-card">
        <div className={`verify-link-icon ${result.state}`} aria-hidden="true">{result.state === 'ok' ? '✓' : result.state === 'failed' ? '!' : '…'}</div>
        <h3>{title}</h3>
        {result.state === 'ok' && (
          <p>{signedIn ? 'Thanks! Everything is unlocked: you can post, message, call and upload.' : 'Thanks! Your account is fully set up. Sign in to start chatting.'}</p>
        )}
        {result.state === 'failed' && (
          <p>{result.message}{signedIn ? ' You can send a new one from Settings, under Security.' : ''}</p>
        )}
        {result.state !== 'working' && (
          <button type="button" className="feedback-btn primary" onClick={onClose}>{signedIn || result.state === 'failed' ? 'OK' : 'Go to sign in'}</button>
        )}
      </div>
    </div>
  )
}
