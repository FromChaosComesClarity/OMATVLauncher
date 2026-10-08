'use strict'

/*
 * The home screen. Keyboard first, mouse welcome, no gamepad.
 *
 * One focus at a time, owned by whichever layer is on top — modal, then Add
 * app, then settings, then home — and every key goes to that layer. The mouse
 * is the same focus moved by hovering, so the two never disagree about what
 * Enter would do; after a few still seconds the cursor hides, because a pointer
 * parked in the middle of a TV is a smudge on the picture.
 */

const $ = sel => document.querySelector(sel)
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const S = {
  items: [],
  caps: {},
  theme: null,
  status: null,
  tints: new Map(),
  mouse: false,
  home: { row: 0, cols: [0, 0], chip: 0, offsets: [0, 0] },
  shelves: [],
  set: null,
  cat: null,
  modal: null
}

// ── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(t) {
  if (!t) return
  S.theme = t
  const root = document.documentElement.style
  for (const k of ['foreground', 'background', 'accent', 'muted', 'urgent']) {
    root.setProperty('--' + ({ foreground: 'fg', background: 'bg' }[k] || k), t.colors[k])
  }
  const wp = $('#wallpaper')
  if (t.wallpaper) {
    // Swap only once the new image has decoded, so a theme change cross-fades
    // instead of flashing the bare background colour.
    const img = new Image()
    img.onload = () => { wp.style.backgroundImage = `url("${t.wallpaper}")` }
    img.src = t.wallpaper
  } else {
    wp.style.backgroundImage = 'none'
  }
  updateAmbient()
}

// ── Tints ───────────────────────────────────────────────────────────────────
//
// Each tile takes the colour of its own icon: the average of the icon's
// saturated, opaque pixels, read once from a 24px copy. Grey icons fall back
// to a colour from the theme's palette, picked by name so it is stable.

function paletteTint(name) {
  const pal = (S.theme && S.theme.colors.palette && S.theme.colors.palette.length) ? S.theme.colors.palette : ['#5b6ee1', '#d0605e', '#4fa37a', '#c49a4a', '#8a63c9', '#3f9fb5']
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return pal[h % pal.length]
}

function iconTint(img) {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 24
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0, 24, 24)
    const d = g.getImageData(0, 0, 24, 24).data
    let r = 0, gg = 0, b = 0, w = 0
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255
      if (a < 0.5) continue
      const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2])
      const sat = max ? (max - min) / max : 0
      const weight = a * (0.15 + sat * sat * 3) * (max > 30 ? 1 : 0.2)
      r += d[i] * weight; gg += d[i + 1] * weight; b += d[i + 2] * weight; w += weight
    }
    if (w < 4) return null
    r /= w; gg /= w; b /= w
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b)
    if (max - min < 18) return null
    // Lift dark averages so the tile reads as a colour, not as mud.
    const lift = max < 140 ? 140 / max : 1
    return `rgb(${Math.round(Math.min(255, r * lift))}, ${Math.round(Math.min(255, gg * lift))}, ${Math.round(Math.min(255, b * lift))})`
  } catch { return null }
}

function initials(label) {
  const words = String(label).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).replace(/^(.)(.)/, (m, a, b) => a.toUpperCase() + b.toLowerCase())
  return (words[0][0] + words[1][0]).toUpperCase()
}

// ── Home ────────────────────────────────────────────────────────────────────

function systemTiles() {
  const list = [
    { key: 'sys:settings', kind: 'system', label: 'Settings', sub: 'Sound, network, Bluetooth and your apps', glyph: 'settings', tint: '#5d6b7d', act: () => openSettings('sound') },
    { key: 'sys:add', kind: 'system', label: 'Add app', sub: 'Put anything installed on this machine on the home screen', glyph: 'plus', tint: '#4b7a63', act: () => openCatalog() }
  ]
  if (S.caps.omarchyMenu) list.push({ key: 'sys:omarchy', kind: 'system', label: 'Omarchy', sub: 'The system menu: themes, fonts, updates and the rest', glyph: 'menu', tint: '#6d5b86', act: () => runAction('omarchy.menu') })
  list.push({ key: 'sys:power', kind: 'system', label: 'Power', sub: 'Lock, sleep, restart or shut down', glyph: 'power', tint: '#8a4f4f', act: () => openSettings('power', true) })
  return list
}

function buildShelves() {
  const apps = S.items.filter(i => !i.hidden)
  S.shelves = [
    { id: 'apps', title: 'Apps', items: apps },
    { id: 'system', title: 'System', items: systemTiles() }
  ]
}

function tileHtml(item, shelf) {
  let art
  if (item.glyph) art = icon(item.glyph, 'glyph')
  else if (item.icon) art = `<img src="${esc(item.icon)}" alt="" draggable="false">`
  else art = `<span class="wordmark">${esc(item.label)}</span>`
  const tint = S.tints.get(item.key) || item.tint || paletteTint(item.label)
  return `<button class="tile${item.missing ? ' missing' : ''}" data-key="${esc(item.key)}" style="--tint:${tint}">
    <div class="art">${art}</div>
    <div class="tile-label">${esc(item.label)}</div>
  </button>`
}

function renderHome() {
  buildShelves()
  const host = $('#shelves')
  host.innerHTML = S.shelves.map((shelf, r) => `
    <div class="shelf ${shelf.id}" data-row="${r}">
      <div class="shelf-title">${esc(shelf.title)}</div>
      <div class="shelf-viewport">
        ${shelf.items.length
          ? `<div class="track">${shelf.items.map(it => tileHtml(it, shelf)).join('')}</div>`
          : `<div class="empty-shelf">${icon('apps')}<span>Nothing here yet. Drop an AppImage into <b>~/Applications</b>, or choose <b>Add app</b> below.</span></div>`}
      </div>
    </div>`).join('')

  host.querySelectorAll('.tile').forEach(el => {
    const key = el.dataset.key
    wireTileImage(el, key)
    el.addEventListener('mousemove', () => { if (S.mouse && topLayer() === 'home') focusTile(key) })
    el.addEventListener('click', () => { focusTile(key); activateHome() })
    el.addEventListener('contextmenu', e => { e.preventDefault(); focusTile(key); homeOptions() })
  })

  // The first shelf can be empty; never leave the focus on nothing.
  if (!S.shelves[S.home.row] || !S.shelves[S.home.row].items.length) S.home.row = S.shelves.findIndex(s => s.items.length)
  S.home.cols = S.shelves.map((s, r) => clamp(S.home.cols[r] || 0, 0, Math.max(0, s.items.length - 1)))
  S.home.offsets = S.shelves.map(() => 0)
  updateHomeFocus(true)
}

