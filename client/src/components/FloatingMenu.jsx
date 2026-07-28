import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// A right-click menu that is never clipped by its opener. Pickers (emoji, GIF) are
// `overflow:hidden` boxes, so a menu rendered inside them gets cut off near an edge — this portals
// to <body> with position:fixed and z-index above every other layer instead.
//
// Positioning: `x`/`y` are VIEWPORT coords (e.clientX/e.clientY). After mount we measure the menu
// and flip it left/up when it would overrun the window, then clamp it inside the margin. It renders
// hidden for that first measuring pass so it never flashes at the wrong spot.
//
// `menuRef` receives the DOM node so the opener can exempt it from an outside-click close (the menu
// lives outside the opener's subtree now, so `contains()` on the opener would report false).
export default function FloatingMenu({ x, y, className, menuRef, role = 'menu', children }) {
  const elRef = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y, measured: false })

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    const maxLeft = window.innerWidth - width - margin
    const maxTop = window.innerHeight - height - margin
    // Prefer opening down-right from the cursor; flip when there isn't room.
    let left = x + width + margin > window.innerWidth ? x - width : x
    let top = y + height + margin > window.innerHeight ? y - height : y
    left = Math.max(margin, Math.min(left, Math.max(margin, maxLeft)))
    top = Math.max(margin, Math.min(top, Math.max(margin, maxTop)))
    setPos({ left, top, measured: true })
  }, [x, y, children])

  return createPortal(
    <div
      ref={(el) => { elRef.current = el; if (menuRef) menuRef.current = el }}
      className={className}
      role={role}
      style={{ left: pos.left, top: pos.top, visibility: pos.measured ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}
