# OMATVLauncher

A full-screen home screen for an Omarchy machine plugged into a modern TV.

It is [OmaCRT](https://github.com/FromChaosComesClarity/OmaCRT)'s launcher,
rebuilt for a screen that can take it. The ideas are the same — it opens the
right thing and gets out of the way, `~/Applications` is the configuration,
anything installed can be pinned, and the settings a living room needs are one
screen away — but where OmaCRT was a Quickshell overlay drawn for 480
interlaced lines and a burn-in budget, this is an Electron app with the theme's
wallpaper behind it, artwork on every tile, and nothing it has to hold back.

Keyboard and mouse. No gamepad: a controller belongs to the games.

## What is on the home screen

- **Apps** — every `*.AppImage` in `~/Applications`, discovered each time home
  appears, so dropping one in *is* the install step. Then everything you pinned
  with **Add app**.
- **System** — Settings, Add app, the Omarchy menu, and Power.
- A status strip (network, volume, Bluetooth) and a clock, each chip a shortcut
  into its settings page.

Each tile takes the colour of its own icon, and the focused one lights the
backdrop with it. Icons come from, in order: a file you drop in
`~/Applications/icons/` named after the app (`Clarity.svg`, `EmuLatte.png`); a
`.desktop` entry that already launches that AppImage; the AppImage's own
embedded icon, extracted once into `~/.cache/omatvlauncher/icons`. An app with
none of those gets its name set large as the artwork.

AppImages without the executable bit still get a tile — the bit usually goes
missing in a download — and the launcher sets `u+x` the first time you open one.
`*_old.AppImage` files are skipped (the convention for a version kept back
during an upgrade). Clarity opens in `--couch`, its own TV mode.

## Settings

| | |
|---|---|
| **Sound** | Volume (through `omarchy-audio-output-volume`, so the OSD matches the rest of the system), mute, choose the output device, open the mixer. |
| **Network** | Wi-Fi on/off, the networks in range with signal and security, join one — type the password with the keyboard — disconnect, forget, restart Wi-Fi. NetworkManager (`nmcli`) underneath; the network TUI for anything else. |
| **Bluetooth** | Power, paired devices (one press connects or disconnects), search for new ones and pair. `omarchy-bluetooth-*` underneath. |
| **Apps** | Show or hide each AppImage (hiding never touches the file), remove pinned apps, add more. |
| **System** | The Omarchy menu, the current theme, hide or quit the launcher. |
| **Power** | Lock, sleep, restart, shut down, log out. Anything that ends the session asks twice, in place. |

## Keys

| Key | Home | Settings | Add app |
|---|---|---|---|
| Arrows | Move between tiles and shelves (up from Apps reaches the status chips) | Move; ←/→ adjust the volume | Move |
| Enter | Open | Select | Add to home |
| Del / Menu | Options: move, hide or remove | Options: forget a device or network | |
| Shift + ←/→ | Move the focused app one place along the shelf | | |
| A–Z | Jump to the next app starting with that letter | | Typing searches |
| Esc | Hide the launcher | Back | Clear search, then close |

The mouse does the same things: hover to focus, click to open, right-click for
options, wheel to walk along a shelf, and drag a tile to put it somewhere else.
The cursor hides itself after three still seconds.

### Arranging the apps

The Apps shelf is in whatever order you leave it. **Options › Move** lifts the
focused app: ←/→ carry it (Home/End to either end), Enter puts it down, Esc
puts everything back as it was. Shift+←/→ does the same one step at a time
without the mode, and dragging with the mouse works anywhere on the shelf. New
AppImages and newly pinned apps join at the end; hidden ones keep their place
for when they come back.

## Install

```bash
npm install
npm run dist          # → dist/OMATVLauncher-x86_64.AppImage
cp dist/OMATVLauncher-x86_64.AppImage ~/Applications/
```

(It does not list itself, even from `~/Applications`.)

Run it once, then turn on **Settings › System › Show in system menu**: that
writes `~/.local/share/applications/omatvlauncher.desktop` and its icon, so it
is in the Omarchy app menu from then on. The entry points at wherever the
AppImage is, and follows it if you move it; turning the switch off removes it.

It stays resident: running it again **toggles** it (`--show` and `--hide` do
just that), and launching an app hides it. When an AppImage started from home
exits, home comes back on its own.

Start it with the session in `~/.config/hypr/autostart.lua` (add `--hidden` to have it wait in the background until summoned):

```lua
o.launch_on_start("uwsm-app -- ~/Applications/OMATVLauncher-x86_64.AppImage")
```

and give it a key in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + M", "OMATVLauncher: toggle home", "uwsm-app -- ~/Applications/OMATVLauncher-x86_64.AppImage")
```

The window's `app_id` is `omatvlauncher`, for any Hyprland window rule.

## Configuration

`~/.config/omatvlauncher/launcher.json`, written by the launcher; edit by hand
if you like:

```json
{
  "version": 1,
  "pinned": [ { "id": "org.kde.krita", "label": "Krita" } ],
  "hidden": [ "/home/you/Applications/Something.AppImage" ],
  "args":   { "/home/you/Applications/Clarity.AppImage": ["--couch"] },
  "order":  [ "ai:/home/you/Applications/Clarity.AppImage", "de:org.kde.krita" ]
}
```

`args` gives an AppImage its command-line flags; an entry here replaces the
built-in `--couch` default for Clarity.

## Theme

Colours and wallpaper come from the current Omarchy theme
(`~/.local/state/omarchy/current`), and a theme switch restyles the launcher
live — no restart.

## Development

```bash
npm start                    # full screen, like the real thing
npm run dev                  # in a window
npx electron . --capture=/tmp/home.png --capture-keys=ArrowDown,Enter,wait1500
                             # render off-screen, press keys, save a PNG, exit
```

`--capture` uses its own profile and never shows a window, so it runs beside a
live copy.

## License

GPL-3.0, like the rest of this account's TV projects.
