import { useState } from 'react'
import { LEVELS, LEVEL_LABELS, type NotificationLevel } from '../notificationLevels'

interface NotificationLevelItemsProps {
  /**
   * What this menu is for. A server has a level of its own and nothing above it. A channel either
   * has one of its own or follows its server, so it gets a fourth choice for that.
   */
  kind: 'server' | 'channel'
  /** The level set on the thing itself: for a channel, null when it follows its server. */
  own: NotificationLevel | null
  /** For a channel: what its server is set to, which is what "follow the server" means right now. */
  inherited?: NotificationLevel
  /** A level, or null for "follow the server" (a channel) / back to the default (a server). */
  onPick: (level: NotificationLevel | null) => void
}

/**
 * "Notifications ▸" in the server and channel menus: the entry, and the choices that unfold under
 * it. They unfold inside the menu rather than flying out beside it, like "Move to category" does:
 * a fly-out has nowhere to go on a phone. The entry itself says what is in force, so the answer to
 * "is this channel muted?" is one right-click away without opening anything further.
 */
export default function NotificationLevelItems({ kind, own, inherited = 'mentions', onPick }: NotificationLevelItemsProps) {
  const [open, setOpen] = useState(false)
  const inForce: NotificationLevel = own || (kind === 'channel' ? inherited : 'mentions')
  const option = (key: string, checked: boolean, label: string, level: NotificationLevel | null) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={checked} className="dc-ctx-item dc-ctx-check" onClick={() => onPick(level)}>
      <span className="dc-ctx-checkbox dc-ctx-radio" aria-hidden="true">{checked ? '●' : ''}</span>
      <span className="dc-ctx-check-label">{label}</span>
    </button>
  )
  return (
    <>
      <button type="button" role="menuitem" className="dc-ctx-item dc-ctx-notify" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <span>{inForce === 'none' ? '🔕' : '🔔'} Notifications</span>
        <span className="dc-ctx-notify-now">{LEVEL_LABELS[inForce]} <span className="dc-ctx-caret" aria-hidden="true">{open ? '▾' : '▸'}</span></span>
      </button>
      {open && (
        <div className="dc-ctx-sub dc-ctx-sub-notify" role="group" aria-label="Notifications">
          {/* A channel with no setting of its own: this is the checked one, and it names what the
              server's setting currently is, so "what will I hear?" needs no second lookup. */}
          {kind === 'channel' && option('inherit', own === null, `Same as the server (${LEVEL_LABELS[inherited]})`, null)}
          {LEVELS.map((level) => option(level, kind === 'channel' ? own === level : inForce === level, LEVEL_LABELS[level], level))}
        </div>
      )}
    </>
  )
}
