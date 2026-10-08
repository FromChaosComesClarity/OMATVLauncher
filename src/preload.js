'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The page's whole view of the machine: named requests, no paths, no commands.
contextBridge.exposeInMainWorld('tv', {
  home: () => ipcRenderer.invoke('home'),
  theme: () => ipcRenderer.invoke('theme'),
  catalog: () => ipcRenderer.invoke('catalog'),
  launch: key => ipcRenderer.invoke('launch', key),
  pin: entry => ipcRenderer.invoke('pin', entry),
  unpin: id => ipcRenderer.invoke('unpin', id),
  setHidden: (path, hidden) => ipcRenderer.invoke('setHidden', { path, hidden }),

  status: () => ipcRenderer.invoke('status'),
  audio: () => ipcRenderer.invoke('audio'),
  network: () => ipcRenderer.invoke('network'),
  wifiNetworks: rescan => ipcRenderer.invoke('wifiNetworks', rescan),
  bluetooth: () => ipcRenderer.invoke('bluetooth'),
  bluetoothScan: () => ipcRenderer.invoke('bluetoothScan'),
  action: (name, args) => ipcRenderer.invoke('action', name, args),

  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),

  on: (channel, fn) => {
    if (!['theme', 'icon', 'shown'].includes(channel)) return
    ipcRenderer.on(channel, (_e, payload) => fn(payload))
  }
})
