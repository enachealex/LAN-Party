// Presets, helpers and the shared types for user profile customization. This is the source of
// truth for the Profile shape — components should import these types rather than redeclaring them.
import type { CSSProperties } from 'react'

export interface ProfileBorder {
  preset?: string
  color?: string
  width?: number
  style?: string
}

export interface ProfileNameStyle {
  id?: string
  color?: string
  from?: string
  to?: string
}

export interface ProfileTag {
  type: 'server' | 'custom'
  label: string
}

// A user's display profile as stored in their settings JSON. All fields optional in storage;
// normalizeProfile() fills the gaps with defaults.
export interface Profile {
  avatarUrl?: string
  overlay?: string
  border?: ProfileBorder
  statusMessage?: string
  bio?: string
  tags?: ProfileTag[]
  nameFont?: string
  nameStyle?: ProfileNameStyle
}

// Animation overlays applied on top of the avatar.
export const AVATAR_OVERLAYS = [
  { id: 'none', label: 'None' },
  { id: 'glow', label: 'Glow' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'ring', label: 'Rotating Ring' },
  { id: 'sparkle', label: 'Sparkle' },
] as const

// Preset border frames (in addition to a fully custom border).
export const BORDER_PRESETS = [
  { id: 'none', label: 'None', color: 'transparent', width: 0, style: 'solid' },
  { id: 'gold', label: 'Gold', color: '#f5c451', width: 3, style: 'solid' },
  { id: 'neon', label: 'Neon', color: '#2bc3ff', width: 3, style: 'solid' },
  { id: 'rose', label: 'Rose', color: '#fb7185', width: 3, style: 'double' },
  { id: 'emerald', label: 'Emerald', color: '#34d399', width: 3, style: 'solid' },
  { id: 'dashed', label: 'Dashed', color: '#cbd5e1', width: 2, style: 'dashed' },
] as const

export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const

// Username font choices.
export const NAME_FONTS = [
  { id: 'default', label: 'Default', css: 'inherit' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', label: 'Mono', css: '"Courier New", monospace' },
  { id: 'rounded', label: 'Rounded', css: '"Comic Sans MS", "Segoe UI", sans-serif' },
  { id: 'condensed', label: 'Condensed', css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
] as const

// Name color styling presets. 'gradient' uses two colors; 'flashy' animates.
export interface NameStylePreset {
  id: string
  label: string
  kind: 'solid' | 'gradient' | 'flashy'
  color?: string
  from?: string
  to?: string
}

export const NAME_STYLES: NameStylePreset[] = [
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
  tags: [] as ProfileTag[],
  nameFont: 'default',
  nameStyle: { id: 'plain', color: '', from: '', to: '' },
} satisfies Profile

// Merge a stored (possibly partial) profile onto the defaults.
export function normalizeProfile(p: Profile = {}) {
  return {
    ...DEFAULT_PROFILE,
    ...p,
    border: { ...DEFAULT_PROFILE.border, ...(p.border || {}) },
    nameStyle: { ...DEFAULT_PROFILE.nameStyle, ...(p.nameStyle || {}) },
    tags: Array.isArray(p.tags) ? p.tags : [],
  }
}

// Build the inline style for a username given its profile name styling. The '--flash' custom
// property drives the rainbow animation in CSS, hence the CSSProperties cast.
export function nameStyleToCss(nameStyle?: ProfileNameStyle | null, nameFont?: string): CSSProperties {
  const font = NAME_FONTS.find((f) => f.id === nameFont)
  const base: CSSProperties = { fontFamily: font ? font.css : 'inherit' }
  if (!nameStyle) return base
  const preset = NAME_STYLES.find((s) => s.id === nameStyle.id) || NAME_STYLES[0]
  if (preset.kind === 'flashy') {
    return { ...base, '--flash': '1', backgroundImage: 'linear-gradient(90deg,#ff5f6d,#ffc371,#47e891,#2bc3ff,#a855f7,#ff5f6d)' } as CSSProperties
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
