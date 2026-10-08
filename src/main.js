'use strict'

const { app, BrowserWindow, ipcMain, protocol, net } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const apps = require('./lib/apps')
const system = require('./lib/system')
const theme = require('./lib/theme')
const store = require('./lib/state')
const { detach, which } = require('./lib/exec')

/*
 * OMATVLauncher — the TV's home screen.
 *
 * Same idea as OmaCRT's launcher: it opens the right thing and gets out of the
 * way. ~/Applications is the configuration (drop an AppImage in, it is a tile
 * the next time home appears), anything installed can be pinned with Add app,
 * and the system settings a living room actually needs are one screen away.
 *
 * What changed is the screen. A modern TV has the pixels for artwork and the
 * panel has no burn-in budget to protect, so this is a full-screen Electron
 * window with the theme's wallpaper behind it rather than a Quickshell overlay
 * built for 480 interlaced lines. Keyboard and mouse, no gamepad: a controller
 * belongs to the games.
 *
 * It stays resident. Launching it again toggles it (bind that to a key in
 * Hyprland), launching an app hides it, and when an AppImage started from
 * here exits, home comes back on its own — the way a TV's home screen does.
 */

const argv = process.argv.slice(1)
const windowed = argv.includes('--windowed')
const startHidden = argv.includes('--hidden')

// Development: render home off-screen, optionally press some keys, save a PNG
// and exit. Nothing appears on the display, and it runs beside a live copy
// because it uses its own profile (and so its own single-instance lock).
//   electron . --capture=/tmp/home.png --capture-keys=ArrowDown,Enter
const flag = name => { const a = argv.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null }
const capture = flag('--capture')
const captureKeys = (flag('--capture-keys') || '').split(',').filter(Boolean)
if (capture) app.setPath('userData', path.join(app.getPath('temp'), 'omatvlauncher-capture'))

app.setName('OMATVLauncher')
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
// Fractional scaling on a TV is common (1.5 at 4K); keep text crisp.
app.commandLine.appendSwitch('enable-features', 'WaylandFractionalScaleV1')

