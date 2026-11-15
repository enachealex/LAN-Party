// "Show link previews": whether the cards under messages are drawn on this device, for the person
// signed in on it. On unless switched off.
//
// It lives in localStorage rather than in the account's settings on purpose. It is about what one
// screen shows (someone may want the cards on a desktop and not on a phone), and it changes nothing
// for anybody else: the server attaches previews either way, and removing one from a message for
// everyone is the author's ✕ on the card, not this.

const keyFor = (username: string) => `lanparty_link_previews:${username || 'guest'}`

export function readShowLinkPreviews(username: string): boolean {
  try { return localStorage.getItem(keyFor(username)) !== '0' } catch { return true }
}

export function writeShowLinkPreviews(username: string, show: boolean): void {
  try {
    if (show) localStorage.removeItem(keyFor(username))
    else localStorage.setItem(keyFor(username), '0')
  } catch { /* private mode: it just is not remembered */ }
}
