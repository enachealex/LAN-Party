import { useEffect, useState } from 'react'
import { REASON_MAX, TIMEOUT_CHOICES } from '../moderation'

export interface ModerationRequest {
  kind: 'timeout' | 'ban'
  username: string
  serverId: string
  serverName: string
}

interface ModerationDialogProps {
  request: ModerationRequest
  /** Resolves to an error message to show, or null when it worked (the dialog then closes). */
  onSubmit: (choice: { minutes?: number; reason: string }) => Promise<string | null>
  onClose: () => void
}

/**
 * The dialog behind "Time out…" and "Ban…": how long (for a timeout), an optional reason, and for
 * a ban the plain statement of what it does and how it differs from removing someone. In-app
 * rather than window.confirm/prompt, which do nothing in the desktop app.
 *
 * It opens on Cancel, so that Enter pressed by reflex never bans anybody.
 */
export default function ModerationDialog({ request, onSubmit, onClose }: ModerationDialogProps) {
  const [minutes, setMinutes] = useState<number>(TIMEOUT_CHOICES[1].minutes)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBan = request.kind === 'ban'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const problem = await onSubmit(isBan ? { reason: reason.trim() } : { minutes, reason: reason.trim() })
    setBusy(false)
    if (problem) setError(problem)
    else onClose()
  }

  return (
    <div className="prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="moderation-title" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="prompt-card">
        <div id="moderation-title" className="prompt-title">
          {isBan ? `Ban ${request.username} from “${request.serverName}”?` : `Time out ${request.username}`}
        </div>
        {isBan ? (
          <p className="prompt-message">
            They are removed from the server now and <strong>cannot come back until an admin unbans them</strong>: no invite link
            works for them and they cannot be invited by name. That is the difference from “Remove from server”, which an
            admin can undo simply by inviting them again. Bans are listed under the server’s menu → Bans.
          </p>
        ) : (
          <>
            <p className="prompt-message">
              Until it ends they can still read “{request.serverName}”, but cannot send, edit or react to messages, pin, use
              activities or join voice here. They are told, with your reason if you give one.
            </p>
            <div className="prompt-label mod-label">How long</div>
            <div className="mod-choices" role="radiogroup" aria-label="How long">
              {TIMEOUT_CHOICES.map((choice) => (
                <button
                  key={choice.minutes}
                  type="button"
                  role="radio"
                  aria-checked={minutes === choice.minutes}
                  className={`mod-choice${minutes === choice.minutes ? ' active' : ''}`}
                  onClick={() => setMinutes(choice.minutes)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </>
        )}
        <label className="prompt-label mod-label" htmlFor="moderation-reason">Reason (optional)</label>
        <textarea
          id="moderation-reason"
          className="prompt-input mod-reason"
          rows={2}
          maxLength={REASON_MAX}
          placeholder={isBan ? 'Shown to admins in the ban list' : 'Shown to them and to admins'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <div className="cc-access-error mod-error">{error}</div>}
        <div className="prompt-actions">
          <button type="button" className="prompt-btn ghost" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={`prompt-btn ${isBan ? 'danger' : 'primary'}`} disabled={busy} onClick={submit}>
            {busy ? 'Working…' : isBan ? 'Ban' : 'Time out'}
          </button>
        </div>
      </div>
    </div>
  )
}
