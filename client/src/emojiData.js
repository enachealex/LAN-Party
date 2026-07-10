// Curated default emoji set for the picker.
// Emojis that support skin tones are listed by their base (no modifier); the five
// Fitzpatrick modifiers are appended at render time. `tone: true` marks those.

export const SKIN_TONES = [
  { key: 'default', label: 'Default', modifier: '' },
  { key: 'light', label: 'Light', modifier: '\u{1F3FB}' },
  { key: 'medium-light', label: 'Medium-Light', modifier: '\u{1F3FC}' },
  { key: 'medium', label: 'Medium', modifier: '\u{1F3FD}' },
  { key: 'medium-dark', label: 'Medium-Dark', modifier: '\u{1F3FE}' },
  { key: 'dark', label: 'Dark', modifier: '\u{1F3FF}' },
]

// Apply a Fitzpatrick modifier to a base emoji. For emoji that use ZWJ sequences or
// a VS16 (️) presentation selector, the modifier must follow the base scalar and
// replace the VS16. This covers the common single-codepoint + VS16 cases in our set.
export function applySkinTone(base, modifier) {
  if (!modifier) return base
  // Insert the modifier right after the first emoji scalar, dropping a trailing VS16.
  const chars = Array.from(base)
  if (chars.length === 0) return base
  let out = chars[0]
  let rest = chars.slice(1)
  if (rest[0] === '️') rest = rest.slice(1) // drop variation selector
  return out + modifier + rest.join('')
}

