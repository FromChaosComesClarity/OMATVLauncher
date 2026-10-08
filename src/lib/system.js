'use strict'

const { run, detach, which } = require('./exec')

/*
 * System settings, without reimplementing the system.
 *
 * The rule OmaCRT settled on still holds: Omarchy already ships the verbs —
 * `omarchy-audio-output-volume`, `omarchy-bluetooth-device`, `omarchy-system-*`
 * — and going through them keeps the volume OSD, the remembered Bluetooth
 * power state and the lock-before-suspend dance consistent with the rest of
 * the machine. What changed is the screen: a modern TV with a keyboard in
 * reach can type a Wi-Fi password into a field, so joining a network, picking
 * an audio output and pairing a device happen here rather than in a terminal.
 * Where Omarchy has no verb, the tool that owns the job is asked directly
 * (nmcli, wpctl/pactl, bluetoothctl).
 *
 * Every reader tolerates its tool being absent: a machine with no Bluetooth
 * simply shows none.
 */

const has = cmd => !!which(cmd)
const omarchy = (cmd, args) => has(cmd) ? run(cmd, args) : Promise.resolve({ code: 127, stdout: '', stderr: '' })

// ── Readers ─────────────────────────────────────────────────────────────────

async function network() {
  if (!has('nmcli')) return { available: false }
  const [dev, wifi, radio] = await Promise.all([
    run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
    run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no']),
    run('nmcli', ['radio', 'wifi'])
  ])
  let connection = null
  let wifiDevice = null
  for (const line of dev.stdout.split('\n')) {
    const [device, type, state, ...name] = splitTerse(line)
    if (type === 'wifi' && !wifiDevice) wifiDevice = device
    if (!connection && state === 'connected' && type !== 'loopback' && type !== 'bridge') {
      connection = { device, type, name: name.join(':') }
    }
  }
  let signal = null
  for (const line of wifi.stdout.split('\n')) {
    const f = splitTerse(line)
    if (f[0] === '*') { signal = Number(f[2]) || null; break }
  }
  return { available: true, connection, signal, wifiDevice, wifiEnabled: radio.stdout.trim() === 'enabled' }
}

// nmcli -t escapes ":" inside fields as "\:"; split on the unescaped ones.
function splitTerse(line) {
  const out = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    if (line[i] === ':') { out.push(cur); cur = ''; continue }
    cur += line[i]
  }
  out.push(cur)
  return out
}

async function wifiNetworks(rescan) {
  if (!has('nmcli')) return []
  const [list, known] = await Promise.all([
    run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], { timeout: 20000 }),
    run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'])
  ])
  const saved = new Set(known.stdout.split('\n').map(splitTerse).filter(f => /wireless/.test(f[1] || '')).map(f => f[0]))
  const bySsid = new Map()
  for (const line of list.stdout.split('\n')) {
    const [inUse, ssid, signal, security] = splitTerse(line)
    if (!ssid) continue
    const prev = bySsid.get(ssid)
    const net = { ssid, signal: Number(signal) || 0, secure: !!security && security !== '--', security, active: inUse === '*', saved: saved.has(ssid) }
    // The same SSID on 2.4 and 5 GHz is one choice for a person; keep the
    // stronger, and keep "active" if either radio is the one in use.
    if (!prev || net.signal > prev.signal) bySsid.set(ssid, { ...net, active: net.active || !!(prev && prev.active) })
    else if (net.active) prev.active = true
  }
  return [...bySsid.values()].sort((a, b) => (b.active - a.active) || (b.signal - a.signal))
}

async function audio() {
  const [vol, sinks, def] = await Promise.all([
    has('wpctl') ? run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']) : { stdout: '' },
    has('pactl') ? run('pactl', ['-f', 'json', 'list', 'sinks']) : { stdout: '[]' },
    has('pactl') ? run('pactl', ['get-default-sink']) : { stdout: '' }
  ])
  // "Volume: 0.42", with " [MUTED]" appended when muted.
  const m = vol.stdout.match(/([0-9]*\.?[0-9]+)/)
  const volume = m ? Math.round(parseFloat(m[1]) * 100) : null
  const muted = /MUTED/i.test(vol.stdout)
  let outputs = []
  try {
    outputs = JSON.parse(sinks.stdout || '[]').map(s => ({
      id: String((s.properties && s.properties['object.id']) || s.index),
      name: s.name,
      label: s.description || s.name,
      active: s.name === def.stdout.trim()
    }))
  } catch {}
  return { volume, muted, outputs }
}