function wireTileImage(el, key) {
  const img = el.querySelector('img')
  if (!img) return
  img.addEventListener('load', () => {
    const t = iconTint(img)
    if (t) { S.tints.set(key, t); el.style.setProperty('--tint', t); if (focusedItem() && focusedItem().key === key) updateAmbient() }
  })
  img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'wordmark', textContent: itemByKey(key).label })) })
}

function itemByKey(key) {
  for (const s of S.shelves) for (const it of s.items) if (it.key === key) return it
  return S.items.find(i => i.key === key)
}

function focusedItem() {
  if (S.home.row < 0) return null
  const shelf = S.shelves[S.home.row]
  return shelf ? shelf.items[S.home.cols[S.home.row]] : null
}

function focusTile(key) {
  for (let r = 0; r < S.shelves.length; r++) {
    const c = S.shelves[r].items.findIndex(i => i.key === key)
    if (c >= 0) {
      if (S.home.row === r && S.home.cols[r] === c) return
      S.home.row = r
      S.home.cols[r] = c
      updateHomeFocus()
      return
    }
  }
}

let lastHeroKey = null
function updateHomeFocus(instant) {
  document.querySelectorAll('.tile.focus, .chip.focus').forEach(el => el.classList.remove('focus'))
  document.querySelectorAll('.shelf').forEach(el => el.classList.toggle('active', Number(el.dataset.row) === S.home.row))

  if (S.home.row === -1) {
    const chips = document.querySelectorAll('#status .chip')
    if (chips[S.home.chip]) chips[S.home.chip].classList.add('focus')
  }

  const item = focusedItem()
  if (item) {
    const el = document.querySelector(`.tile[data-key="${CSS.escape(item.key)}"]`)
    if (el) el.classList.add('focus')
    scrollShelf(S.home.row, instant)
  }

  const shown = item
  if (shown && shown.key !== lastHeroKey) {
    lastHeroKey = shown.key
    const hero = $('#hero')
    hero.classList.remove('swap')
    void hero.offsetWidth
    hero.classList.add('swap')
    $('#hero-kind').textContent = shown.kind === 'appimage' ? 'AppImage' : shown.kind === 'desktop' ? 'Pinned app' : 'System'
    $('#hero-title').textContent = shown.label
    $('#hero-sub').textContent = shown.missing ? 'No longer installed — remove it with Del' : (shown.sub || '')
  } else if (!S.shelves.some(s => s.items.length)) {
    $('#hero-title').textContent = 'Welcome'
  }
  updateAmbient()
}

function updateAmbient() {
  const item = focusedItem()
  const color = item ? (S.tints.get(item.key) || item.tint || paletteTint(item.label)) : (S.theme ? S.theme.colors.accent : '#556')
  document.documentElement.style.setProperty('--ambient', color)
}

// Slide the shelf just far enough that the focused tile is fully in view, with
// the same margin as the page — the way a TV row moves, not a page scroll.
function scrollShelf(r, instant) {
  const shelfEl = document.querySelector(`.shelf[data-row="${r}"]`)
  const track = shelfEl && shelfEl.querySelector('.track')
  if (!track) return
  const tile = track.children[S.home.cols[r]]
  if (!tile) return
  const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0
  const vw = window.innerWidth
  let off = S.home.offsets[r] || 0
  const left = tile.offsetLeft
  const right = left + tile.offsetWidth
  if (left - off < pad) off = left - pad
  if (right - off > vw - pad) off = right - vw + pad
  const max = Math.max(0, track.scrollWidth - vw)
  off = clamp(off, 0, max)
  S.home.offsets[r] = off
  if (instant) { track.style.transition = 'none'; requestAnimationFrame(() => { track.style.transition = '' }) }
  track.style.transform = `translateX(${-off}px)`
}

function moveHome(dr, dc) {
  const h = S.home
  if (dr) {
    let r = h.row + dr
    // Up from the first shelf reaches the status chips; nothing below System.
    while (r >= 0 && r < S.shelves.length && !S.shelves[r].items.length) r += dr
    if (r < -1 || r >= S.shelves.length) return
    if (r === -1 && !document.querySelectorAll('#status .chip').length) return
    h.row = r
  } else if (h.row === -1) {
    const n = document.querySelectorAll('#status .chip').length
    h.chip = clamp(h.chip + dc, 0, n - 1)
  } else {
    const n = S.shelves[h.row].items.length
    h.cols[h.row] = clamp(h.cols[h.row] + dc, 0, n - 1)
  }
  updateHomeFocus()
}

function jumpToLetter(ch) {
  const shelf = S.shelves[0]
  if (!shelf || !shelf.items.length) return
  const c = ch.toLowerCase()
  const start = S.home.row === 0 ? S.home.cols[0] : -1
  for (let n = 1; n <= shelf.items.length; n++) {
    const i = (start + n + shelf.items.length) % shelf.items.length
    if (shelf.items[i].label.toLowerCase().startsWith(c)) { S.home.row = 0; S.home.cols[0] = i; updateHomeFocus(); return }
  }
}

async function activateHome() {
  if (S.home.row === -1) {
    const chip = document.querySelectorAll('#status .chip')[S.home.chip]
    if (chip) chip.click()
    return
  }
  const item = focusedItem()
  if (!item) return
  if (item.kind === 'system') { item.act(); return }
  if (item.missing) { homeOptions(); return }
  const el = document.querySelector(`.tile[data-key="${CSS.escape(item.key)}"]`)
  if (el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 140) }
  document.body.classList.add('launching')
  await sleep(260)
  const r = await tv.launch(item.key)
  if (!r.ok) { document.body.classList.remove('launching'); toast(r.message || 'Could not start it', true) }
}

