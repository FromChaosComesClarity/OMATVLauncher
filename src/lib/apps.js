'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { run } = require('./exec')
const { normalizeDesktopId } = require('./state')

const HOME = process.env.HOME
const APPS_DIR = path.join(HOME, 'Applications')
const ICON_DROP_DIR = path.join(APPS_DIR, 'icons')
const CACHE_DIR = path.join(HOME, '.cache', 'omatvlauncher', 'icons')

function dataDirs() {
  const sys = String(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), ...sys]
}

// ── Desktop entries ─────────────────────────────────────────────────────────
//
// The installed-applications list, read the way the spec says: user dir first,
// then XDG_DATA_DIRS in order, first file for an id wins (that is how a user
// override of a system entry works), id = path under applications/ with "/"
// turned into "-".

function parseDesktopFile(text) {
  const out = {}
  let inMain = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue }
    if (!inMain) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    // Unlocalized keys only: "Name", not "Name[pt_BR]".
    if (key.includes('[')) continue
    if (!(key in out)) out[key] = line.slice(eq + 1).trim()
  }
  return out
}

function currentDesktops() {
  return String(process.env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean)
}

function shownHere(entry) {
  const here = currentDesktops()
  const only = String(entry.OnlyShowIn || '').split(';').filter(Boolean)
  const not = String(entry.NotShowIn || '').split(';').filter(Boolean)
  if (only.length && !only.some(d => here.includes(d))) return false
  if (not.some(d => here.includes(d))) return false
  return true
}

async function walkDesktopFiles(root, rel = '') {
  let dirents
  try { dirents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of dirents) {
    const r = rel ? rel + '/' + d.name : d.name
    if (d.isDirectory()) out.push(...await walkDesktopFiles(root, r))
    else if (d.name.endsWith('.desktop')) out.push(r)
  }
  return out
}

