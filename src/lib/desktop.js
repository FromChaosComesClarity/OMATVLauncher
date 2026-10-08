'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { run, which } = require('./exec')

/*
 * The launcher's own entry in the system menu.
 *
 * On a fresh machine the AppImage is just a file; this writes the
 * `.desktop` entry that makes it an app — findable in the Omarchy menu,
 * launchable by name — pointing at wherever the AppImage actually is, with its
 * icon beside the user's other icons. The file name matches `desktopName` in
 * package.json, which is also the window's app_id, so the running window and
 * the menu entry are recognised as the same app.
 *
 * Only ever this one file, and only in the user's own data dir: nothing system
 * wide, nothing that needs a password.
 */
const DATA = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local', 'share')
const ENTRY = path.join(DATA, 'applications', 'omatvlauncher.desktop')
const ICON = path.join(DATA, 'icons', 'hicolor', 'scalable', 'apps', 'omatvlauncher.svg')
const BUNDLED_ICON = path.join(__dirname, '..', 'assets', 'icon.svg')

// What starts *this* copy: the AppImage when packaged (APPIMAGE is set by its
// runtime), Electron plus the app directory when run from a checkout.
function execLine() {
  const { app } = require('electron')
  // ⚠️ Two layers, in this order (Desktop Entry spec, "The Exec key"): quoting
  // escapes " ` $ \ with a backslash, then the string-value escape doubles
  // every backslash again. A path with a $ in it otherwise launches nothing.
  const q = s => '"' + String(s).replace(/(["`$\\])/g, '\\$1').replace(/\\/g, '\\\\') + '"'
  if (process.env.APPIMAGE) return q(process.env.APPIMAGE)
  return q(process.execPath) + ' ' + q(app.getAppPath())
}

function contents() {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=OMATVLauncher',
    'GenericName=TV home screen',
    'Comment=Full-screen TV home screen: your AppImages, pinned apps and system settings.',
    `Exec=${execLine()}`,
    `Icon=${ICON}`,
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=tv;launcher;home;couch;living room;fullscreen;omatv;',
    'StartupWMClass=omatvlauncher',
    'X-OMATVLauncher=true',
    ''
  ].join('\n')
}

function status() {
  let text = null
  try { text = fs.readFileSync(ENTRY, 'utf8') } catch {}
  return {
    installed: text !== null,
    current: text !== null && text.includes(`Exec=${execLine()}\n`),
    path: ENTRY
  }
}

async function install() {
  fs.mkdirSync(path.dirname(ICON), { recursive: true })
  // Read-then-write rather than copy: inside the AppImage the icon lives in
  // app.asar, which Electron's fs can read but copyFile cannot see into.
  fs.writeFileSync(ICON, fs.readFileSync(BUNDLED_ICON))
  fs.mkdirSync(path.dirname(ENTRY), { recursive: true })
  const tmp = ENTRY + '.tmp'
  fs.writeFileSync(tmp, contents())
  fs.renameSync(tmp, ENTRY)
  await refreshDatabase()
  return status()
}

async function remove() {
  try { fs.unlinkSync(ENTRY) } catch {}
  try { fs.unlinkSync(ICON) } catch {}
  await refreshDatabase()
  return status()
}

// Menus that cache (and mime handlers) notice sooner; Omarchy's menu watches
// the directory anyway, so this is a courtesy, not a requirement.
async function refreshDatabase() {
  if (which('update-desktop-database')) await run('update-desktop-database', [path.dirname(ENTRY)])
}

/*
 * The AppImage moved (a new download, another folder): an entry that still
 * points at the old path launches nothing. If the user asked for an entry, keep
 * it pointing at whichever copy is running now. Never creates one unasked.
 *
 * ⚠️ Packaged copies only. A run from a source checkout would otherwise
 * quietly repoint the real menu entry at the development build.
 */
async function keepCurrent() {
  if (!process.env.APPIMAGE) return
  const s = status()
  if (s.installed && !s.current) await install()
}

module.exports = { status, install, remove, keepCurrent }