function homeOptions() {
  const item = focusedItem()
  if (!item || item.kind === 'system') return
  const buttons = []
  if (!item.missing) buttons.push({ label: 'Open', act: () => activateHome() })
  if (item.kind === 'appimage') {
    buttons.push({ label: 'Hide from home', act: async () => { await tv.setHidden(item.path, true); toast(`${item.label} hidden — bring it back in Settings › Apps`); reloadHome() } })
  } else {
    buttons.push({ label: 'Remove from home', danger: true, act: async () => { await tv.unpin(item.id); toast(`${item.label} removed`); reloadHome() } })
  }
  buttons.push({ label: 'Cancel', act: () => {} })
  showSheet(item.label, item.kind === 'appimage' ? 'Hiding never touches the file in ~/Applications.' : 'It stays installed; this only takes it off the home screen.', buttons)
}

async function reloadHome(focusKey) {
  const prev = focusKey || (focusedItem() && focusedItem().key)
  const { items, capabilities } = await tv.home()
  S.items = items
  S.caps = capabilities
  renderHome()
  if (prev) focusTile(prev)
  lastHeroKey = null
  updateHomeFocus(true)
}

// ── Status strip & clock ────────────────────────────────────────────────────

function renderStatus() {
  const st = S.status
  const host = $('#status')
  if (!st) { host.innerHTML = ''; return }
  const chips = []
  const n = st.network
  if (n && n.available) {
    if (n.connection && n.connection.type === 'ethernet') chips.push({ sec: 'network', ic: 'ethernet', text: 'Wired' })
    else if (n.connection) chips.push({ sec: 'network', ic: 'wifi', text: n.connection.name })
    else chips.push({ sec: 'network', ic: 'wifiOff', text: 'Offline', off: true })
  }
  const a = st.audio
  if (a && a.volume !== null) chips.push({ sec: 'sound', ic: a.muted ? 'volumeMute' : 'volume', text: a.muted ? 'Muted' : a.volume + '%', off: a.muted })
  const b = st.bluetooth
  if (b && b.available) {
    chips.push({ sec: 'bluetooth', ic: 'bluetooth', text: !b.powered ? 'Off' : b.connected.length ? b.connected.map(d => d.name).join(', ') : 'On', off: !b.powered })
  }
  host.innerHTML = chips.map((c, i) => `<button class="chip${c.off ? ' off' : ''}" data-i="${i}" data-sec="${c.sec}">${icon(c.ic)}<span>${esc(c.text)}</span></button>`).join('')
  host.querySelectorAll('.chip').forEach(el => {
    el.addEventListener('click', () => openSettings(el.dataset.sec))
    el.addEventListener('mousemove', () => { if (S.mouse && topLayer() === 'home') { S.home.row = -1; S.home.chip = Number(el.dataset.i); updateHomeFocus() } })
  })
  if (S.home.row === -1) updateHomeFocus()
}

let statusBusy = false
async function refreshStatus() {
  if (statusBusy) return
  statusBusy = true
  try { S.status = await tv.status(); renderStatus() } finally { statusBusy = false }
}

function tickClock() {
  const now = new Date()
  const t = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const d = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  if ($('#time').textContent !== t) $('#time').textContent = t
  if ($('#date').textContent !== d) $('#date').textContent = d
}

// ── Settings ────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'sound', label: 'Sound', icon: 'volume' },
  { id: 'network', label: 'Network', icon: 'wifi' },
  { id: 'bluetooth', label: 'Bluetooth', icon: 'bluetooth' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'power', label: 'Power', icon: 'power' }
]

function openSettings(sectionId, intoRows) {
  S.set = { nav: Math.max(0, SECTIONS.findIndex(s => s.id === sectionId)), area: intoRows ? 'rows' : 'nav', row: 0, rows: [], data: {}, confirm: null, scanning: false, found: [], wifiScanning: false, offset: 0 }
  showLayer('settings')
  renderNav()
  loadSection()
}

function closeSettings() {
  S.set = null
  hideLayer('settings')
}

function section() { return SECTIONS[S.set.nav] }

function renderNav() {
  const nav = $('#settings-nav')
  nav.innerHTML = SECTIONS.map((s, i) => `<button class="nav-item${i === S.set.nav ? ' current' : ''}${i === S.set.nav && S.set.area === 'nav' ? ' focus' : ''}" data-i="${i}">${icon(s.icon)}<span>${s.label}</span></button>`).join('')
  nav.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => { S.set.area = 'nav'; selectSection(Number(el.dataset.i)) })
  })
  $('#settings-title').textContent = section().label
}

function selectSection(i) {
  if (i === S.set.nav) { renderNav(); renderRows(); return }
  S.set.nav = i
  S.set.row = 0
  S.set.offset = 0
  S.set.confirm = null
  S.set.found = []
  renderNav()
  loadSection()
}

async function loadSection() {
  const id = section().id
  const set = S.set
  // Draw what we have now, then again when the system answers.
  renderRows()
  if (id === 'sound') set.data.audio = await tv.audio()
  else if (id === 'network') {
    set.data.net = await tv.network()
    if (S.set !== set || section().id !== id) return
    renderRows()
    set.data.wifi = set.data.net.available ? await tv.wifiNetworks(false) : []
  } else if (id === 'bluetooth') set.data.bt = await tv.bluetooth()
  if (S.set !== set || section().id !== id) return
  renderRows()
}

// After an action, not during it: every helper is fire-and-forget, and asking
// at once reads the state from before the change (OmaCRT's lesson, again).
let settleTimer = null
function refreshLater(ms = 700) {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => { if (S.set) loadSection(); refreshStatus() }, ms)
}

async function runAction(name, args, { quiet } = {}) {
  const r = await tv.action(name, args)
  if (!quiet || !r.ok) if (r.message) toast(r.message, !r.ok)
  refreshLater()
  return r
}

