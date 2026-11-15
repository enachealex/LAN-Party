import type { MouseEvent } from 'react'

/** What the server attaches to a message for its first link (server/services/linkPreview.js). */
export interface LinkPreview {
  url: string
  title?: string
  description?: string
  siteName?: string
  /** A file on OUR server (/link-previews/…). Never the site's own address for it. */
  image?: string
}

interface LinkPreviewCardProps {
  preview: LinkPreview
  /** Turns a server-relative path into a full address (the same helper attachments use). */
  resolveSrc: (path: string) => string
  /** Present for the message's author: takes the preview off the message, for everyone. */
  onRemove?: () => void
}

const OWN_IMAGE = /^\/link-previews\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/

/** The host of a link, for the line above the title when the page named no site. */
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

/** Only ever a plain web link: anything else stored there is not something to put in an href. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch { return null }
}

/**
 * The card under a message that holds a link: site, title, a few lines of description, and the
 * page's image.
 *
 * Everything in it came from a page somebody linked to, so all of it is rendered as text (React
 * escapes it; nothing here uses dangerouslySetInnerHTML), the link is only followed if it is http(s),
 * and it opens in a new tab that cannot reach back into this one. The image is loaded from our own
 * server, which fetched it once: a reader's browser never contacts the site just because someone
 * posted a link to it. Nothing plays, and nothing loads until the card is near the screen.
 */
export default function LinkPreviewCard({ preview, resolveSrc, onRemove }: LinkPreviewCardProps) {
  const href = safeHref(preview.url)
  if (!href || (!preview.title && !preview.description)) return null
  // The page chooses its own "site name", so it can claim to be anyone. The host the link really
  // goes to is always shown next to it, and it is the one part of the card the page cannot write.
  const host = hostOf(href)
  const site = preview.siteName && preview.siteName.toLowerCase() !== host.toLowerCase() ? `${preview.siteName} · ${host}` : host
  const image = preview.image && OWN_IMAGE.test(preview.image) ? resolveSrc(preview.image) : null
  // The card sits inside the message bubble, whose click toggles the timestamp.
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <div className={`link-preview${image ? ' has-image' : ''}${onRemove ? ' removable' : ''}`} onClick={stop}>
      <div className="link-preview-body">
        {site && <div className="link-preview-site">{site}</div>}
        <a className="link-preview-title" href={href} target="_blank" rel="noopener noreferrer">{preview.title || href}</a>
        {preview.description && <div className="link-preview-desc">{preview.description}</div>}
      </div>
      {image && <img className="link-preview-image" src={image} alt="" loading="lazy" decoding="async" draggable={false} />}
      {onRemove && (
        <button type="button" className="link-preview-remove" title="Remove this preview for everyone" aria-label="Remove link preview" onClick={(e) => { e.stopPropagation(); onRemove() }}>✕</button>
      )}
    </div>
  )
}
