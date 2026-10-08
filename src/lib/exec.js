'use strict'

const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/*
 * The environment a launched app should see.
 *
 * ⚠️ When this launcher runs as an AppImage, its own runtime variables (APPDIR,
 * APPIMAGE, ARGV0, OWD) are in process.env, and an AppImage started from here
 * would inherit them and resolve its own files against *our* mount point. The
 * same goes for Electron's and Chromium's markers, which make a child Electron
 * app believe it is a helper of this one. Strip all of it once, here, so every
 * launch path gets the same clean environment.
 */
function cleanEnv() {
  const env = { ...process.env }
  const appdir = env.APPDIR
  for (const key of Object.keys(env)) {
    if (/^(APPDIR|APPIMAGE|ARGV0|OWD|APPIMAGE_.*|ELECTRON_.*|CHROME_DESKTOP|GOOGLE_API_KEY)$/.test(key)) delete env[key]
  }
  if (appdir && env.LD_LIBRARY_PATH && env.LD_LIBRARY_PATH.includes(appdir)) delete env.LD_LIBRARY_PATH
  return env
}

// Run a command and collect its output. Never rejects: a missing tool or a
// non-zero exit is an answer (`code`), not an exception, because every caller
// here is reading optional system state and has to keep working without it.
function run(cmd, args = [], { timeout = 5000, cwd } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, cwd, env: cleanEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      })
    })
  })
}

// Start something that outlives this process and is none of its business,
// except, optionally, when it ends.
function detach(cmd, args = [], { onExit } = {}) {
  let done = false
  const finish = code => { if (!done) { done = true; if (onExit) onExit(code) } }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: process.env.HOME })
    child.on('error', () => finish(-1))
    child.on('exit', code => finish(code))
    child.unref()
    return child
  } catch {
    finish(-1)
    return null
  }
}

const whichCache = new Map()
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd)
  let found = null
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue
    const p = path.join(dir, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); found = p; break } catch {}
  }
  whichCache.set(cmd, found)
  return found
}

module.exports = { cleanEnv, run, detach, which }