function signalHtml(pct) {
  const bars = pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : 1
  return `<span class="signal">${[1, 2, 3, 4].map(i => `<i class="${i <= bars ? 'on' : ''}"></i>`).join('')}</span>`
}

function buildRows() {
  const id = section().id
  const d = S.set.data
  const rows = []
  const H = label => rows.push({ type: 'header', label })

  if (id === 'sound') {
    const a = d.audio
    if (!a) return [{ id: 'loading', label: 'Reading audio…', spinner: true, disabled: true }]
    const step = delta => runAction('volume.step', { delta }, { quiet: true })
    rows.push({ id: 'vol', icon: a.muted ? 'volumeMute' : 'volume', label: 'Volume', hint: '← → to adjust · Enter to mute', slider: { value: a.volume || 0, muted: a.muted }, value: a.muted ? 'MUTED' : `${a.volume}%`, left: () => step(-5), right: () => step(5), act: () => runAction('volume.mute', null, { quiet: true }) })
    rows.push({ id: 'mute', icon: 'volumeMute', label: 'Mute', toggle: a.muted, act: () => runAction('volume.mute', null, { quiet: true }) })
    if (a.outputs.length) {
      H('Output')
      for (const o of a.outputs) {
        rows.push({ id: 'out:' + o.name, icon: 'speaker', label: o.label, active: o.active, value: o.active ? 'IN USE' : '', act: () => o.active || runAction('audio.output', { id: o.id, name: o.name }) })
      }
    }
    if (S.caps.mixer) {
      H('More')
      rows.push({ id: 'mixer', icon: 'sliders', label: 'Open the mixer', hint: 'Per-app volume and inputs', act: () => runAction('tool.mixer') })
    }
  }

  if (id === 'network') {
    const n = d.net
    if (!n) return [{ id: 'loading', label: 'Reading network…', spinner: true, disabled: true }]
    if (!n.available) {
      rows.push({ id: 'none', icon: 'wifiOff', label: 'NetworkManager is not available', hint: 'Use the network tool instead', disabled: true })
      rows.push({ id: 'tool', icon: 'terminal', label: 'Open network tool', act: () => runAction('tool.wifi') })
      return rows
    }
    rows.push({ id: 'radio', icon: 'wifi', label: 'Wi-Fi', toggle: n.wifiEnabled, act: () => runAction('wifi.radio', { on: !n.wifiEnabled }) })
    if (n.connection) {
      const wired = n.connection.type === 'ethernet'
      rows.push({ id: 'conn', icon: wired ? 'ethernet' : 'wifi', label: n.connection.name, hint: wired ? 'Wired connection' : (n.signal ? `Connected · signal ${n.signal}%` : 'Connected'), value: 'CONNECTED', active: true, act: () => wired ? null : wifiOptions({ ssid: n.connection.name, active: true, saved: true }) })
    }
    if (n.wifiEnabled) {
      H('Wi-Fi networks')
      rows.push({ id: 'scan', icon: 'refresh', label: S.set.wifiScanning ? 'Looking for networks…' : 'Scan again', spinner: S.set.wifiScanning, act: () => wifiScan() })
      const list = (d.wifi || []).filter(w => !w.active)
      if (!d.wifi) rows.push({ id: 'wifi-loading', label: 'Listing networks…', spinner: true, disabled: true })
      for (const w of list) {
        rows.push({ id: 'net:' + w.ssid, iconHtml: signalHtml(w.signal), label: w.ssid, hint: w.saved ? 'Saved' : w.secure ? 'Secured' : 'Open network', valueHtml: w.secure ? icon('lockSmall') : '', act: () => wifiConnect(w), more: () => wifiOptions(w) })
      }
      if (d.wifi && !list.length) rows.push({ id: 'none', label: 'No other networks in range', disabled: true })
    }
    H('More')
    rows.push({ id: 'restart', icon: 'restart', label: 'Restart Wi-Fi', hint: 'When it is connected but nothing loads', act: () => runAction('wifi.restart') })
    rows.push({ id: 'tool', icon: 'terminal', label: 'Advanced network settings', hint: 'Opens the network tool in a terminal', act: () => runAction('tool.wifi') })
  }

  if (id === 'bluetooth') {
    const b = d.bt
    if (!b) return [{ id: 'loading', label: 'Reading Bluetooth…', spinner: true, disabled: true }]
    if (!b.available) return [{ id: 'none', icon: 'bluetooth', label: 'Bluetooth is not available on this machine', disabled: true }]
    rows.push({ id: 'power', icon: 'bluetooth', label: 'Bluetooth', toggle: b.powered, act: () => runAction('bt.power') })
    if (b.powered) {
      H('My devices')
      for (const dev of b.devices) {
        rows.push({ id: 'dev:' + dev.address, icon: 'bluetooth', label: dev.name, hint: dev.connected ? 'Connected · Enter to disconnect' : 'Enter to connect', value: dev.connected ? 'CONNECTED' : '', active: dev.connected, act: () => btToggle(dev), more: () => btOptions(dev) })
      }
      if (!b.devices.length) rows.push({ id: 'none', label: 'No paired devices yet', disabled: true })
      H('Add a device')
      rows.push({ id: 'scan', icon: S.set.scanning ? null : 'search', spinner: S.set.scanning, label: S.set.scanning ? 'Searching… put the device in pairing mode' : 'Search for devices', act: () => btScan() })
      for (const dev of S.set.found) {
        rows.push({ id: 'new:' + dev.address, icon: 'plus', label: dev.name, hint: dev.address, value: 'PAIR', act: () => btPair(dev) })
      }
    }
    H('More')
    rows.push({ id: 'tool', icon: 'terminal', label: 'Bluetooth tool', hint: 'For devices that ask for a PIN', act: () => runAction('tool.bluetooth') })
  }

  if (id === 'apps') {
    rows.push({ id: 'add', icon: 'plus', label: 'Add app…', hint: 'Anything installed on this machine', act: () => openCatalog() })
    const images = S.items.filter(i => i.kind === 'appimage')
    const pinned = S.items.filter(i => i.kind === 'desktop')
    H('In ~/Applications')
    for (const it of images) {
      rows.push({ id: 'ai:' + it.path, icon: it.hidden ? 'eyeOff' : 'eye', label: it.label, hint: it.sub, toggle: !it.hidden, act: async () => { await tv.setHidden(it.path, !it.hidden); await reloadHome(); renderRows() } })
    }
    if (!images.length) rows.push({ id: 'noimg', label: 'No AppImages yet — drop one into ~/Applications', disabled: true })
    H('Pinned')
    for (const it of pinned) {
      rows.push({ id: 'de:' + it.id, icon: 'trash', label: it.label, hint: it.missing ? 'No longer installed' : it.sub, value: 'REMOVE', act: async () => { await tv.unpin(it.id); toast(`${it.label} removed`); await reloadHome(); renderRows() } })
    }
    if (!pinned.length) rows.push({ id: 'nopin', label: 'Nothing pinned', disabled: true })
  }

  if (id === 'system') {
    if (S.caps.omarchyMenu) rows.push({ id: 'omarchy', icon: 'menu', label: 'Omarchy menu', hint: 'Themes, fonts, updates, display and everything else', act: () => runAction('omarchy.menu') })
    rows.push({ id: 'theme', icon: 'palette', label: 'Theme', value: (S.theme && S.theme.name || '').toUpperCase(), hint: 'Follows Omarchy — change it from the Omarchy menu', act: () => S.caps.omarchyMenu && runAction('omarchy.menu') })
    rows.push({ id: 'hide', icon: 'x', label: 'Hide launcher', hint: 'Run OMATVLauncher again to bring it back', act: () => tv.hide() })
    rows.push({ id: 'quit', icon: 'logout', label: 'Quit launcher', danger: true, confirm: true, act: () => tv.quit() })
  }

  if (id === 'power') {
    rows.push({ id: 'lock', icon: 'lock', label: 'Lock', act: () => runAction('power.lock') })
    rows.push({ id: 'sleep', icon: 'moon', label: 'Sleep', act: () => runAction('power.suspend') })
    rows.push({ id: 'reboot', icon: 'restart', label: 'Restart', danger: true, confirm: true, act: () => runAction('power.reboot') })
    rows.push({ id: 'shutdown', icon: 'power', label: 'Shut down', danger: true, confirm: true, act: () => runAction('power.shutdown') })
    rows.push({ id: 'logout', icon: 'logout', label: 'Log out', danger: true, confirm: true, act: () => runAction('power.logout') })
  }
  return rows
}