async function desktopEntries() {
  const seen = new Set()
  const out = []
  for (const base of dataDirs()) {
    const root = path.join(base, 'applications')
    for (const rel of await walkDesktopFiles(root)) {
      const id = normalizeDesktopId(rel.replace(/\//g, '-'))
      if (seen.has(id)) continue
      seen.add(id)
      let text
      try { text = await fsp.readFile(path.join(root, rel), 'utf8') } catch { continue }
      const e = parseDesktopFile(text)
      // Seen-but-hidden still claims the id, so a user file with Hidden=true
      // really does hide the system entry underneath it.
      if (e.Type !== 'Application' || e.Hidden === 'true' || e.NoDisplay === 'true' || !shownHere(e)) continue
      out.push({ id, label: e.Name || id, comment: e.Comment || e.GenericName || '', icon: e.Icon || '', exec: e.Exec || '' })
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  return out
}

// ── Icon lookup ─────────────────────────────────────────────────────────────
//
// Freedesktop icon names ("org.gnome.Nautilus", "steam") become files. A full
// theme lookup honours inheritance and sizes per context; a launcher on a TV
// wants one thing — the largest, sharpest app icon of that name anywhere — so
// this indexes every svg/png once and keeps the best by a simple score:
// scalable beats any bitmap, bigger bitmap beats smaller, and anything in an
// `apps` context beats the same name used as an action or a status icon.

let iconIndex = null
let iconIndexPromise = null

function iconScore(file) {
  let score = 0
  if (file.endsWith('.svg')) score = 10000
  else {
    const m = file.match(/\/(\d+)x\d+(@\d+x)?\//)
    score = m ? Number(m[1]) * (m[2] ? Number(m[2].slice(1, -1)) : 1) : 48
  }
  if (/\/apps\//.test(file)) score += 20000
  if (/\/pixmaps\//.test(file)) score += 15000
  if (/\/hicolor\//.test(file)) score += 500
  if (/symbolic/.test(file)) score -= 30000
  // Accessibility themes ship flat, two-tone versions of common names; they
  // are the right icon for nobody who did not choose that theme.
  if (/\/(HighContrast|ContrastHigh|LowContrast)\//i.test(file)) score -= 25000
  return score
}

function buildIconIndex() {
  if (iconIndexPromise) return iconIndexPromise
  const roots = [path.join(HOME, '.icons'), ...dataDirs().map(d => path.join(d, 'icons')), '/usr/share/pixmaps']
    .filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
  iconIndexPromise = run('find', ['-L', ...roots, '-type', 'f', '(', '-name', '*.svg', '-o', '-name', '*.png', ')'], { timeout: 20000 })
    .then(({ stdout }) => {
      const index = new Map()
      for (const file of stdout.split('\n')) {
        if (!file) continue
        const name = path.basename(file).replace(/\.(svg|png)$/, '')
        const score = iconScore(file)
        const prev = index.get(name)
        if (!prev || score > prev.score) index.set(name, { file, score })
      }
      iconIndex = index
      return index
    })
  return iconIndexPromise
}

async function resolveIcon(value) {
  const v = String(value || '').trim()
  if (!v) return null
  if (v.startsWith('/')) return fs.existsSync(v) ? v : null
  const index = iconIndex || await buildIconIndex()
  const hit = index.get(v) || index.get(v.replace(/\.(svg|png|xpm)$/, ''))
  return hit ? hit.file : null
}

// ── AppImages ───────────────────────────────────────────────────────────────

// "OmaCD-Player-x86_64" → "OmaCD Player". The architecture and version tails
// are packaging, not names, and a TV is read from across the room.
function prettyLabel(base) {
  return base
    .replace(/\.AppImage$/i, '')
    .replace(/[-_. ](x86[-_]64|amd64|aarch64|arm64|armhf|x64|i[36]86)$/i, '')
    .replace(/[-_ ]v?\d+(\.\d+)+([-.][\w.]+)?$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/*
 * Every AppImage in the folder gets a tile, executable or not.
 *
 * ⚠️ A departure from OmaCRT, which skipped files without +x as "a 120 MB file
 * that will fail silently when selected". In practice the bit goes missing on
 * the way in — a browser download, a copy from another disk — and a launcher
 * that hides the file is the one failing silently. So the tile is shown and
 * `executable: false` tells launch() to set u+x first, which is exactly what
 * the user would have done in a terminal. `*_old.AppImage` is still the
 * convention for a version kept back during an upgrade, excluded by name.
 */
async function scanAppImages() {
  let names
  try { names = await fsp.readdir(APPS_DIR) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!/\.AppImage$/i.test(name) || /_old\.AppImage$/i.test(name)) continue
    const p = path.join(APPS_DIR, name)
    // ~/Applications is also the natural home for this launcher's own
    // AppImage; a tile that opens the screen you are already on is noise.
    if (p === process.env.APPIMAGE || /^OMATVLauncher/i.test(name)) continue
    try {
      const st = await fsp.stat(p)
      if (!st.isFile()) continue
      const executable = await fsp.access(p, fs.constants.X_OK).then(() => true, () => false)
      out.push({ path: p, base: name.replace(/\.AppImage$/i, ''), label: prettyLabel(name), size: st.size, mtimeMs: st.mtimeMs, executable })
    } catch {}
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  return out
}

// An icon the user dropped next to the AppImages wins over everything: it is
// the one place a choice was made by hand (Clarity.svg, EmuLatte.svg …).
function droppedIcon(app) {
  const stems = [...new Set([app.base, app.label, app.label.replace(/ /g, ''), app.base.split(/[-_]/)[0]])]
  for (const stem of stems) {
    for (const ext of ['.svg', '.png', '.webp', '.jpg']) {
      const p = path.join(ICON_DROP_DIR, stem + ext)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// A desktop entry that launches this very file already knows its icon. When
// several do (Clarity, "Clarity on a CRT", "Couch"), the one with the fewest
// extra arguments is the plain app.
async function entryIconFor(app, entries) {
  const quoted = entries
    .filter(e => e.exec.includes(app.path))
    .sort((a, b) => a.exec.length - b.exec.length)
  for (const e of quoted) {
    const icon = await resolveIcon(e.icon)
    if (icon) return icon
  }
  return null
}

function cacheKey(app) {
  return crypto.createHash('sha1').update(`${app.path}:${app.size}:${app.mtimeMs}`).digest('hex').slice(0, 20)
}

function cachedIcon(app) {
  const key = cacheKey(app)
  for (const ext of ['.svg', '.png']) {
    const p = path.join(CACHE_DIR, key + ext)
    if (fs.existsSync(p)) return p
  }
  return fs.existsSync(path.join(CACHE_DIR, key + '.none')) ? false : null
}

// Type-2 AppImages carry "AI\x02" at byte 8. Only those understand
// --appimage-extract; a type-1 image would ignore the flag and *launch*.
async function isType2(p) {
  let fh
  try {
    fh = await fsp.open(p, 'r')
    const buf = Buffer.alloc(3)
    await fh.read(buf, 0, 3, 8)
    return buf[0] === 0x41 && buf[1] === 0x49 && buf[2] === 0x02
  } catch { return false } finally { if (fh) await fh.close() }
}

/*
 * Pull the AppImage's own .DirIcon out, once, into ~/.cache.
 *
 * ⚠️ .DirIcon is usually a symlink (to clarity.png, or deeper into usr/share),
 * and --appimage-extract extracts the link, not what it points to. So the
 * target is extracted on a second pass — and a third, for a link to a link.
 * The cache key includes size and mtime, so replacing the AppImage with a new
 * build re-extracts; a `.none` marker remembers images that have no icon.
 */
async function extractIcon(app) {
  const key = cacheKey(app)
  await fsp.mkdir(CACHE_DIR, { recursive: true })
  if (!await isType2(app.path)) { await fsp.writeFile(path.join(CACHE_DIR, key + '.none'), ''); return null }
  // Not executable yet: no icon until its first launch sets the bit. The
  // launcher does not chmod a file just to decorate a tile.
  if (!app.executable) return null
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'omatv-icon-'))
  try {
    let member = '.DirIcon'
    let found = null
    for (let hop = 0; hop < 4 && member; hop++) {
      await run(app.path, ['--appimage-extract', member], { cwd: tmp, timeout: 15000 })
      const p = path.join(tmp, 'squashfs-root', member)
      let st
      try { st = await fsp.lstat(p) } catch { break }
      if (st.isSymbolicLink()) {
        const target = await fsp.readlink(p)
        member = path.posix.normalize(path.posix.join(path.posix.dirname(member), target)).replace(/^\/+/, '')
        continue
      }
      if (st.isFile()) found = p
      break
    }
    if (!found) { await fsp.writeFile(path.join(CACHE_DIR, key + '.none'), ''); return null }
    const head = (await fsp.readFile(found)).subarray(0, 512).toString('utf8')
    const ext = /<svg|<\?xml/i.test(head) ? '.svg' : '.png'
    const dest = path.join(CACHE_DIR, key + ext)
    await fsp.copyFile(found, dest)
    return dest
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}

module.exports = {
  APPS_DIR,
  desktopEntries,
  buildIconIndex,
  resolveIcon,
  scanAppImages,
  droppedIcon,
  entryIconFor,
  cachedIcon,
  extractIcon,
  prettyLabel
}
