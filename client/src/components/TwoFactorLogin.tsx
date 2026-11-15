import { useEffect, useRef, useState, type FormEvent } from 'react'

/** What POST /auth/login answers for an account with two-factor on, in place of a session. */
export interface TwoFactorChallenge {
  ticket: string
  /** When the ticket stops working (ms). The server gives it five minutes. */
  expiresAt: number
}

interface TwoFactorLoginProps {
  serverUrl: string
  challenge: TwoFactorChallenge
  /** The normal sign-in response (token + user): handed to the same code a one-step login runs. */
  onSignedIn: (data: any) => void | Promise<void>
  /** Back to the password form, with something to say there when it was not the person's choice. */
  onCancel: (message?: string) => void
}

const EXPIRED = 'That sign-in timed out. Enter your password again.'

/**
 * The second step of signing in: the six digits from the authenticator app, or a recovery code.
 * Shown in place of the password form after the password was right. Nothing here is a session:
 * the ticket only opens POST /auth/login/2fa, and only once.
 */
export default function TwoFactorLogin({ serverUrl, challenge, onSignedIn, onCancel }: TwoFactorLoginProps) {
  const [useRecovery, setUseRecovery] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // The ticket is good for five minutes. Rather than let someone type into a dead form, go back to
  // the password step when it runs out.
  useEffect(() => {
    const left = challenge.expiresAt - Date.now()
    const timer = window.setTimeout(() => onCancel(EXPIRED), Math.max(0, left))
    return () => window.clearTimeout(timer)
    // onCancel is recreated on every render of the app; the ticket is what this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge.ticket, challenge.expiresAt])

  useEffect(() => { inputRef.current?.focus() }, [useRecovery])

  const ready = useRecovery ? code.replace(/[^a-z0-9]/gi, '').length >= 16 : /^\d{6}$/.test(code)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${serverUrl}/auth/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useRecovery ? { ticket: challenge.ticket, recoveryCode: code } : { ticket: challenge.ticket, code }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.token) {
        await onSignedIn(data)
        return
      }
      // Too many wrong codes (or too many tries): this ticket is finished. Back to the start, with
      // the server's own words about how long to wait.
      if (res.status === 429) {
        onCancel(data.error || 'Too many attempts. Wait a few minutes and sign in again.')
        return
      }
      if (Date.now() >= challenge.expiresAt) { onCancel(EXPIRED); return }
      setError(useRecovery
        ? 'That recovery code did not work. Each one works only once.'
        : 'That code did not work. Check the app for the current one and try again.')
      setCode('')
      inputRef.current?.focus()
    } catch (_) {
      setError("Couldn't reach the server. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const switchMode = () => { setUseRecovery((v) => !v); setCode(''); setError(null) }

  return (
    <form onSubmit={submit} className="auth-form two-factor-form">
      <h3 className="two-factor-title">Two-step sign-in</h3>
      <p className="two-factor-hint">
        {useRecovery
          ? 'Enter one of the recovery codes you saved when you turned two-step sign-in on. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {useRecovery ? (
        <>
          <label htmlFor="two-factor-recovery">Recovery code</label>
          <input
            id="two-factor-recovery"
            ref={inputRef}
            className="half-field two-factor-recovery-input"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 40))}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </>
      ) : (
        <>
          <label htmlFor="two-factor-code">Authentication code</label>
          <input
            id="two-factor-code"
            ref={inputRef}
            className="half-field two-factor-code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
          />
        </>
      )}
      <div className="two-factor-actions">
        <button type="submit" className="connect-btn" disabled={!ready || busy}>{busy ? 'Checking...' : 'Verify'}</button>
        <button type="button" className="link" onClick={() => onCancel()}>Back</button>
      </div>
      <button type="button" className="link two-factor-switch" onClick={switchMode}>
        {useRecovery ? 'Use a code from your authenticator app instead' : 'Use a recovery code instead'}
      </button>
      {useRecovery && (
        <p className="two-factor-hint two-factor-lost">
          Lost your recovery codes too? Ask the person who runs this LAN Party to clear two-step sign-in on your account.
        </p>
      )}
    </form>
  )
}
