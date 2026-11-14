import { formatMoment, type BlockedPerson } from '../moderation'

interface BlockedPeopleSectionProps {
  blocked: BlockedPerson[]
  onUnblock: (username: string) => void
  /** Open the conversation with them. It stays readable while they are blocked; nothing new arrives. */
  onOpenMessages: (person: BlockedPerson) => void
}

/**
 * Settings → Messages → "Blocked people": everyone the signed-in person has blocked, with Unblock.
 * The list is the server's (GET /blocks); this only shows it.
 */
export default function BlockedPeopleSection({ blocked, onUnblock, onOpenMessages }: BlockedPeopleSectionProps) {
  return (
    <div className="profile-settings-section">
      <h3 className="profile-settings-section-title">Blocked people</h3>
      <p className="profile-settings-note">
        Someone you block can’t message you, call you, send you a friend request or add you to a group chat, and you
        can’t do those to them until you unblock them. In servers and group chats you share, their messages are
        collapsed and never notify you. They are not told.
      </p>
      {blocked.length === 0 ? (
        <p className="profile-settings-note">You haven’t blocked anyone. Right-click a member, or open their profile, to block them.</p>
      ) : (
        <ul className="blocked-list">
          {blocked.map((person) => (
            <li key={person.username} className="blocked-row">
              <div className="mod-row-text">
                <span className="blocked-row-name">{person.username}</span>
                <span className="mod-row-meta">Blocked {formatMoment(person.blockedAt, Date.now(), true)}</span>
              </div>
              <div className="blocked-row-actions">
                <button type="button" className="feedback-btn ghost" onClick={() => onOpenMessages(person)}>Messages</button>
                <button type="button" className="feedback-btn primary" onClick={() => onUnblock(person.username)}>Unblock</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
