import React from 'react'

/**
 * Startup screen shown while a returning user's session is restored: check for updates, reconnect,
 * and pull down servers / friends / conversations before the UI appears. Without it the app renders
 * empty and then visibly pops in as each fetch lands.
 *
 * Only shown when there is a stored token — a signed-out visitor goes straight to the login screen.
 *
 * Deliberately fails OPEN: the boot sequence has an overall timeout, and any step that errors is
 * marked and skipped rather than trapping the user here. A splash that can strand someone is worse
 * than no splash.
 */

// Step ids in display order, with the label shown for each.
export const BOOT_STEPS = [
  { id: 'session', label: 'Restoring your session' },
  { id: 'updates', label: 'Checking for updates' },
  { id: 'connect', label: 'Connecting' },
  { id: 'sync', label: 'Syncing messages' },
]

const MARK = { pending: '○', active: '◐', done: '✓', skipped: '–', failed: '!' }

export default function BootSplash({ steps = {}, note = null, resolveSrc = (u) => u }) {
  const done = BOOT_STEPS.filter((s) => ['done', 'skipped'].includes(steps[s.id])).length
  const pct = Math.round((done / BOOT_STEPS.length) * 100)

  return (
    <div className="boot-splash" role="status" aria-live="polite" aria-label="Starting LAN Party">
      <div className="boot-splash-card">
        <img className="boot-splash-logo" src={resolveSrc('icons/logo-192.png')} alt="" />
        <div className="boot-splash-title">LAN Party</div>

        <div className="boot-splash-bar" aria-hidden="true">
          <span className="boot-splash-bar-fill" style={{ width: `${pct}%` }} />
        </div>

        <ul className="boot-splash-steps">
          {BOOT_STEPS.map((s) => {
            const state = steps[s.id] || 'pending'
            return (
              <li key={s.id} className={`boot-step boot-step-${state}`}>
                <span className="boot-step-mark" aria-hidden="true">{MARK[state]}</span>
                <span className="boot-step-label">{s.label}</span>
                {state === 'skipped' && <span className="boot-step-aside">skipped</span>}
                {state === 'failed' && <span className="boot-step-aside">couldn’t finish</span>}
              </li>
            )
          })}
        </ul>

        {note && <div className="boot-splash-note">{note}</div>}
      </div>
    </div>
  )
}
