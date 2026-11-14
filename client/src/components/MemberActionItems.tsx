interface MemberActionItemsProps {
  username: string
  /** Staff acting on someone below them in a real server: the owner on anyone, an admin on a member. */
  canModerate: boolean
  /** Whether this member is timed out in the server right now. */
  timedOut: boolean
  /** Whether the signed-in person has blocked them. */
  blocked: boolean
  /** Closes the menu these items sit in. Called before the action, as the other items do. */
  onDone: () => void
  onTimeout?: (username: string) => void
  onLiftTimeout?: (username: string) => void
  onBan?: (username: string) => void
  onBlock?: (username: string) => void
  onUnblock?: (username: string) => void
}

/**
 * The entries a member's right-click menu gains for moderation and blocking. There are two such
 * menus (the server's member list in AppLeftPane, and the members panel in App.jsx); both render
 * this, so the two cannot drift apart.
 *
 * Time out and Ban sit next to "Remove from server" and are for staff. The "…" on them is a
 * promise that nothing happens yet: each opens a dialog first. Block is for everyone.
 * What these offer is only what to show; the server decides who may do what.
 */
export default function MemberActionItems({ username, canModerate, timedOut, blocked, onDone, onTimeout, onLiftTimeout, onBan, onBlock, onUnblock }: MemberActionItemsProps) {
  const run = (action?: (username: string) => void) => () => { onDone(); action?.(username) }
  return (
    <>
      {canModerate && (timedOut
        ? <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onLiftTimeout)}>⏳ Remove time out</button>
        : <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onTimeout)}>⏳ Time out…</button>)}
      {canModerate && (
        <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={run(onBan)}>⛔ Ban…</button>
      )}
      <div className="dc-ctx-sep" role="separator" />
      {blocked
        ? <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onUnblock)}>Unblock</button>
        : <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={run(onBlock)}>🙅 Block</button>}
    </>
  )
}