export const EMOJI_GROUPS = [
  {
    name: 'Smileys & People',
    emojis: [
      { e: '😀' }, { e: '😃' }, { e: '😄' }, { e: '😁' }, { e: '😆' }, { e: '😅' },
      { e: '🤣' }, { e: '😂' }, { e: '🙂' }, { e: '🙃' }, { e: '😉' }, { e: '😊' },
      { e: '😇' }, { e: '🥰' }, { e: '😍' }, { e: '🤩' }, { e: '😘' }, { e: '😗' },
      { e: '😚' }, { e: '😋' }, { e: '😛' }, { e: '😜' }, { e: '🤪' }, { e: '😝' },
      { e: '🤗' }, { e: '🤔' }, { e: '🤨' }, { e: '😐' }, { e: '😑' }, { e: '😶' },
      { e: '😏' }, { e: '😒' }, { e: '🙄' }, { e: '😬' }, { e: '😌' }, { e: '😔' },
      { e: '😪' }, { e: '😴' }, { e: '😷' }, { e: '🤒' }, { e: '🤕' }, { e: '🥳' },
      { e: '😎' }, { e: '🤓' }, { e: '😕' }, { e: '😟' }, { e: '😢' }, { e: '😭' },
      { e: '😤' }, { e: '😠' }, { e: '😡' }, { e: '🤯' }, { e: '😳' }, { e: '🥺' },
    ],
  },
  {
    name: 'Gestures & Body',
    emojis: [
      { e: '👍', tone: true }, { e: '👎', tone: true }, { e: '👌', tone: true },
      { e: '✌️', tone: true }, { e: '🤞', tone: true }, { e: '🤟', tone: true },
      { e: '🤘', tone: true }, { e: '🤙', tone: true }, { e: '👈', tone: true },
      { e: '👉', tone: true }, { e: '👆', tone: true }, { e: '👇', tone: true },
      { e: '☝️', tone: true }, { e: '✋', tone: true }, { e: '🤚', tone: true },
      { e: '🖐️', tone: true }, { e: '🖖', tone: true }, { e: '👋', tone: true },
      { e: '🤝' }, { e: '👏', tone: true }, { e: '🙌', tone: true },
      { e: '🙏', tone: true }, { e: '✍️', tone: true }, { e: '💪', tone: true },
      { e: '🤛', tone: true }, { e: '🤜', tone: true }, { e: '✊', tone: true },
      { e: '👊', tone: true },
    ],
  },
  {
    name: 'People',
    emojis: [
      { e: '👶', tone: true }, { e: '🧒', tone: true }, { e: '👦', tone: true },
      { e: '👧', tone: true }, { e: '🧑', tone: true }, { e: '👨', tone: true },
      { e: '👩', tone: true }, { e: '🧓', tone: true }, { e: '👴', tone: true },
      { e: '👵', tone: true }, { e: '🙇', tone: true }, { e: '🤦', tone: true },
      { e: '🤷', tone: true }, { e: '👮', tone: true }, { e: '🕵️', tone: true },
      { e: '💂', tone: true }, { e: '👷', tone: true }, { e: '🤴', tone: true },
      { e: '👸', tone: true }, { e: '🧑‍🚀', tone: true }, { e: '🦸', tone: true },
      { e: '🦹', tone: true }, { e: '🧙', tone: true }, { e: '🚶', tone: true },
      { e: '🏃', tone: true }, { e: '💃', tone: true }, { e: '🕺', tone: true },
    ],
  },
  {
    name: 'Animals & Nature',
    emojis: [
      { e: '🐶' }, { e: '🐱' }, { e: '🐭' }, { e: '🐹' }, { e: '🐰' }, { e: '🦊' },
      { e: '🐻' }, { e: '🐼' }, { e: '🐨' }, { e: '🐯' }, { e: '🦁' }, { e: '🐮' },
      { e: '🐷' }, { e: '🐸' }, { e: '🐵' }, { e: '🐔' }, { e: '🐧' }, { e: '🐦' },
      { e: '🦆' }, { e: '🦉' }, { e: '🐴' }, { e: '🦄' }, { e: '🐝' }, { e: '🦋' },
      { e: '🐢' }, { e: '🐍' }, { e: '🐙' }, { e: '🐳' }, { e: '🐬' }, { e: '🐟' },
      { e: '🌸' }, { e: '🌻' }, { e: '🌹' }, { e: '🌳' }, { e: '🌵' }, { e: '🍀' },
    ],
  },
  {
    name: 'Food & Drink',
    emojis: [
      { e: '🍏' }, { e: '🍎' }, { e: '🍐' }, { e: '🍊' }, { e: '🍋' }, { e: '🍌' },
      { e: '🍉' }, { e: '🍇' }, { e: '🍓' }, { e: '🫐' }, { e: '🍒' }, { e: '🍑' },
      { e: '🥭' }, { e: '🍍' }, { e: '🥥' }, { e: '🥝' }, { e: '🍅' }, { e: '🍆' },
      { e: '🥑' }, { e: '🌽' }, { e: '🌶️' }, { e: '🍕' }, { e: '🍔' }, { e: '🍟' },
      { e: '🌭' }, { e: '🍿' }, { e: '🍩' }, { e: '🍪' }, { e: '🎂' }, { e: '🍰' },
      { e: '☕' }, { e: '🍺' }, { e: '🍻' }, { e: '🥂' }, { e: '🍷' }, { e: '🍸' },
    ],
  },
  {
    name: 'Activities & Objects',
    emojis: [
      { e: '⚽' }, { e: '🏀' }, { e: '🏈' }, { e: '⚾' }, { e: '🎾' }, { e: '🏐' },
      { e: '🎱' }, { e: '🏓' }, { e: '🏸' }, { e: '🥅' }, { e: '🏒' }, { e: '🎮' },
      { e: '🎲' }, { e: '🎯' }, { e: '🎸' }, { e: '🎤' }, { e: '🎧' }, { e: '🎬' },
      { e: '📱' }, { e: '💻' }, { e: '🖥️' }, { e: '⌨️' }, { e: '🖱️' }, { e: '💡' },
      { e: '🔦' }, { e: '🔋' }, { e: '💰' }, { e: '💎' }, { e: '🔑' }, { e: '🔒' },
    ],
  },
  {
    name: 'Symbols',
    emojis: [
      { e: '❤️' }, { e: '🧡' }, { e: '💛' }, { e: '💚' }, { e: '💙' }, { e: '💜' },
      { e: '🖤' }, { e: '🤍' }, { e: '🤎' }, { e: '💔' }, { e: '❣️' }, { e: '💕' },
      { e: '💞' }, { e: '💓' }, { e: '💗' }, { e: '💖' }, { e: '💘' }, { e: '⭐' },
      { e: '🌟' }, { e: '✨' }, { e: '⚡' }, { e: '🔥' }, { e: '💥' }, { e: '🎉' },
      { e: '✅' }, { e: '❌' }, { e: '❓' }, { e: '❗' }, { e: '💯' }, { e: '🚀' },
    ],
  },
]
