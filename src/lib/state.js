'use strict'

const fs = require('node:fs')
const path = require('node:path')

/*
 * Everything the user chose on purpose, and nothing else.
 *
 *   { "version": 1,
 *     "pinned": [ { "id": "org.kde.krita", "label": "Krita" } ],
 *     "hidden": [ "/home/jose/Applications/Something.AppImage" ],
 *     "args":   { "/home/jose/Applications/Clarity.AppImage": ["--couch"] },
 *     "order":  [ "ai:/home/jose/Applications/Clarity.AppImage", "de:org.kde.krita" ] }
 *
 * The same shape OmaCRT keeps in ~/.config/omacrt/launcher.json, plus `args`
 * and `order` (the Apps shelf as the user arranged it, by tile key),
 * and for the same reason in ~/.config rather than ~/.local/state: every line
 * is a decision worth backing up, not reconstructible cache. Discovered
 * AppImages are never stored — the folder is the configuration.
 */
// OMATV_CONFIG_DIR is for development: --capture points it at a scratch copy so
// an off-screen test that rearranges tiles never touches the real arrangement.
const dir = () => process.env.OMATV_CONFIG_DIR || path.join(process.env.HOME, '.config', 'omatvlauncher')
const fileOf = () => path.join(dir(), 'launcher.json')

function empty() { return { version: 1, pinned: [], hidden: [], args: {}, order: [] } }

// A corrupt file is worth a warning and nothing more: the launcher still works
// without its saved list, and refusing to start would be the worse failure.
function load() {
  const out = empty()
  let raw
  const file = fileOf()
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
    if (Array.isArray(parsed.order)) out.order = parsed.order.filter(k => typeof k === 'string' && k)
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
  fs.mkdirSync(dir(), { recursive: true })
  const file = fileOf()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, pinned: state.pinned, hidden: state.hidden, args: state.args, order: state.order }, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function normalizeDesktopId(id) {
  let value = String(id || '').trim()
  if (value.endsWith('.desktop')) value = value.slice(0, -8)
  return value
}

module.exports = { load, save, normalizeDesktopId, fileOf }