function focusableRows() { return S.set.rows.map((r, i) => i).filter(i => S.set.rows[i].type !== 'header' && !S.set.rows[i].disabled) }

function renderRows() {
  if (!S.set) return
  const prevId = S.set.rows[S.set.row] && S.set.rows[S.set.row].id
  S.set.rows = buildRows()
  const idx = prevId ? S.set.rows.findIndex(r => r.id === prevId) : -1
  const f = focusableRows()
  if (idx >= 0 && f.includes(idx)) S.set.row = idx
  else if (!f.includes(S.set.row)) S.set.row = f.length ? f.find(i => i >= S.set.row) ?? f[f.length - 1] : 0

  const html = S.set.rows.map((r, i) => {
    if (r.type === 'header') return `<div class="row-header">${esc(r.label)}</div>`
    const confirming = S.set.confirm === r.id
    const cls = ['row', r.danger && 'danger', r.disabled && 'disabled', r.active && 'active', confirming && 'confirm', S.set.area === 'rows' && i === S.set.row && 'focus'].filter(Boolean).join(' ')
    const lead = r.spinner ? '<span class="spinner"></span>' : r.iconHtml ? r.iconHtml : r.icon ? icon(r.icon) : ''
    let trail = ''
    if (r.slider) trail = `<div class="slider${r.slider.muted ? ' muted' : ''}"><span class="step" data-dir="-1">${icon('minus')}</span><div class="bar"><div class="fill" style="width:${clamp(r.slider.value, 0, 100)}%"></div></div><span class="step" data-dir="1">${icon('plus')}</span></div>`
    if (r.toggle !== undefined) trail += `<span class="switch${r.toggle ? ' on' : ''}"></span>`
    const value = confirming ? 'PRESS AGAIN' : r.value
    if (value) trail = `<span class="value">${esc(value)}</span>` + trail
    if (r.valueHtml) trail = `<span class="value">${r.valueHtml}</span>` + trail
    return `<button class="${cls}" data-i="${i}">${lead}<div class="text"><div class="label">${esc(r.label)}</div>${r.hint ? `<div class="hint">${esc(r.hint)}</div>` : ''}</div>${trail}</button>`
  }).join('')
  const host = $('#settings-rows')
  host.innerHTML = `<div class="rows-track">${html}</div>`
  host.querySelectorAll('.row').forEach(el => {
    const i = Number(el.dataset.i)
    el.addEventListener('mousemove', () => { if (S.mouse && topLayer() === 'settings' && !S.set.rows[i].disabled && (S.set.area !== 'rows' || S.set.row !== i)) { S.set.area = 'rows'; S.set.row = i; paintSettingsFocus() } })
    el.addEventListener('click', e => {
      const dir = e.target.closest('[data-dir]')
      S.set.area = 'rows'; S.set.row = i
      if (dir) { const r = S.set.rows[i]; (Number(dir.dataset.dir) < 0 ? r.left : r.right)(); return }
      activateRow()
    })
    el.addEventListener('contextmenu', e => { e.preventDefault(); const r = S.set.rows[i]; if (r.more) r.more() })
  })
  paintSettingsFocus()
}

function paintSettingsFocus() {
  document.querySelectorAll('#settings .focus').forEach(el => el.classList.remove('focus'))
  if (S.set.area === 'nav') {
    const n = document.querySelector(`.nav-item[data-i="${S.set.nav}"]`)
    if (n) n.classList.add('focus')
  } else {
    const el = document.querySelector(`.row[data-i="${S.set.row}"]`)
    if (el) el.classList.add('focus')
  }
  scrollRows()
}

