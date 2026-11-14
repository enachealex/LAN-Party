import { useState, type ReactNode } from 'react'

interface BlockedMessageProps {
  /** Who wrote it. Only shown once the message is opened: the collapsed row names nobody. */
  author: string
  /** The message's id, kept on the collapsed row so "jump to message" still has somewhere to land. */
  messageId?: string | number
  /** The message as it would normally render. Not mounted until "Show" is pressed. */
  children: ReactNode
}

/**
 * A message from someone the reader has blocked, in a channel or group chat they share. The server
 * still sends it (taking it out would leave other people's replies answering nothing) and marks
 * it; this is what collapses it. "Show" opens that one message, and it can be hidden again.
 *
 * The body is not rendered while collapsed, so an image or GIF in it is not even fetched.
 */
export default function BlockedMessage({ author, messageId, children }: BlockedMessageProps) {
  const [shown, setShown] = useState(false)
  if (!shown) {
    return (
      <div className="blocked-msg" data-mid={messageId}>
        <span className="blocked-msg-label">Blocked message</span>
        <button type="button" className="blocked-msg-toggle" onClick={() => setShown(true)}>Show</button>
      </div>
    )
  }
  return (
    <div className="blocked-msg-open">
      <div className="blocked-msg">
        <span className="blocked-msg-label">Blocked message from {author}</span>
        <button type="button" className="blocked-msg-toggle" onClick={() => setShown(false)}>Hide</button>
      </div>
      {children}
    </div>
  )
}
