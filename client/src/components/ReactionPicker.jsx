import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { EMOJI_GROUPS, SKIN_TONES, applySkinTone } from '../emojiData'

export const REACTION_PICKER_W = 320
export const REACTION_PICKER_H = 300

// Full-library emoji popover for picking a message reaction (Teams-style "more reactions"),
// also used in Settings to customize the quick-reaction defaults. Rendered as a fixed-position
// portal at `pos` ({ left, top }, pre-clamped by the opener); closes on outside click / Esc.
// Tone-capable emojis honor the user's saved per-emoji skin tone.
export default function ReactionPicker({ pos, skinTones = {}, onPick, onClose }) {
  const rootRef = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose?.()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const tonedEmoji = (item) => {
    if (!item.tone) return item.e
    const toneKey = skinTones[item.e] || 'default'
    const tone = SKIN_TONES.find((t) => t.key === toneKey) || SKIN_TONES[0]
    return applySkinTone(item.e, tone.modifier)
  }

  return createPortal(
    <div className="reaction-picker" ref={rootRef} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Pick a reaction">
      <div className="emoji-picker-scroll">
        {EMOJI_GROUPS.map((group) => (
          <div className="emoji-group" key={group.name}>
            <div className="emoji-group-header"><span>{group.name}</span></div>
            <div className="emoji-grid">
              {group.emojis.map((item) => {
                const emoji = tonedEmoji(item)
                return (
                  <button
                    key={item.e}
                    type="button"
                    className="emoji-cell"
                    onClick={() => onPick?.(emoji)}
                    aria-label={`React with ${emoji}`}
                  >
                    {emoji}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