function scrollRows() {
  const host = $('#settings-rows')
  const track = host.querySelector('.rows-track')
  if (!track) return
  const el = S.set.area === 'rows' ? track.querySelector(`.row[data-i="${S.set.row}"]`) : null
  let off = S.set.offset || 0
  if (el) {
    const top = el.offsetTop - (el.previousElementSibling && el.previousElementSibling.classList.contains('row-header') ? el.previousElementSibling.offsetHeight + 16 : 0)
    const bottom = el.offsetTop + el.offsetHeight + 16
    if (top - off < 0) off = top
    if (bottom - off > host.clientHeight) off = bottom - host.clientHeight
  }
  off = clamp(off, 0, Math.max(0, track.scrollHeight - host.clientHeight))
  S.set.offset = off
  track.style.transform = `translateY(${-off}px)`
}

function moveRows(delta) {
  const f = focusableRows()
  if (!f.length) return
  const pos = f.indexOf(S.set.row)
  S.set.row = f[clamp((pos < 0 ? 0 : pos) + delta, 0, f.length - 1)]
  S.set.confirm = null
  renderRows()
}

let confirmTimer = null
function activateRow() {
  const r = S.set.rows[S.set.row]
  if (!r || r.disabled || r.type === 'header' || !r.act) return
  // Anything that ends the session asks twice, in place, without a dialog:
  // the row itself turns red and says so.
  if (r.confirm && S.set.confirm !== r.id) {
    S.set.confirm = r.id
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => { if (S.set && S.set.confirm === r.id) { S.set.confirm = null; renderRows() } }, 4000)
    renderRows()
    return
  }
  S.set.confirm = null
  r.act()
}

// Network flows

async function wifiScan() {
  if (S.set.wifiScanning) return
  const set = S.set
  set.wifiScanning = true
  renderRows()
  const list = await tv.wifiNetworks(true)
  if (S.set !== set) return
  set.wifiScanning = false
  set.data.wifi = list
  renderRows()
}

async function wifiConnect(w) {
  if (w.active) return wifiOptions(w)
  let password
  if (w.secure && !w.saved) {
    password = await showPrompt(`Join “${w.ssid}”`, 'Type the network password.', 'Join')
    if (password == null) return
  }
  toast(`Connecting to ${w.ssid}…`)
  await runAction('wifi.connect', { ssid: w.ssid, password })
}

function wifiOptions(w) {
  const buttons = []
  if (w.active) buttons.push({ label: 'Disconnect', act: () => runAction('wifi.disconnect') })
  else buttons.push({ label: 'Connect', act: () => wifiConnect(w) })
  if (w.saved) buttons.push({ label: 'Forget this network', danger: true, act: () => runAction('wifi.forget', { ssid: w.ssid }) })
  buttons.push({ label: 'Cancel', act: () => {} })
  showSheet(w.ssid, w.active ? 'You are connected to this network.' : w.saved ? 'Saved network.' : '', buttons)
}

// Bluetooth flows

async function btToggle(dev) {
  toast(dev.connected ? `Disconnecting ${dev.name}…` : `Connecting ${dev.name}…`)
  await runAction(dev.connected ? 'bt.disconnect' : 'bt.connect', { address: dev.address })
}

function btOptions(dev) {
  showSheet(dev.name, dev.address, [
    { label: dev.connected ? 'Disconnect' : 'Connect', act: () => btToggle(dev) },
    { label: 'Forget this device', danger: true, act: () => runAction('bt.forget', { address: dev.address }) },
    { label: 'Cancel', act: () => {} }
  ])
}

async function btScan() {
  if (S.set.scanning) return
  const set = S.set
  set.scanning = true
  set.found = []
  renderRows()
  const found = await tv.bluetoothScan()
  if (S.set !== set) return
  set.scanning = false
  set.found = found
  renderRows()
  if (!found.length) toast('Nothing new found — is it in pairing mode?')
}

async function btPair(dev) {
  toast(`Pairing ${dev.name}…`)
  const r = await runAction('bt.pair', { address: dev.address })
  if (r.ok && S.set) { S.set.found = S.set.found.filter(d => d.address !== dev.address); renderRows() }
}

// ── Add app ─────────────────────────────────────────────────────────────────

const CAT_COLS = 6

async function openCatalog() {
  S.cat = { all: null, list: [], idx: 0, offset: 0 }
  showLayer('catalog')
  const input = $('#catalog-search')
  input.value = ''
  setTimeout(() => input.focus(), 50)
  renderCatalog()
  S.cat.all = await tv.catalog()
  if (!S.cat) return
  filterCatalog()
}

function closeCatalog() {
  S.cat = null
  $('#catalog-search').blur()
  hideLayer('catalog')
}

function filterCatalog() {
  const q = $('#catalog-search').value.trim().toLowerCase()
  const all = S.cat.all || []
  if (!q) S.cat.list = all
  else {
    const starts = [], contains = []
    for (const a of all) {
      const l = a.label.toLowerCase()
      if (l.startsWith(q) || l.split(/\s+/).some(w => w.startsWith(q))) starts.push(a)
      else if (l.includes(q) || String(a.sub).toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) contains.push(a)
    }
    S.cat.list = starts.concat(contains)
  }
  S.cat.idx = 0
  S.cat.offset = 0
  renderCatalog()
}

