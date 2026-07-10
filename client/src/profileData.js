// Presets and helpers for user profile customization.

// Animation overlays applied on top of the avatar.
export const AVATAR_OVERLAYS = [
  { id: 'none', label: 'None' },
  { id: 'glow', label: 'Glow' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'ring', label: 'Rotating Ring' },
  { id: 'sparkle', label: 'Sparkle' },
]

// Preset border frames (in addition to a fully custom border).
export const BORDER_PRESETS = [
  { id: 'none', label: 'None', color: 'transparent', width: 0, style: 'solid' },
  { id: 'gold', label: 'Gold', color: '#f5c451', width: 3, style: 'solid' },
  { id: 'neon', label: 'Neon', color: '#2bc3ff', width: 3, style: 'solid' },
  { id: 'rose', label: 'Rose', color: '#fb7185', width: 3, style: 'double' },
  { id: 'emerald', label: 'Emerald', color: '#34d399', width: 3, style: 'solid' },
  { id: 'dashed', label: 'Dashed', color: '#cbd5e1', width: 2, style: 'dashed' },
]

export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double']

// Username font choices.
export const NAME_FONTS = [
  { id: 'default', label: 'Default', css: 'inherit' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', css: '"Courier New", monospace' },
  { id: 'rounded', label: 'Rounded', css: '"Comic Sans MS", "Segoe UI", sans-serif' },
  { id: 'condensed', label: 'Condensed', css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
]

// Name color styling presets. 'gradient' uses two colors; 'flashy' animates.
export const NAME_STYLES = [
  { id: 'plain', label: 'Plain', kind: 'solid' },
  { id: 'gradient', label: 'Gradient', kind: 'gradient', from: '#2bc3ff', to: '#a855f7' },
  { id: 'fire', label: 'Fire', kind: 'gradient', from: '#fbbf24', to: '#ef4444' },
  { id: 'rainbow', label: 'Rainbow', kind: 'flashy' },
  { id: 'gold', label: 'Gold', kind: 'solid', color: '#f5c451' },
  { id: 'cyber', label: 'Cyber', kind: 'gradient', from: '#22d3ee', to: '#34d399' },
]

// The default/empty profile.
export const DEFAULT_PROFILE = {
  avatarUrl: '',
  overlay: 'none',
  border: { preset: 'none', color: '#f5c451', width: 3, style: 'solid' },
  statusMessage: '',
  bio: '',
  tags: [],          // [{ type:'server'|'custom', label }]
  nameFont: 'default',
  nameStyle: { id: 'plain', color: '', from: '', to: '' },
}

// Merge a stored (possibly partial) profile onto the defaults.
export function normalizeProfile(p = {}) {
  return {
    ...DEFAULT_PROFILE,
    ...p,
    border: { ...DEFAULT_PROFILE.border, ...(p.border || {}) },
    nameStyle: { ...DEFAULT_PROFILE.nameStyle, ...(p.nameStyle || {}) },
    tags: Array.isArray(p.tags) ? p.tags : [],
  }
}

// Build the inline style for a username given its profile name styling.
export function nameStyleToCss(nameStyle, nameFont) {
  const font = NAME_FONTS.find((f) => f.id === nameFont)
  const base = { fontFamily: font ? font.css : 'inherit' }
  if (!nameStyle) return base
  const preset = NAME_STYLES.find((s) => s.id === nameStyle.id) || NAME_STYLES[0]
  if (preset.kind === 'flashy') {
    return { ...base, '--flash': '1', backgroundImage: 'linear-gradient(90deg,#ff5f6d,#ffc371,#47e891,#2bc3ff,#a855f7,#ff5f6d)' }
  }
  if (preset.kind === 'gradient') {
    const from = nameStyle.from || preset.from
    const to = nameStyle.to || preset.to
    return { ...base, backgroundImage: `linear-gradient(90deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextFillColor: 'transparent' }
  }
  // solid
  const color = nameStyle.color || preset.color
  return color ? { ...base, color } : base
}