async function bluetooth({ withDevices = true } = {}) {
  if (!has('bluetoothctl')) return { available: false, powered: false, devices: [] }
  // ⚠️ `omarchy-bluetooth-power is-on` answers with its *exit status* and
  // prints nothing (the trap OmaCRT fell into first).
  const power = has('omarchy-bluetooth-power')
    ? (await run('omarchy-bluetooth-power', ['is-on'])).code === 0
    : /Powered:\s*yes/.test((await run('bluetoothctl', ['show'])).stdout)
  if (!withDevices) return { available: true, powered: power, devices: [] }
  const [paired, connected] = await Promise.all([
    run('bluetoothctl', ['devices', 'Paired']),
    run('bluetoothctl', ['devices', 'Connected'])
  ])
  const conn = new Set(parseDevices(connected.stdout).map(d => d.address))
  const devices = parseDevices(paired.stdout).map(d => ({ ...d, connected: conn.has(d.address) }))
  devices.sort((a, b) => (b.connected - a.connected) || a.name.localeCompare(b.name))
  return { available: true, powered: power, devices }
}

function parseDevices(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^Device\s+(\S+)\s+(.+)$/)
    if (m) out.push({ address: m[1], name: m[2].trim() })
  }
  return out
}

// The status strip on the home screen: cheap, no device lists.
async function status() {
  const [net, au, bt] = await Promise.all([network(), audio(), bluetooth({ withDevices: false })])
  let btConnected = []
  if (bt.available && bt.powered) btConnected = parseDevices((await run('bluetoothctl', ['devices', 'Connected'])).stdout)
  return {
    network: net,
    audio: { volume: au.volume, muted: au.muted },
    bluetooth: { available: bt.available, powered: bt.powered, connected: btConnected }
  }
}

// Discovery: scan for a while, then report everything seen that is not paired.
async function bluetoothScan(seconds = 12) {
  if (!has('bluetoothctl')) return []
  await run('bluetoothctl', ['--timeout', String(seconds), 'scan', 'on'], { timeout: (seconds + 5) * 1000 })
  const [all, paired] = await Promise.all([run('bluetoothctl', ['devices']), run('bluetoothctl', ['devices', 'Paired'])])
  const pairedSet = new Set(parseDevices(paired.stdout).map(d => d.address))
  // A device with no name advertises its address as one ("12-34-56-…"); those
  // are noise on a TV, not something anyone means to pair.
  return parseDevices(all.stdout).filter(d => !pairedSet.has(d.address) && !/^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$/i.test(d.name))
}

// ── Actions ─────────────────────────────────────────────────────────────────
//
// A closed set, by name: the renderer asks for "wifi.connect", never for a
// command line. Each returns { ok, message } so the UI can say what happened.

const result = (r, okMsg, failMsg) => ({ ok: r.code === 0, message: r.code === 0 ? okMsg : (lastLine(r.stderr) || lastLine(r.stdout) || failMsg) })
const lastLine = s => String(s || '').trim().split('\n').pop()

function volumeCmd(arg) {
  if (has('omarchy-audio-output-volume')) return run('omarchy-audio-output-volume', [arg])
  if (arg === 'mute-toggle') return run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'])
  return run('wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', arg.replace(/^([+-])(\d+)$/, '$2%$1')])
}

function terminal(cmd) {
  if (has('omarchy-launch-or-focus-tui')) return detach('omarchy-launch-or-focus-tui', [cmd])
  return detach('xdg-terminal-exec', [cmd])
}

