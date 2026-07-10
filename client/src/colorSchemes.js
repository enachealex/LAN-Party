// Preset color schemes for the Appearance settings.
// Each scheme fully defines the 8 themeable colors; selecting one applies them all.

export const COLOR_SCHEMES = [
  {
    id: 'crimson',
    name: 'Crimson',
    colors: { railColor: '#7a0d0d', sidebarColor: '#0f1418', panelColor: '#111417', headerColor: '#7a0d0d', accentStart: '#2bc3ff', accentEnd: '#0b86ff', fontColor: '#edf6ff', leftTileColor: '#1f2933' },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    colors: { railColor: '#1e1f22', sidebarColor: '#0e1014', panelColor: '#111317', headerColor: '#1b1d24', accentStart: '#7c5cff', accentEnd: '#4b3bff', fontColor: '#e8ecff', leftTileColor: '#1c1f27' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    colors: { railColor: '#0a2c3d', sidebarColor: '#0a1620', panelColor: '#0c1a26', headerColor: '#0d3a52', accentStart: '#22d3ee', accentEnd: '#0ea5e9', fontColor: '#e4f6ff', leftTileColor: '#13303f' },
  },
  {
    id: 'forest',
    name: 'Forest',
    colors: { railColor: '#14361f', sidebarColor: '#0d150f', panelColor: '#0f1a12', headerColor: '#1a4427', accentStart: '#34d399', accentEnd: '#10b981', fontColor: '#e7fbef', leftTileColor: '#1b3324' },
  },
  {
    id: 'grape',
    name: 'Grape',
    colors: { railColor: '#3b1257', sidebarColor: '#140c1c', panelColor: '#191022', headerColor: '#4a1a6b', accentStart: '#e879f9', accentEnd: '#a855f7', fontColor: '#f6eaff', leftTileColor: '#2a1c38' },
  },
  {
    id: 'ember',
    name: 'Ember',
    colors: { railColor: '#5c2a06', sidebarColor: '#19110a', panelColor: '#1f140b', headerColor: '#7a3a0c', accentStart: '#fbbf24', accentEnd: '#f97316', fontColor: '#fff3e6', leftTileColor: '#33220f' },
  },
  {
    id: 'mono',
    name: 'Mono',
    colors: { railColor: '#202020', sidebarColor: '#0e0e0e', panelColor: '#141414', headerColor: '#262626', accentStart: '#d4d4d4', accentEnd: '#9ca3af', fontColor: '#f4f4f5', leftTileColor: '#262626' },
  },
  {
    id: 'rose',
    name: 'Rose',
    colors: { railColor: '#7a1138', sidebarColor: '#161013', panelColor: '#1a0e14', headerColor: '#9d164b', accentStart: '#fb7185', accentEnd: '#f43f5e', fontColor: '#ffe9ef', leftTileColor: '#311823' },
  },
]

export const DEFAULT_SCHEME_ID = 'crimson'

// Find which scheme a settings object matches (by comparing the color keys), or null.
export function matchSchemeId(settings) {
  if (!settings) return null
  const match = COLOR_SCHEMES.find((s) =>
    Object.entries(s.colors).every(([k, v]) => (settings[k] || '').toLowerCase() === v.toLowerCase())
  )
  return match ? match.id : null
}
