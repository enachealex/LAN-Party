import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

// Segment coords are normalized 0..1 (relative to the image) so every participant renders
// consistently regardless of their window/canvas size.
const COLORS = ['#ff5252', '#ffb300', '#ffee58', '#66bb6a', '#29b6f6', '#7e57c2', '#ffffff', '#111111']
const SIZES = [{ id: 'S', v: 0.004 }, { id: 'M', v: 0.008 }, { id: 'L', v: 0.016 }]

// Shared image-annotation surface. Local strokes call onStroke(segment); incoming remote strokes
// are drawn via the imperative handle (drawSegment / clearCanvas / loadSegments).
const CollabCanvas = forwardRef(function CollabCanvas({ imageUrl, onStroke, onClear, onClose, onSave }, ref) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const drawingRef = useRef(false)
  const lastRef = useRef(null)
  const [color, setColor] = useState('#ff5252')
  const [size, setSize] = useState(SIZES[1].v)
  const [tool, setTool] = useState('pen') // 'pen' | 'eraser'
  const [saving, setSaving] = useState(false)

  // Flatten the image + annotations into a PNG and hand it up to be uploaded/posted.
  const handleSave = async () => {
    const img = imgRef.current, canvas = canvasRef.current
    if (!img || !canvas || !onSave) return
    const w = img.naturalWidth || canvas.width
    const h = img.naturalHeight || canvas.height
    const out = document.createElement('canvas')
    out.width = w; out.height = h
    const octx = out.getContext('2d')
    try {
      octx.drawImage(img, 0, 0, w, h)
      octx.drawImage(canvas, 0, 0, w, h) // annotations (normalized) scale onto the image
      setSaving(true)
      const blob = await new Promise((res) => out.toBlob(res, 'image/png'))
      if (blob) await onSave(blob)
    } catch (err) {
      console.warn('collab save failed', err)
    } finally {
      setSaving(false)
    }
  }

  const drawSeg = (seg) => {
    const canvas = canvasRef.current
    if (!canvas || !seg) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.globalCompositeOperation = seg.erase ? 'destination-out' : 'source-over'
    ctx.strokeStyle = seg.color || '#fff'
    ctx.lineWidth = Math.max(1, (seg.size || 0.008) * W)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(seg.from.x * W, seg.from.y * H)
    ctx.lineTo(seg.to.x * W, seg.to.y * H)
    ctx.stroke()
  }

  useImperativeHandle(ref, () => ({
    drawSegment: (seg) => drawSeg(seg),
    clearCanvas: () => {
      const c = canvasRef.current
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height)
    },
    loadSegments: (segs) => {
      const c = canvasRef.current
      if (!c) return
      c.getContext('2d').clearRect(0, 0, c.width, c.height)
      ;(segs || []).forEach(drawSeg)
    },
  }))

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const pointFromEvent = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }
  const onPointerDown = (e) => {
    e.preventDefault()
    canvasRef.current.setPointerCapture?.(e.pointerId)
    drawingRef.current = true
    lastRef.current = pointFromEvent(e)
  }
  const onPointerMove = (e) => {
    if (!drawingRef.current) return
    const cur = pointFromEvent(e)
    const seg = { from: lastRef.current, to: cur, color, size, erase: tool === 'eraser' }
    drawSeg(seg)
    onStroke?.(seg)
    lastRef.current = cur
  }
  const endStroke = () => { drawingRef.current = false; lastRef.current = null }

  return (
    <div className="collab-overlay" onClick={onClose}>
      <div className="collab-modal" onClick={(e) => e.stopPropagation()}>
        <div className="collab-toolbar">
          <span className="collab-title">🎨 Editing together</span>
          <div className="collab-colors">
            {COLORS.map((c) => (
              <button key={c} type="button" className={`collab-color${color === c && tool === 'pen' ? ' active' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => { setColor(c); setTool('pen') }} />
            ))}
          </div>
          <div className="collab-sizes">
            {SIZES.map((s) => (
              <button key={s.id} type="button" className={`collab-size${size === s.v ? ' active' : ''}`} onClick={() => setSize(s.v)}>{s.id}</button>
            ))}
          </div>
          <button type="button" className={`collab-tool${tool === 'eraser' ? ' active' : ''}`} onClick={() => setTool((t) => (t === 'eraser' ? 'pen' : 'eraser'))} title="Eraser">Eraser</button>
          <button type="button" className="collab-tool" onClick={onClear} title="Clear all annotations">Clear</button>
          {onSave && <button type="button" className="collab-save" onClick={handleSave} disabled={saving} title="Save the edited image to the chat">{saving ? 'Saving…' : 'Save'}</button>}
          <button type="button" className="collab-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="collab-stage">
          <img ref={imgRef} className="collab-image" src={imageUrl} crossOrigin="anonymous" alt="Collaborative canvas" draggable={false} />
          <canvas
            ref={canvasRef}
            className="collab-canvas"
            width={1280}
            height={720}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerLeave={endStroke}
          />
        </div>
      </div>
    </div>
  )
})

export default CollabCanvas
