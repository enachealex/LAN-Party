// Touch equivalent of a right-click. Phones have no contextmenu gesture, so every onContextMenu
// affordance in the app (emoji skin tone, delete a custom emoji/GIF/sound, server/channel menus, DM
// menus, pinned-message menu, remove a member) is unreachable without this.
//
// Deliberately NOT a hook: most of these live inside .map() list renders where hooks are illegal.
// In-flight press state is keyed off the DOM element, so the returned handlers are pure and can be
// spread freshly on every render.
//
// The handler receives an event-like object with clientX/clientY and no-op preventDefault /
// stopPropagation, so the SAME handler serves both onContextMenu and long-press unchanged.
//
// Usage:  <button onContextMenu={openMenu} {...longPressProps(openMenu)}>

const inFlight = new WeakMap() // element -> { timer, x, y, fired }

const DEFAULTS = { ms: 450, moveTolerance: 10 }

function clearFor(el) {
  const s = inFlight.get(el)
  if (s && s.timer) { clearTimeout(s.timer); s.timer = null }
}

export default function longPressProps(handler, opts = {}) {
  if (typeof handler !== 'function') return {}
  const { ms, moveTolerance } = { ...DEFAULTS, ...opts }

  return {
    onTouchStart: (e) => {
      const touch = e.touches && e.touches[0]
      if (!touch) return
      const el = e.currentTarget
      const target = e.target
      clearFor(el)
      const state = { timer: null, x: touch.clientX, y: touch.clientY, fired: false }
      inFlight.set(el, state)
      state.timer = setTimeout(() => {
        state.timer = null
        state.fired = true
        // A short buzz confirms the press registered (no-op where unsupported).
        try { if (navigator.vibrate) navigator.vibrate(15) } catch (_) { /* ignore */ }
        handler({
          clientX: state.x,
          clientY: state.y,
          preventDefault() {},
          stopPropagation() {},
          currentTarget: el,
          target,
        })
      }, ms)
    },

    // A drag/scroll is not a long press — otherwise scrolling a grid would open menus.
    onTouchMove: (e) => {
      const touch = e.touches && e.touches[0]
      const state = inFlight.get(e.currentTarget)
      if (!touch || !state) return
      if (Math.abs(touch.clientX - state.x) > moveTolerance ||
          Math.abs(touch.clientY - state.y) > moveTolerance) clearFor(e.currentTarget)
    },

    onTouchEnd: (e) => {
      const el = e.currentTarget
      const state = inFlight.get(el)
      clearFor(el)
      // Swallow the click the browser synthesises after the touch, so a long press that already
      // opened the menu doesn't also fire onClick (selecting the emoji, playing the sound, …).
      if (state && state.fired && e.cancelable) e.preventDefault()
      inFlight.delete(el)
    },

    onTouchCancel: (e) => { clearFor(e.currentTarget); inFlight.delete(e.currentTarget) },
  }
}
