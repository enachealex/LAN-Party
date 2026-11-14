import { formatMoment, type OwnTimeout } from '../moderation'

/**
 * What stands where the message box would be when the server will not take a message from this
 * person here. Two cases, both decided by the server; the composer is replaced rather than
 * disabled so there is nothing to type into and then lose.
 */

interface TimeoutNoticeProps {
  timeout: OwnTimeout
  serverName: string
}

/** Timed out in the server on screen: until when, and why if a reason was given. */
export function TimeoutNotice({ timeout, serverName }: TimeoutNoticeProps) {
  return (
    <div className="composer-notice timeout" role="status">
      <span className="composer-notice-icon" aria-hidden="true">⏳</span>
      <div className="composer-notice-text">
        <strong>You are timed out here until {formatMoment(timeout.until)}.</strong>
        <span>
          You can still read {serverName ? `“${serverName}”` : 'this server'}, but you can’t send messages, react or join voice until then.
          {timeout.by ? ` Timed out by ${timeout.by}.` : ''}
        </span>
        {timeout.reason && <span className="composer-notice-reason">Reason: {timeout.reason}</span>}
      </div>
    </div>
  )
}

interface BlockedNoticeProps {
  username: string
  onUnblock: (username: string) => void
}

/** A direct conversation with someone the reader has blocked: readable, and closed to new messages. */
export function BlockedNotice({ username, onUnblock }: BlockedNoticeProps) {
  return (
    <div className="composer-notice blocked" role="status">
      <span className="composer-notice-icon" aria-hidden="true">🙅</span>
      <div className="composer-notice-text">
        <strong>You blocked {username}.</strong>
        <span>You can still read this conversation. Neither of you can send the other a message until you unblock them.</span>
      </div>
      <button type="button" className="feedback-btn ghost" onClick={() => onUnblock(username)}>Unblock</button>
    </div>
  )
}