const actions = {
  'volume.step': async ({ delta }) => result(await volumeCmd((delta > 0 ? '+' : '-') + Math.abs(Math.round(delta))), 'Volume changed', 'Could not change volume'),
  'volume.mute': async () => result(await volumeCmd('mute-toggle'), 'Mute toggled', 'Could not toggle mute'),
  'audio.output': async ({ id, name }) => has('omarchy-audio-output-set-default')
    ? result(await run('omarchy-audio-output-set-default', [String(id), String(name)]), 'Output switched', 'Could not switch output')
    : result(await run('wpctl', ['set-default', String(id)]), 'Output switched', 'Could not switch output'),

  'wifi.radio': async ({ on }) => result(await run('nmcli', ['radio', 'wifi', on ? 'on' : 'off']), on ? 'Wi-Fi on' : 'Wi-Fi off', 'Could not change Wi-Fi'),
  'wifi.connect': async ({ ssid, password }) => {
    const known = await run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show'])
    const saved = known.stdout.split('\n').map(l => splitTerse(l)[0]).includes(ssid)
    const r = saved && !password
      ? await run('nmcli', ['connection', 'up', 'id', ssid], { timeout: 45000 })
      : await run('nmcli', ['device', 'wifi', 'connect', ssid, ...(password ? ['password', password] : [])], { timeout: 45000 })
    return result(r, `Connected to ${ssid}`, `Could not connect to ${ssid}`)
  },
  'wifi.disconnect': async () => {
    const net = await network()
    if (!net.wifiDevice) return { ok: false, message: 'No Wi-Fi device' }
    return result(await run('nmcli', ['device', 'disconnect', net.wifiDevice]), 'Disconnected', 'Could not disconnect')
  },
  'wifi.forget': async ({ ssid }) => result(await run('nmcli', ['connection', 'delete', 'id', ssid]), `Forgot ${ssid}`, 'Could not forget network'),
  'wifi.restart': async () => result(await omarchy('omarchy-restart-wifi', []), 'Wi-Fi restarted', 'Could not restart Wi-Fi'),

  'bt.power': async () => has('omarchy-bluetooth-power')
    ? result(await run('omarchy-bluetooth-power', ['toggle']), 'Bluetooth toggled', 'Could not toggle Bluetooth')
    : result(await run('bluetoothctl', ['power', (await bluetooth({ withDevices: false })).powered ? 'off' : 'on']), 'Bluetooth toggled', 'Could not toggle Bluetooth'),
  'bt.connect': async ({ address }) => result(await btDevice('connect', address), 'Connected', 'Could not connect'),
  'bt.disconnect': async ({ address }) => result(await btDevice('disconnect', address), 'Disconnected', 'Could not disconnect'),
  'bt.pair': async ({ address }) => {
    const r = await btDevice('pair', address)
    if (r.code === 0 && !has('omarchy-bluetooth-device')) {
      await run('bluetoothctl', ['trust', address])
      await run('bluetoothctl', ['connect', address], { timeout: 20000 })
    }
    return result(r, 'Paired', 'Pairing failed')
  },
  'bt.forget': async ({ address }) => result(await btDevice('forget', address), 'Device removed', 'Could not remove device'),

  'power.lock': async () => { detach('omarchy-system-lock'); return { ok: true } },
  'power.suspend': async () => { detach('systemctl', ['suspend']); return { ok: true } },
  'power.reboot': async () => { detach(has('omarchy-system-reboot') ? 'omarchy-system-reboot' : 'systemctl', has('omarchy-system-reboot') ? [] : ['reboot']); return { ok: true } },
  'power.shutdown': async () => { detach(has('omarchy-system-shutdown') ? 'omarchy-system-shutdown' : 'systemctl', has('omarchy-system-shutdown') ? [] : ['poweroff']); return { ok: true } },
  'power.logout': async () => { detach('omarchy-system-logout'); return { ok: true } },

  'omarchy.menu': async () => { detach('omarchy-menu', ['toggle', 'root']); return { ok: true } },
  'tool.wifi': async () => { terminal(has('impala') ? 'impala' : 'nmtui'); return { ok: true } },
  'tool.bluetooth': async () => { terminal(has('bluetui') ? 'bluetui' : 'bluetoothctl'); return { ok: true } },
  'tool.mixer': async () => { if (has('wiremix')) terminal('wiremix'); else detach('pavucontrol'); return { ok: true } }
}

// Omarchy's verb when it exists (it remembers trust, handles the agent), plain
// bluetoothctl otherwise.
function btDevice(verb, address) {
  if (has('omarchy-bluetooth-device')) return run('omarchy-bluetooth-device', [verb, address], { timeout: 30000 })
  return run('bluetoothctl', [verb === 'forget' ? 'remove' : verb, address], { timeout: 30000 })
}

async function action(name, args = {}) {
  const fn = actions[name]
  if (!fn) return { ok: false, message: `Unknown action ${name}` }
  try { return await fn(args || {}) } catch (e) { return { ok: false, message: e.message } }
}

// Which external tools exist, so the UI offers only buttons that do something.
function capabilities() {
  return {
    nmcli: has('nmcli'),
    bluetooth: has('bluetoothctl'),
    mixer: has('wiremix') || has('pavucontrol'),
    omarchyMenu: has('omarchy-menu')
  }
}

module.exports = { status, network, wifiNetworks, audio, bluetooth, bluetoothScan, action, capabilities }