function renderCatalog() {
  const host = $('#catalog-grid')
  if (!S.cat.all) { host.innerHTML = '<div class="catalog-empty"><span class="spinner"></span></div>'; return }
  if (!S.cat.list.length) { host.innerHTML = `<div class="catalog-empty">${S.cat.all.length ? 'Nothing matches.' : 'Everything installed is already on the home screen.'}</div>`; return }
  host.innerHTML = `<div class="grid-track" style="--cols:${CAT_COLS}">${S.cat.list.map((a, i) => `
    <button class="app-card" data-i="${i}">
      ${a.icon ? `<img src="${esc(a.icon)}" alt="" loading="lazy" draggable="false">` : `<span class="mini-mono" style="--tint:${paletteTint(a.label)}">${esc(initials(a.label))}</span>`}
      <span class="name">${esc(a.label)}</span>
    </button>`).join('')}</div>`
  host.querySelectorAll('.app-card').forEach(el => {
    const i = Number(el.dataset.i)
    const img = el.querySelector('img')
    if (img) img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'mini-mono', textContent: initials(S.cat.list[i].label), style: `--tint:${paletteTint(S.cat.list[i].label)}` })))
    el.addEventListener('mousemove', () => { if (S.mouse && S.cat.idx !== i) { S.cat.idx = i; paintCatalogFocus() } })
    el.addEventListener('click', () => { S.cat.idx = i; pinCurrent() })
  })
  paintCatalogFocus()
}

function paintCatalogFocus() {
  document.querySelectorAll('.app-card.focus').forEach(el => el.classList.remove('focus'))
  const el = document.querySelector(`.app-card[data-i="${S.cat.idx}"]`)
  if (!el) return
  el.classList.add('focus')
  const host = $('#catalog-grid')
  const track = host.querySelector('.grid-track')
  let off = S.cat.offset
  const top = el.offsetTop - 12, bottom = el.offsetTop + el.offsetHeight + 24
  if (top - off < 0) off = top
  if (bottom - off > host.clientHeight) off = bottom - host.clientHeight
  S.cat.offset = clamp(off, 0, Math.max(0, track.scrollHeight - host.clientHeight))
  track.style.transform = `translateY(${-S.cat.offset}px)`
}

function moveCatalog(delta) {
  if (!S.cat.list.length) return
  S.cat.idx = clamp(S.cat.idx + delta, 0, S.cat.list.length - 1)
  paintCatalogFocus()
}

// Pinning lands back on home *on* the new tile — the confirmation is the app
// itself, highlighted, where it will be from now on.
async function pinCurrent() {
  const a = S.cat.list[S.cat.idx]
  if (!a) return
  const r = await tv.pin({ id: a.id, label: a.label })
  closeCatalog()
  if (S.set) closeSettings()
  await reloadHome(r.key)
  toast(`${a.label} is on your home screen`)
}

// ── Modal: option sheets and the one text prompt ────────────────────────────

function showSheet(title, text, buttons) {
  S.modal = { buttons, idx: 0, prompt: false }
  $('#modal-title').textContent = title
  $('#modal-text').textContent = text || ''
  $('#modal-text').hidden = !text
  $('#modal-input').hidden = true
  renderModalButtons(false)
  showLayer('modal')
}

function showPrompt(title, text, submitLabel) {
  return new Promise(resolve => {
    S.modal = {
      prompt: true, idx: 1, resolve,
      buttons: [{ label: 'Cancel', act: () => resolve(null) }, { label: submitLabel || 'OK', act: () => resolve($('#modal-input').value) }]
    }
    $('#modal-title').textContent = title
    $('#modal-text').textContent = text || ''
    $('#modal-text').hidden = !text
    const input = $('#modal-input')
    input.hidden = false
    input.value = ''
    renderModalButtons(true)
    showLayer('modal')
    setTimeout(() => input.focus(), 50)
  })
}