protocol.registerSchemesAsPrivileged([
  { scheme: 'omatv', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

let win = null
let state = store.load()
let currentTheme = theme.read()
let lastItems = new Map()
const running = new Set()

// ── Files the page may load ─────────────────────────────────────────────────
//
// The renderer never names a path. It gets opaque omatv://app/_file/<token> URLs for
// icons and the wallpaper, and only paths this process handed out resolve —
// so a compromised page still cannot read ~/.ssh through the protocol.
const served = new Map()
function fileUrl(p) {
  if (!p) return null
  const token = crypto.createHash('sha1').update(p).digest('hex').slice(0, 24)
  served.set(token, p)
  let v = 0
  try { v = Math.round(fs.statSync(p).mtimeMs) } catch {}
  return `omatv://app/_file/${token}?v=${v}`
}

function registerProtocol() {
  const rendererDir = path.join(__dirname, 'renderer')
  protocol.handle('omatv', req => {
    const url = new URL(req.url)
    if (url.host !== 'app') return new Response('not found', { status: 404 })
    // Same origin as the page on purpose: the CSP stays 'self', and icons can
    // be read back from a canvas to tint their tiles without tainting it.
    if (url.pathname.startsWith('/_file/')) {
      const p = served.get(url.pathname.slice('/_file/'.length))
      if (!p) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(p).toString())
    }
    {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
      const full = path.normalize(path.join(rendererDir, rel))
      if (!full.startsWith(rendererDir + path.sep)) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(full).toString())
    }
  })
}

// ── Home model ──────────────────────────────────────────────────────────────

let entriesCache = null
async function entries(refresh) {
  if (!entriesCache || refresh) entriesCache = await apps.desktopEntries()
  return entriesCache
}

// Clarity has a mode made for exactly this screen; anything else launches
// plain unless launcher.json says otherwise.
function argsFor(p) {
  if (state.args[p]) return state.args[p]
  if (/^Clarity(\.|-)/i.test(path.basename(p))) return ['--couch']
  return []
}

async function homeItems() {
  const [images, ents] = await Promise.all([apps.scanAppImages(), entries(true)])
  const items = []
  const needExtract = []

  // AppImages first: ~/Applications is where this machine's own builds land,
  // and they are what someone turning the TV on is reaching for.
  for (const a of images) {
    let icon = apps.droppedIcon(a) || await apps.entryIconFor(a, ents)
    if (!icon) {
      const cached = apps.cachedIcon(a)
      if (cached) icon = cached
      else if (cached === null) needExtract.push(a)
    }
    items.push({
      key: 'ai:' + a.path, kind: 'appimage', path: a.path, label: a.label, executable: a.executable,
      sub: path.basename(a.path), icon: fileUrl(icon), hidden: state.hidden.includes(a.path)
    })
  }

  for (const p of state.pinned) {
    const e = ents.find(x => x.id === p.id)
    items.push({
      key: 'de:' + p.id, kind: 'desktop', id: p.id, label: e ? e.label : p.label,
      sub: e ? e.comment : 'Not installed', icon: fileUrl(e ? await apps.resolveIcon(e.icon) : null),
      missing: !e, hidden: false
    })
  }

  lastItems = new Map(items.map(i => [i.key, i]))
  if (needExtract.length) extractInBackground(needExtract)
  return items
}

// One at a time: each extraction mounts a whole AppImage, and the tile already
// shows a monogram, so there is no hurry worth a burst of FUSE mounts.
let extracting = false
async function extractInBackground(list) {
  if (extracting) return
  extracting = true
  try {
    for (const a of list) {
      const icon = await apps.extractIcon(a).catch(() => null)
      if (icon && win) win.webContents.send('icon', { key: 'ai:' + a.path, icon: fileUrl(icon) })
    }
  } finally { extracting = false }
}

async function catalog() {
  const ents = await entries(true)
  await apps.buildIconIndex()
  const pinned = new Set(state.pinned.map(p => p.id))
  const out = []
  for (const e of ents) {
    // Its own menu entry is not an app to pin on its own home screen.
    if (pinned.has(e.id) || e.id === 'omatvlauncher' || /OMATVLauncher/i.test(e.exec)) continue
    out.push({ id: e.id, label: e.label, sub: e.comment, icon: fileUrl(await apps.resolveIcon(e.icon)) })
  }
  return out
}

// ── Launching ───────────────────────────────────────────────────────────────

function launch(key) {
  const item = lastItems.get(key)
  if (!item) return { ok: false, message: 'Unknown app' }
  if (item.kind === 'appimage') {
    if (!item.executable) {
      try { fs.chmodSync(item.path, fs.statSync(item.path).mode | 0o100) } catch (e) {
        return { ok: false, message: `${item.label} is not executable and could not be made so` }
      }
    }
    running.add(key)
    detach(item.path, argsFor(item.path), {
      onExit: () => { running.delete(key); if (!running.size) showHome() }
    })
  } else {
    // The exact command Omarchy's own AppLibrary.launch() runs, so a pinned app
    // starts in the same systemd scope as one started from the system menu.
    const id = item.id + '.desktop'
    if (which('uwsm-app')) detach('uwsm-app', ['--', 'gtk-launch', id])
    else detach('gtk-launch', [id])
  }
  // ⚠️ Hidden, not left behind the app. Hyprland opens a new window *under* a
  // fullscreen one on the same workspace, so a home screen that stays up hides
  // the very app it just started.
  setTimeout(hideHome, 250)
  return { ok: true }
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    title: 'OMATVLauncher',
    width: capture ? 1920 : 1600,
    height: capture ? 1080 : 900,
    fullscreen: !windowed && !capture,
    frame: windowed,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: currentTheme.colors.background,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Capture mode paints to a bitmap: capturePage() on a hidden on-screen
      // window can wait forever for a frame that never comes.
      offscreen: !!capture
    }
  })
  win.loadURL('omatv://app/index.html')
  if (capture) { runCapture(); return }
  win.once('ready-to-show', () => { if (!startHidden) showHome() })
  // Navigation away from the launcher's own page is never intended.
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); hideHome() } })
}

