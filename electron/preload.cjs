const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  openMedia: (options) => ipcRenderer.invoke('dialog:open-media', options ?? {}),
  openFiles: (options) => ipcRenderer.invoke('dialog:open-files', options ?? {}),
  openDirectory: (options) => ipcRenderer.invoke('dialog:open-directory', options ?? {}),
  pickFfmpegFolder: () => ipcRenderer.invoke('dialog:pick-ffmpeg'),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  info: () => ipcRenderer.invoke('app:info'),
  quit: () => ipcRenderer.invoke('app:quit'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  onQuitRequest: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:quit-requested', listener)
    return () => ipcRenderer.removeListener('app:quit-requested', listener)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('window:maximized-changed', listener)
      return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})
