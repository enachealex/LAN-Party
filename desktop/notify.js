// The message pop-up above the taskbar clock, like Teams: who, where, what they said, and a Reply box.
// Each card lasts SHOW_MS; pointing at it, or typing a reply, holds it. Clicking it opens the
// conversation in LAN Party. The main process owns the window; this page owns the cards.
const SHOW_MS = 6000
const SENT_MS = 1400
const MAX_CARDS = 3

const stack = document.getElementById('stack')
const cards = new Map() // id -> { el, card, timer, left, startedAt, mode }

function reportSize() {
  const h = cards.size ? Math.ceil(stack.getBoundingClientRect().height) : 0
  window.notify.size(h)
}
new ResizeObserver(reportSize).observe(stack)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function remove(id, { tell = true } = {}) {
  const c = cards.get(id)
  if (!c) return
  clearTimeout(c.timer)
  c.el.remove()
  cards.delete(id)
  if (tell) window.notify.dismiss(id)
  reportSize()
}

function held(c) { return c.hovered || c.mode !== 'idle' }

function arm(c, ms) {
  clearTimeout(c.timer)
  if (held(c)) return
  c.left = ms
  c.startedAt = Date.now()
  c.timer = setTimeout(() => remove(c.card.id), ms)
}

function pause(c) {
  clearTimeout(c.timer)
  if (c.startedAt) c.left = Math.max(800, c.left - (Date.now() - c.startedAt))
  c.startedAt = 0
}

function render(c) {
  const { card } = c
  const root = c.el
  root.textContent = ''
  const app = el('div', 'app')
  app.append(el('b', null, 'LAN Party'))
  root.append(app)
  if (c.mode === 'sent') {
    root.append(el('div', 'sent', `✓ Sent to ${card.kind === 'dm' ? card.author : card.where}`))
    return
  }
  const body = el('button', 'body')
  body.type = 'button'
  body.title = 'Open the conversation'
  body.append(el('span', 'avatar', (card.author || '?').trim().charAt(0).toUpperCase() || '?'))
  const text = el('span', 'text')
  text.append(el('span', 'author', card.author), el('span', 'where', card.where), el('span', `preview${card.previewIsNote ? ' note' : ''}`, card.preview))
  body.append(text)
  body.addEventListener('click', () => { window.notify.open(card.id); remove(card.id, { tell: false }) })
  const close = el('button', 'close', '✕')
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss')
  close.addEventListener('click', () => remove(card.id))
  root.append(body, close)

  if (c.mode === 'idle') {
    const actions = el('div', 'actions')
    const reply = el('button', 'btn', 'Reply')
    reply.type = 'button'
    reply.addEventListener('click', () => { c.mode = 'reply'; pause(c); window.notify.wantFocus(); render(c) })
    actions.append(reply)
    root.append(actions)
    return
  }

  const box = el('div', 'reply')
  const input = el('textarea')
  input.rows = 1
  input.maxLength = 4000
  input.placeholder = `Reply to ${card.author}…`
  input.value = c.draft || ''
  input.disabled = c.mode === 'sending'
  const row = el('div', 'row')
  const hint = el('span', 'hint', c.mode === 'sending' ? 'Sending…' : 'Enter to send · Esc to cancel')
  const cancel = el('button', 'btn', 'Cancel')
  cancel.type = 'button'
  cancel.disabled = c.mode === 'sending'
  const send = el('button', 'btn primary', 'Send')
  send.type = 'button'
  send.disabled = c.mode === 'sending' || !input.value.trim()
  const doCancel = () => { c.mode = 'idle'; c.draft = ''; c.error = ''; render(c); arm(c, c.left || SHOW_MS) }
  const doSend = () => {
    const t = input.value.trim()
    if (!t || c.mode === 'sending') return
    c.draft = input.value
    c.mode = 'sending'
    c.error = ''
    render(c)
    window.notify.reply(card.id, t)
  }
  input.addEventListener('input', () => { c.draft = input.value; send.disabled = !input.value.trim() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend() }
    else if (e.key === 'Escape') { e.preventDefault(); doCancel() }
  })
  cancel.addEventListener('click', doCancel)
  send.addEventListener('click', doSend)
  row.append(hint, cancel, send)
  box.append(input, row)
  if (c.error) box.append(el('div', 'error', c.error))
  root.append(box)
  if (c.mode === 'reply') setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }, 0)
}

window.notify.onCard((card) => {
  if (!card || !card.id) return
  // One card per conversation: a newer message replaces the text of the one already up.
  const same = [...cards.values()].find((c) => c.card.key === card.key)
  if (same) {
    cards.delete(same.card.id)
    window.notify.dismiss(same.card.id)
    same.card = card
    cards.set(card.id, same)
    if (same.mode === 'idle' || same.mode === 'sent') { same.mode = 'idle'; render(same) }
    stack.prepend(same.el)
    arm(same, SHOW_MS)
    return
  }
  const root = el('div', 'card')
  const c = { el: root, card, timer: 0, left: SHOW_MS, startedAt: 0, mode: 'idle', hovered: false, draft: '', error: '' }
  root.addEventListener('mouseenter', () => { c.hovered = true; pause(c) })
  root.addEventListener('mouseleave', () => { c.hovered = false; arm(c, c.left || SHOW_MS) })
  cards.set(card.id, c)
  render(c)
  stack.prepend(root) // column-reverse: first child sits at the bottom, newest nearest the clock
  arm(c, SHOW_MS)
  // Past the limit, the oldest card nobody is using goes.
  if (cards.size > MAX_CARDS) {
    const oldest = [...cards.values()].reverse().find((x) => x !== c && x.mode === 'idle' && !x.hovered)
    if (oldest) remove(oldest.card.id)
  }
  reportSize()
})

window.notify.onReplyResult(({ id, ok, error } = {}) => {
  const c = cards.get(id)
  if (!c) return
  if (ok) {
    c.mode = 'sent'
    c.draft = ''
    render(c)
    clearTimeout(c.timer)
    c.timer = setTimeout(() => remove(id), SENT_MS)
  } else {
    c.mode = 'reply'
    c.error = error || 'Could not send.'
    render(c)
  }
})