function renderModalButtons(inline) {
  const host = $('#modal-buttons')
  host.classList.toggle('inline', inline)
  host.innerHTML = S.modal.buttons.map((b, i) => `<button class="btn${b.danger ? ' danger' : ''}${i === S.modal.idx ? ' focus' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')
  host.querySelectorAll('.btn').forEach(el => {
    const i = Number(el.dataset.i)
    el.addEventListener('mousemove', () => { if (S.mouse && S.modal && S.modal.idx !== i) { S.modal.idx = i; paintModal() } })
    el.addEventListener('click', () => { S.modal.idx = i; chooseModal() })
  })
}

function paintModal() {
  document.querySelectorAll('#modal-buttons .btn').forEach((el, i) => el.classList.toggle('focus', i === S.modal.idx))
}

function chooseModal(cancel) {
  const m = S.modal
  if (!m) return
  S.modal = null
  $('#modal-input').blur()
  hideLayer('modal')
  if (cancel) { if (m.prompt) m.resolve(null); return }
  const b = m.buttons[m.idx]
  if (b) b.act()
}

// ── Layers ──────────────────────────────────────────────────────────────────

function showLayer(id) {
  $('#' + id).classList.add('open')
  $('#' + id).setAttribute('aria-hidden', 'false')
  document.body.classList.toggle('layered', !!(S.set || S.cat))
  renderHints()
}

function hideLayer(id) {
  $('#' + id).classList.remove('open')
  $('#' + id).setAttribute('aria-hidden', 'true')
  document.body.classList.toggle('layered', !!(S.set || S.cat))
  renderHints()
}

function topLayer() {
  if (S.modal) return 'modal'
  if (S.cat) return 'catalog'
  if (S.set) return 'settings'
  return 'home'
}

function hints(list) { return list.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('') }
function renderHints() {
  $('#home-hints').innerHTML = hints([['←↑→↓', 'Move'], ['Enter', 'Open'], ['Del', 'Options'], ['A–Z', 'Jump'], ['Esc', 'Hide']])
  $('#settings-hints').innerHTML = hints([['↑↓', 'Move'], ['←→', 'Adjust'], ['Enter', 'Select'], ['Del', 'Options'], ['Esc', 'Back']])
  $('#catalog-hints').innerHTML = hints([['Type', 'Search'], ['←↑→↓', 'Move'], ['Enter', 'Add to home'], ['Esc', 'Close']])
}

// ── Keyboard ────────────────────────────────────────────────────────────────

const OPTIONS_KEYS = ['Delete', 'ContextMenu', 'F10']

function onKey(e) {
  document.body.classList.add('no-cursor')
  S.mouse = false
  const k = e.key
  const layer = topLayer()

  if (layer === 'modal') {
    const m = S.modal
    if (k === 'Escape') chooseModal(true)
    else if (k === 'Enter') { if (m.prompt) m.idx = 1; chooseModal() }
    else if (!m.prompt && (k === 'ArrowDown' || k === 'ArrowUp')) { m.idx = clamp(m.idx + (k === 'ArrowDown' ? 1 : -1), 0, m.buttons.length - 1); paintModal() }
    else if (m.prompt && (k === 'Tab')) { m.idx = m.idx ? 0 : 1; paintModal() }
    else return
    e.preventDefault()
    return
  }

  if (layer === 'catalog') {
    if (k === 'Escape') { const input = $('#catalog-search'); if (input.value) { input.value = ''; filterCatalog() } else closeCatalog() }
    else if (k === 'Enter') pinCurrent()
    else if (k === 'ArrowLeft') moveCatalog(-1)
    else if (k === 'ArrowRight') moveCatalog(1)
    else if (k === 'ArrowUp') moveCatalog(-CAT_COLS)
    else if (k === 'ArrowDown') moveCatalog(CAT_COLS)
    else if (k === 'PageDown') moveCatalog(CAT_COLS * 3)
    else if (k === 'PageUp') moveCatalog(-CAT_COLS * 3)
    else return
    e.preventDefault()
    return
  }

  if (layer === 'settings') {
    const set = S.set
    if (set.area === 'nav') {
      if (k === 'ArrowUp') selectSection(clamp(set.nav - 1, 0, SECTIONS.length - 1))
      else if (k === 'ArrowDown') selectSection(clamp(set.nav + 1, 0, SECTIONS.length - 1))
      else if (k === 'ArrowRight' || k === 'Enter') { if (focusableRows().length) { set.area = 'rows'; if (!focusableRows().includes(set.row)) set.row = focusableRows()[0]; renderNav(); renderRows() } }
      else if (k === 'Escape' || k === 'Backspace' || k === 'ArrowLeft') closeSettings()
      else return
    } else {
      const r = set.rows[set.row]
      if (k === 'ArrowUp') moveRows(-1)
      else if (k === 'ArrowDown') moveRows(1)
      else if (k === 'PageUp') moveRows(-5)
      else if (k === 'PageDown') moveRows(5)
      else if (k === 'ArrowLeft') { if (r && r.left) r.left(); else { set.area = 'nav'; set.confirm = null; renderNav(); renderRows() } }
      else if (k === 'ArrowRight') { if (r && r.right) r.right() }
      else if (k === 'Enter' || k === ' ') activateRow()
      else if (OPTIONS_KEYS.includes(k)) { if (r && r.more) r.more() }
      else if (k === 'Escape' || k === 'Backspace') { set.area = 'nav'; set.confirm = null; renderNav(); renderRows() }
      else return
    }
    e.preventDefault()
    return
  }

  // Home
  if (k === 'ArrowLeft') moveHome(0, -1)
  else if (k === 'ArrowRight') moveHome(0, 1)
  else if (k === 'ArrowUp') moveHome(-1, 0)
  else if (k === 'ArrowDown') moveHome(1, 0)
  else if (k === 'Enter' || k === ' ') activateHome()
  else if (OPTIONS_KEYS.includes(k)) homeOptions()
  else if (k === 'Escape') tv.hide()
  else if (k === 'Home') { S.home.cols[S.home.row] = 0; updateHomeFocus() }
  else if (k === 'End') { const s = S.shelves[S.home.row]; if (s) { S.home.cols[S.home.row] = s.items.length - 1; updateHomeFocus() } }
  else if (/^[a-z0-9]$/i.test(k) && !e.ctrlKey && !e.altKey && !e.metaKey) jumpToLetter(k)
  else return
  e.preventDefault()
}

// ── Mouse ───────────────────────────────────────────────────────────────────

let cursorTimer = null
function onMouseMove() {
  document.body.classList.remove('no-cursor')
  S.mouse = true
  clearTimeout(cursorTimer)
  cursorTimer = setTimeout(() => { document.body.classList.add('no-cursor'); S.mouse = false }, 3000)
}

// The wheel walks the focus along a shelf, one tile per notch, rather than
// free-scrolling: on a TV the focus *is* the scroll position.
let wheelAcc = 0
function onWheel(e) {
  const layer = topLayer()
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  wheelAcc += d
  if (Math.abs(wheelAcc) < 60) return
  const step = wheelAcc > 0 ? 1 : -1
  wheelAcc = 0
  if (layer === 'home' && S.home.row >= 0) moveHome(0, step)
  else if (layer === 'settings' && S.set.area === 'rows') moveRows(step)
  else if (layer === 'settings') { S.set.area = 'rows'; moveRows(step) }
  else if (layer === 'catalog') moveCatalog(step * CAT_COLS)
}

// ── Toast ───────────────────────────────────────────────────────────────────

let toastTimer = null
function toast(text, bad) {
  const el = $('#toast')
  el.textContent = text
  el.classList.toggle('bad', !!bad)
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function onShown() {
  document.body.classList.remove('launching')
  // The folder is the configuration, so it is re-read every time home comes
  // back: an AppImage dropped in while an app was running is already a tile.
  await reloadHome()
  refreshStatus()
}

async function boot() {
  renderHints()
  tickClock()
  setInterval(tickClock, 1000)
  applyTheme(await tv.theme())
  tv.on('theme', applyTheme)
  tv.on('shown', onShown)
  tv.on('icon', ({ key, icon: url }) => {
    const it = S.items.find(i => i.key === key)
    if (!it) return
    it.icon = url
    const tile = document.querySelector(`.tile[data-key="${CSS.escape(key)}"]`)
    if (tile) { tile.querySelector('.art').innerHTML = `<img src="${esc(url)}" alt="" draggable="false">`; wireTileImage(tile, key) }
  })
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('wheel', onWheel, { passive: true })
  document.getElementById('catalog-search').addEventListener('input', () => S.cat && filterCatalog())
  window.addEventListener('resize', () => { updateHomeFocus(true); if (S.set) scrollRows() })
  setInterval(() => { if (!document.hidden) refreshStatus() }, 15000)

  await reloadHome()
  refreshStatus()
  requestAnimationFrame(() => document.body.classList.remove('booting'))
}

boot()
