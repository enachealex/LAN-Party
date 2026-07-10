import React from 'react'
import { BORDER_PRESETS } from '../profileData'

// Renders a user avatar with optional uploaded image, border decoration, and an
// animated overlay. Falls back to the name initial. `resolveSrc` makes relative
// /uploads urls absolute. `size` is the pixel diameter.
export default function ProfileAvatar({ name = '?', profile = {}, size = 56, color = 'var(--left-tile-bg)', resolveSrc = (u) => u }) {
  const initial = (name || '?').slice(0, 1).toUpperCase()
  const overlay = profile.overlay && profile.overlay !== 'none' ? profile.overlay : null

  // Resolve border: a preset, or custom values.
  const b = profile.border || {}
  const presetDef = BORDER_PRESETS.find((p) => p.id === b.preset)
  const usePreset = b.preset && b.preset !== 'custom' && presetDef
  const borderColor = usePreset ? presetDef.color : (b.color || 'transparent')
  const borderWidth = usePreset ? presetDef.width : (Number(b.width) || 0)
  const borderStyle = usePreset ? presetDef.style : (b.style || 'solid')

  const src = profile.avatarUrl ? resolveSrc(profile.avatarUrl) : ''

  const wrapStyle = { width: size, height: size }
  const innerStyle = {
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
