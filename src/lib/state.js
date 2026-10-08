'use strict'

const fs = require('node:fs')
const path = require('node:path')

/*
 * Everything the user chose on purpose, and nothing else.
 *
 *   { "version": 1,
 *     "pinned": [ { "id": "org.kde.krita", "label": "Krita" } ],
 *     "hidden": [ "/home/jose/Applications/Something.AppImage" ],
 *     "args":   { "/home/jose/Applications/Clarity.AppImage": ["--couch"] } }
 *
 * The same shape OmaCRT keeps in ~/.config/omacrt/launcher.json, plus `args`,
 * and for the same reason in ~/.config rather than ~/.local/state: every line
 * is a decision worth backing up, not reconstructible cache. Discovered
 * AppImages are never stored — the folder is the configuration.
 */
const dir = path.join(process.env.HOME, '.config', 'omatvlauncher')
const file = path.join(dir, 'launcher.json')

function empty() { return { version: 1, pinned: [], hidden: [], args: {} } }

// A corrupt file is worth a warning and nothing more: the launcher still works
// without its saved list, and refusing to start would be the worse failure.
function load() {
  const out = empty()
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return out }
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.pinned)) {
      for (const p of parsed.pinned) {
        const id = normalizeDesktopId(p && p.id)
        if (id) out.pinned.push({ id, label: String((p && p.label) || id) })
      }
    }
    if (Array.isArray(parsed.hidden)) {
      for (const h of parsed.hidden) if (typeof h === 'string' && h.trim()) out.hidden.push(h.trim())
    }
    if (parsed.args && typeof parsed.args === 'object') {
      for (const [k, v] of Object.entries(parsed.args)) if (Array.isArray(v)) out.args[k] = v.map(String)
    }
  } catch (e) {
    console.warn(`omatvlauncher: ignoring unreadable ${file}:`, e.message)
  }
  return out
}

// Write-then-rename, so a crash mid-save leaves the old file, not half a new one.
function save(state) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, pinned: state.pinned, hidden: state.hidden, args: state.args }, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function normalizeDesktopId(id) {
  let value = String(id || '').trim()
  if (value.endsWith('.desktop')) value = value.slice(0, -8)
  return value
}

module.exports = { load, save, normalizeDesktopId, file }
