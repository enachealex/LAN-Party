import type { CSSProperties } from 'react'
import { resolveBorder, type Profile } from '../profileData'

interface ProfileAvatarProps {
  name?: string
  profile?: Profile
  /** Pixel diameter of the avatar. */
  size?: number
  /** Background behind the fallback initial. */
  color?: string
  /** Makes relative /uploads urls absolute. */
  resolveSrc?: (url: string) => string
}

// Renders a user avatar with optional uploaded image, border decoration, and an
// animated overlay. Falls back to the name initial.
export default function ProfileAvatar({ name = '?', profile = {}, size = 56, color = 'var(--left-tile-bg)', resolveSrc = (u) => u }: ProfileAvatarProps) {
  const initial = (name || '?').slice(0, 1).toUpperCase()
  const overlay = profile.overlay && profile.overlay !== 'none' ? profile.overlay : null

  // Resolve border: a preset (optionally re-tinted), or fully custom values.
  const { color: borderColor, width: borderWidth, style: borderStyle } = resolveBorder(profile.border)

  const src = profile.avatarUrl ? resolveSrc(profile.avatarUrl) : ''

  // `--pfp-fx` colours the animated overlay; the CSS falls back to the theme accent when unset.
  const wrapStyle: CSSProperties = { width: size, height: size }
  if (profile.overlayColor) (wrapStyle as Record<string, string>)['--pfp-fx'] = profile.overlayColor
  const innerStyle: CSSProperties = {
    borderColor,
    borderWidth,
    borderStyle: borderWidth ? borderStyle : 'none',
  }

  return (
    <span className={`pfp${overlay ? ` pfp-overlay-${overlay}` : ''}`} style={wrapStyle}>
      <span className="pfp-inner" style={innerStyle}>
        {src ? (
          <img className="pfp-img" src={src} alt={name} />
        ) : (
          <span className="pfp-initial" style={{ background: color, fontSize: size * 0.4 }}>{initial}</span>
        )}
      </span>
      {overlay && <span className="pfp-fx" aria-hidden="true" />}
    </span>
  )
}
