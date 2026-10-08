'use strict'

const fs = require('node:fs')
const path = require('node:path')

/*
 * The current Omarchy theme, read the way the shell reads it (Commons/Color.qml):
 * colors.toml for the palette — `accent` if the theme defines one, color4
 * otherwise; `muted` or color8 — and the `background` symlink for the
 * wallpaper. Only the files: no shell IPC, so this works whether or not
 * omarchy-shell is running.
 */
const CURRENT = path.join(process.env.HOME, '.local', 'state', 'omarchy', 'current')

const FALLBACK = { foreground: '#cacccc', background: '#101315', accent: '#cacccc', urgent: '#a55555', muted: '#707880' }

function readColors() {
  let raw = ''
  try { raw = fs.readFileSync(path.join(CURRENT, 'theme', 'colors.toml'), 'utf8') } catch {}
  const vals = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (m) vals[m[1]] = m[2]
  }
  return {
    foreground: vals.foreground || vals.color7 || FALLBACK.foreground,
    background: vals.background || vals.color0 || FALLBACK.background,
    accent: vals.accent || vals.color4 || FALLBACK.accent,
    urgent: vals.color1 || vals.red || FALLBACK.urgent,
    muted: vals.muted || vals.color8 || FALLBACK.muted,
    palette: [1, 2, 3, 4, 5, 6].map(i => vals['color' + i]).filter(Boolean)
  }
}

function wallpaper() {
  try {
    const real = fs.realpathSync(path.join(CURRENT, 'background'))
    return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(real) ? real : null
  } catch { return null }
}

function read() {
  let name = ''
  try { name = fs.readFileSync(path.join(CURRENT, 'theme.name'), 'utf8').trim() } catch {}
  return { name, colors: readColors(), wallpaper: wallpaper() }
}

/*
 * A theme switch rewrites the files and relinks `background`, in several
 * steps. The watcher fires on each; the debounce turns the burst into one
 * reload after it settles. Watching the parent catches the whole `theme`
 * directory being swapped out, which a watch on the file itself would miss.
 */
function watch(onChange) {
  let timer = null
  let watchers = []
  // ⚠️ Re-armed after every change: when the theme directory is replaced, the
  // old watch is attached to a directory that no longer exists and goes quiet.
  const arm = () => {
    watchers.forEach(w => w.close())
    watchers = []
    for (const dir of [CURRENT, path.join(CURRENT, 'theme')]) {
      try { watchers.push(fs.watch(dir, fire)) } catch {}
    }
  }
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { arm(); onChange(read()) }, 400)
  }
  arm()
  return () => { clearTimeout(timer); watchers.forEach(w => w.close()) }
}

module.exports = { read, watch }
