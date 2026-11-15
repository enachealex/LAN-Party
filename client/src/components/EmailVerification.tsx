import { useState } from 'react'

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
 * Ask the server to send the link again and put its answer into words.
 * @returns what to tell the person, and whether the account turned out to be verified already
 */
export async function resendVerification(serverUrl: string, token: string): Promise<{ message: string; alreadyVerified: boolean }> {
  try {
    const res = await fetch(`${serverUrl}/auth/verify-email/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.alreadyVerified) return { message: 'Your email is already verified.', alreadyVerified: true }
    if (res.ok) return { message: 'Sent. Check your inbox (and the spam folder).', alreadyVerified: false }
    return { message: data.error || 'The email could not be sent. Try again later.', alreadyVerified: false }
  } catch (_) {
    return { message: "Couldn't reach the server. Try again in a moment.", alreadyVerified: false }
  }
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
  /** Hide it until the next time the app is opened. */
  onDismiss: () => void
}

/** The slim strip across the top for an account that has not opened its verification link. */
export function VerifyEmailBanner({ email, onResend, onDismiss }: VerifyEmailBannerProps) {
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
