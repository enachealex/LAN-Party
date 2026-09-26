// The screen-share picker page. Lists what the main process can capture, refreshes the previews
// every few seconds (so a window opened after the picker still turns up), and reports the choice.
// Names are window titles from other apps, so they only ever go in through textContent.
const REFRESH_MS = 3000

const grid = document.getElementById('grid')
const shareBtn = document.getElementById('share')
const tabs = [...document.querySelectorAll('[role="tab"]')]

let sources = []
let kind = 'screen'
let selected = null
let done = false
const tiles = new Map() // id -> tile element, kept across refreshes so focus and hover survive

function makeTile(source) {
  const tile = document.createElement('button')
  tile.type = 'button'
  tile.className = 'tile'
  tile.setAttribute('role', 'option')
  tile.dataset.id = source.id
  const shot = document.createElement('div')
  shot.className = 'shot'
  const img = document.createElement('img')
  img.alt = ''
  shot.append(img)
  const label = document.createElement('div')
  label.className = 'label'
  const icon = document.createElement('img')
  icon.alt = ''
  const name = document.createElement('span')
  label.append(icon, name)
  tile.append(shot, label)
  tile.addEventListener('click', () => { selected = source.id; render() })
  tile.addEventListener('dblclick', () => { selected = source.id; share() })
  return tile
}

function updateTile(tile, source) {
  const [img] = tile.querySelector('.shot').children
  if (source.thumbnail) { if (img.src !== source.thumbnail) img.src = source.thumbnail; img.hidden = false } else img.hidden = true
  const icon = tile.querySelector('.label img')
  if (source.icon) { if (icon.src !== source.icon) icon.src = source.icon; icon.hidden = false } else icon.hidden = true
  const name = tile.querySelector('.label span')
  name.textContent = source.name
  name.title = source.name
  tile.setAttribute('aria-label', source.name)
  tile.setAttribute('aria-selected', String(source.id === selected))
}

function render() {
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.kind === kind))
    tab.querySelector('.count').textContent = String(sources.filter((s) => s.kind === tab.dataset.kind).length)
  }
  const shown = sources.filter((s) => s.kind === kind)
  const ids = new Set(sources.map((s) => s.id))
  for (const [id, tile] of tiles) if (!ids.has(id)) { tile.remove(); tiles.delete(id) }
  const children = shown.map((source) => {
    let tile = tiles.get(source.id)
    if (!tile) { tile = makeTile(source); tiles.set(source.id, tile) }
    updateTile(tile, source)
    return tile
  })
  if (children.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = kind === 'screen' ? 'No screens found.' : 'No app windows to share. Open the one you want and it will show up here.'
    children.push(empty)
  }
  // Only touch the DOM order when it changed, so a focused tile keeps its focus.
  const current = [...grid.children]
  if (current.length !== children.length || current.some((el, i) => el !== children[i])) grid.replaceChildren(...children)
  shareBtn.disabled = !ids.has(selected)
}

async function refresh() {
  if (done) return
  try {
    sources = await window.picker.sources()
  } catch (_) {
    return // the window is closing
  }
  if (selected && !sources.some((s) => s.id === selected)) selected = null
  render()
}

function share() {
  if (done || !selected) return
  done = true
  window.picker.choose(selected)
}

function cancel() {
  if (done) return
  done = true
  window.picker.cancel()
}

for (const tab of tabs) tab.addEventListener('click', () => { kind = tab.dataset.kind; render() })
shareBtn.addEventListener('click', share)
document.getElementById('cancel').addEventListener('click', cancel)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancel() }
  else if (e.key === 'Enter') {
    // Enter on a tile shares it; on a tab or Cancel it does what that button does.
    const target = e.target instanceof Element ? e.target : null
    if (target && (target.closest('[role="tab"]') || target.id === 'cancel')) return
    const tile = target && target.closest('.tile')
    if (tile) { e.preventDefault(); selected = tile.dataset.id; share() }
    else if (selected) { e.preventDefault(); share() }
  }
})

refresh()
setInterval(refresh, REFRESH_MS)