async function runCapture() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  await new Promise(r => win.webContents.once('did-finish-load', r))
  await wait(2500)
  for (const key of captureKeys) {
    if (key.startsWith('wait')) { await wait(Number(key.slice(4)) || 1000); continue }
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)
    await wait(450)
  }
  await wait(1500)
  const image = await win.webContents.capturePage()
  fs.writeFileSync(capture, image.toPNG())
  app.exit(0)
}

function showHome() {
  if (!win) return
  win.show()
  if (!windowed) win.setFullScreen(true)
  win.focus()
  win.webContents.send('shown')
}

function hideHome() {
  if (win && win.isVisible()) win.hide()
}

function toggleHome() {
  if (win && win.isVisible() && win.isFocused()) hideHome()
  else showHome()
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function themePayload(t) {
  return { name: t.name, colors: t.colors, wallpaper: fileUrl(t.wallpaper) }
}

function wireIpc() {
  ipcMain.handle('home', async () => ({ items: await homeItems(), capabilities: system.capabilities() }))
  ipcMain.handle('theme', () => themePayload(currentTheme))
  ipcMain.handle('catalog', () => catalog())
  ipcMain.handle('launch', (_e, key) => launch(String(key)))

  ipcMain.handle('pin', (_e, { id, label }) => {
    id = store.normalizeDesktopId(id)
    if (id && !state.pinned.some(p => p.id === id)) {
      state.pinned.push({ id, label: String(label || id) })
      store.save(state)
    }
    return { ok: true, key: 'de:' + id }
  })
  ipcMain.handle('unpin', (_e, id) => {
    state.pinned = state.pinned.filter(p => p.id !== id)
    store.save(state)
    return { ok: true }
  })
  // A discovered AppImage is a file the user put in a folder; the launcher
  // hides and restores it, and never pretends to delete it.
  ipcMain.handle('setHidden', (_e, { path: p, hidden }) => {
    state.hidden = state.hidden.filter(h => h !== p)
    if (hidden) state.hidden.push(p)
    store.save(state)
    return { ok: true }
  })

  ipcMain.handle('status', () => system.status())
  ipcMain.handle('audio', () => system.audio())
  ipcMain.handle('network', () => system.network())
  ipcMain.handle('wifiNetworks', (_e, rescan) => system.wifiNetworks(!!rescan))
  ipcMain.handle('bluetooth', () => system.bluetooth())
  ipcMain.handle('bluetoothScan', () => system.bluetoothScan())
  ipcMain.handle('action', async (_e, name, args) => {
    const r = await system.action(String(name), args)
    // Actions that hand the screen to something else take home out of its way.
    if (/^(power\.|omarchy\.|tool\.)/.test(name)) setTimeout(hideHome, 150)
    return r
  })

  ipcMain.handle('hide', () => hideHome())
  ipcMain.handle('quit', () => { app.isQuitting = true; app.quit() })
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  // Already running: that instance gets our argv through 'second-instance'.
  app.quit()
} else {
  app.on('second-instance', (_e, args) => {
    if (args.includes('--show')) showHome()
    else if (args.includes('--hide')) hideHome()
    else toggleHome()
  })

  app.whenReady().then(() => {
    registerProtocol()
    wireIpc()
    createWindow()
    apps.buildIconIndex()
    theme.watch(t => {
      currentTheme = t
      if (win) {
        win.setBackgroundColor(t.colors.background)
        win.webContents.send('theme', themePayload(t))
      }
    })
  })

  app.on('before-quit', () => { app.isQuitting = true })
  // Resident by design: closing the last window is not quitting.
  app.on('window-all-closed', () => {})
}
