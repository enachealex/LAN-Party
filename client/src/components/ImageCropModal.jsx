import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Square-crop picker for tile images. Pan by dragging, zoom with the wheel/slider/pinch, then confirm
 * to get back a cropped, re-encoded square image.
 *
 * The crop happens entirely in the browser and only the RESULT is uploaded: a 12MP phone photo leaves
 * here as a ~20KB square. That caps what the server ever stores no matter what the user picks, and it
 * means the server needs no image library at all (adding a native dep like sharp would have to survive
 * a deploy that doesn't reinstall server dependencies).
 *
 * Output is WebP, falling back to PNG where toBlob can't produce WebP (older Safari).
 */

// Rail tiles render at 48px, and the in-voice tile is larger; 192 covers both at 4x device pixel
// ratio without storing anything bigger than it needs to be.
const OUTPUT_PX = 192
const MIN_SCALE = 1
const MAX_SCALE = 6

/**
 * Encode a canvas as WebP, or PNG where WebP isn't supported.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    const done = (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image')))
    canvas.toBlob((blob) => {
      // A browser that can't do WebP hands back a PNG (or null) instead — check what we actually got.
      if (blob && blob.type === 'image/webp') return done(blob)
      canvas.toBlob(done, 'image/png')
    }, 'image/webp', 0.9)
  })
}

export default function ImageCropModal({ open, file, title = 'Crop image', onCancel, onConfirm }) {
  const [img, setImg] = useState(null)          // the loaded HTMLImageElement
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 }) // crop-box-relative, in CSS px
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const frameRef = useRef(null)
  const dragRef = useRef(null) // { pointerId, startX, startY, originX, originY }

  // Load the chosen file into an <img>. The object URL is revoked on teardown so a big pick doesn't
  // sit in memory after the modal closes.
  useEffect(() => {
    if (!open || !file) { setImg(null); return undefined }
    setError(null)
    setScale(1)
    setOffset({ x: 0, y: 0 })
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => setImg(image)
    image.onerror = () => setError("That file couldn't be read as an image.")
    image.src = url
    return () => { URL.revokeObjectURL(url); image.onload = null; image.onerror = null }
  }, [open, file])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  // Size of the crop frame on screen, and the "cover" size of the image inside it at scale 1.
  const frameSize = frameRef.current ? frameRef.current.clientWidth : 280
  const cover = img
    ? (() => {
        const ratio = Math.max(frameSize / img.naturalWidth, frameSize / img.naturalHeight)
        return { w: img.naturalWidth * ratio, h: img.naturalHeight * ratio }
      })()
    : { w: frameSize, h: frameSize }

  // Keep the frame covered: the image can never be dragged far enough to expose an empty corner.
  const clampOffset = useCallback((next, atScale) => {
    const maxX = Math.max(0, (cover.w * atScale - frameSize) / 2)
    const maxY = Math.max(0, (cover.h * atScale - frameSize) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    }
  }, [cover.w, cover.h, frameSize])

  useEffect(() => { setOffset((o) => clampOffset(o, scale)) }, [scale, clampOffset])

  const onPointerDown = (e) => {
    if (!img) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: offset.x, originY: offset.y }
  }
  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setOffset(clampOffset({ x: d.originX + (e.clientX - d.startX), y: d.originY + (e.clientY - d.startY) }, scale))
  }
  const endDrag = (e) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) dragRef.current = null
  }
  const onWheel = (e) => {
    if (!img) return
    e.preventDefault()
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))
  }

  // Draw the visible square at output resolution and hand back the encoded blob.
  const confirm = async () => {
    if (!img || busy) return
    setBusy(true)
    setError(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUTPUT_PX
      canvas.height = OUTPUT_PX
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable')
      ctx.imageSmoothingQuality = 'high'
      // Screen -> output scale factor. The drawn image is centred in the frame, then shifted by the
      // pan offset; multiplying every on-screen length by this ratio reproduces exactly what's framed.
      const k = OUTPUT_PX / frameSize
      const drawW = cover.w * scale * k
      const drawH = cover.h * scale * k
      const drawX = (OUTPUT_PX - drawW) / 2 + offset.x * k
      const drawY = (OUTPUT_PX - drawH) / 2 + offset.y * k
      ctx.drawImage(img, drawX, drawY, drawW, drawH)
      const blob = await canvasToBlob(canvas)
      const ext = blob.type === 'image/webp' ? 'webp' : 'png'
      await onConfirm?.(new File([blob], `tile.${ext}`, { type: blob.type }))
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not crop that image.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="auth-overlay open" onClick={onCancel} />
      <div className="auth-modal crop-modal open" role="dialog" aria-modal="true" aria-label={title}>
        <div className="crop-modal-inner">
          <div className="crop-modal-head">
            <div className="crop-modal-title">{title}</div>
            <button type="button" className="crop-modal-close" onClick={onCancel} aria-label="Close">✕</button>
          </div>

          <div
            ref={frameRef}
            className="crop-frame"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={onWheel}
          >
            {img ? (
              <img
                className="crop-frame-img"
                src={img.src}
                alt=""
                draggable={false}
                style={{
                  width: cover.w * scale,
                  height: cover.h * scale,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }}
              />
            ) : (
              <div className="crop-frame-empty">{error ? 'Nothing to crop' : 'Loading…'}</div>
            )}
          </div>

          <label className="crop-zoom">
            <span>Zoom</span>
            <input
              type="range"
              min={MIN_SCALE}
              max={MAX_SCALE}
              step="0.01"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              disabled={!img}
              aria-label="Zoom"
            />
          </label>

          <div className="crop-modal-hint">Drag to reposition. The square is what appears on the tile.</div>
          {error && <div className="crop-modal-error">{error}</div>}

          <div className="crop-modal-actions">
            <button type="button" className="crop-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" className="crop-btn-save" onClick={confirm} disabled={!img || busy}>
              {busy ? 'Saving…' : 'Use this image'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
