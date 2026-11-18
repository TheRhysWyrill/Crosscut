import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
// electron-updater is CommonJS, so its exports only arrive through the default.
import updaterModule from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')

// Keep app data (settings, queue, caches) outside the read-only app bundle.
const DATA_PATH = path.join(app.getPath('userData'), 'data')
const LEGACY_DATA_PATH = path.join(app.getPath('appData'), 'Cutwright', 'data')

// The app was Cutwright before, so carry its settings and projects over once.
try {
  if (!fs.existsSync(DATA_PATH) && fs.existsSync(LEGACY_DATA_PATH)) {
    fs.cpSync(LEGACY_DATA_PATH, DATA_PATH, { recursive: true })
  }
} catch (err) {
  console.warn('[crosscut] could not carry over the old data folder:', err?.message ?? err)
}

process.env.CUTWRIGHT_DATA = DATA_PATH
// Where the executable sits, so projects can optionally be kept beside it.
process.env.CUTWRIGHT_APP_DIR = path.dirname(app.getPath('exe'))

// Groups the window under the app's own icon in the Windows taskbar.
app.setAppUserModelId('com.crosscut.app')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const API_PORT = Number(process.env.CUTWRIGHT_PORT) || 4545

// The goodbye screen asks for support, which only makes sense in the published
// installer. `npm run dist` stamps supportPrompt into the packaged
// package.json; `npm run package` (the unpacked local build) leaves it out, and
// so does running from source. CROSSCUT_NO_DONATION=1 still overrides.
function wantsSupportPrompt() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.supportPrompt === true || pkg.supportPrompt === 'true'
  } catch {
    return false
  }
}

const ASK_FOR_SUPPORT =
  app.isPackaged && wantsSupportPrompt() && process.env.CROSSCUT_NO_DONATION !== '1'

// The quit screen belongs to the renderer: it knows whether jobs are still
// running, which the donation card must never interrupt silently. These flags
// only decide what the renderer is allowed to show.
const QUIT_PROMPT = {
  support: ASK_FOR_SUPPORT,
  packaged: app.isPackaged,
  version: app.getVersion(),
}

// --------------------------------------------------------------------------
// updates
// --------------------------------------------------------------------------

// electron-updater reads the GitHub release feed configured in package.json.
// In a development build there is no feed, so the bridge still answers but
// reports that updates only apply to installed copies.
let updateStatus = { state: 'idle', version: '', percent: 0, message: '' }

// An unpacked test build has no app-update.yml; only a published build does.
// Checking anyway gives a filesystem error, so answer plainly instead.
function hasUpdateFeed() {
  return fs.existsSync(path.join(process.resourcesPath ?? '', 'app-update.yml'))
}

function broadcastUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateStatus)
  }
}

function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch }
  broadcastUpdate()
}

function setupUpdates() {
  if (!app.isPackaged || !hasUpdateFeed()) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => setUpdateStatus({ state: 'checking', message: 'Checking for updates…' }))
  autoUpdater.on('update-available', (info) =>
    setUpdateStatus({ state: 'available', version: info?.version ?? '', message: `Downloading ${info?.version ?? 'the update'}…` }),
  )
  autoUpdater.on('update-not-available', () =>
    setUpdateStatus({ state: 'current', message: 'CrossCut is up to date' }),
  )
  autoUpdater.on('download-progress', (progress) =>
    setUpdateStatus({ state: 'downloading', percent: Math.round(progress?.percent ?? 0) }),
  )
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateStatus({
      state: 'ready',
      version: info?.version ?? '',
      percent: 100,
      message: `Version ${info?.version ?? ''} is ready to install`,
    })
    // A job that is still encoding would be killed by the restart, so the
    // question is only asked when the app is otherwise idle-looking.
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        cancelId: 1,
        title: 'CrossCut update ready',
        message: `CrossCut ${info?.version ?? ''} has been downloaded.`,
        detail: 'Restarting closes any running export. You can also install it the next time you quit.',
      })
      .then((answer) => {
        if (answer.response === 0) {
          quitting = true
          autoUpdater.quitAndInstall()
        }
      })
      .catch(() => undefined)
  })
  autoUpdater.on('error', (err) =>
    setUpdateStatus({ state: 'error', message: err?.message ?? 'Could not check for updates' }),
  )

  const check = () => autoUpdater.checkForUpdates().catch(() => undefined)
  setTimeout(check, 8000)
  setInterval(check, 6 * 60 * 60 * 1000)
}

// Where the size, position and maximised state of the window are remembered.
const WINDOW_STATE_FILE = path.join(DATA_PATH, 'window.json')
const DEFAULT_BOUNDS = { width: 1560, height: 940 }
const MIN_BOUNDS = { width: 1180, height: 720 }

function loadWindowState() {
  try {
    const data = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'))
    if (!data || typeof data !== 'object') return null
    const num = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : undefined)
    return {
      maximized: Boolean(data.maximized),
      x: num(data.x),
      y: num(data.y),
      width: num(data.width),
      height: num(data.height),
    }
  } catch {
    return null
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const normal = mainWindow.getNormalBounds()
  const state = {
    maximized: mainWindow.isMaximized(),
    x: normal.x,
    y: normal.y,
    width: normal.width,
    height: normal.height,
  }
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true })
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    console.warn('[crosscut] could not save the window state:', err?.message ?? err)
  }
}

// Clamp a remembered rectangle onto a display that still exists, so unplugging
// a second monitor cannot leave the window stranded off-screen.
function fitToDisplays(state) {
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  const primary = screen.getPrimaryDisplay().workArea
  const width = Math.min(Math.max(state.width ?? DEFAULT_BOUNDS.width, MIN_BOUNDS.width), 16000)
  const height = Math.min(Math.max(state.height ?? DEFAULT_BOUNDS.height, MIN_BOUNDS.height), 16000)
  const cx = (state.x ?? 0) + width / 2
  const cy = (state.y ?? 0) + height / 2
  const host =
    areas.find((area) => cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height) ||
    primary
  const w = Math.min(width, host.width)
  const h = Math.min(height, host.height)
  const x = state.x === undefined ? host.x + (host.width - w) / 2 : state.x
  const y = state.y === undefined ? host.y + (host.height - h) / 2 : state.y
  return {
    width: Math.round(w),
    height: Math.round(h),
    x: Math.round(Math.min(Math.max(x, host.x), host.x + host.width - w)),
    y: Math.round(Math.min(Math.max(y, host.y), host.y + host.height - h)),
  }
}

const { autoUpdater } = updaterModule

let mainWindow = null
let apiUrl = ''
// Closing the window shows a thank-you screen first, so the real close waits
// for the renderer to answer; this flag lets the confirmed close through.
let quitting = false

const MEDIA_FILTERS = [
  {
    name: 'Video and audio',
    extensions: [
      'mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg',
      'wmv', 'flv', 'mxf', 'ogv', '3gp', 'vob',
      'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'mka',
    ],
  },
  { name: 'Video', extensions: ['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mpg', 'wmv', 'flv'] },
  { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'mka'] },
  { name: 'All files', extensions: ['*'] },
]

function registerIpc() {
  ipcMain.handle('dialog:open-media', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Open media',
      buttonLabel: 'Open',
      properties: ['openFile', options.multiple ? 'multiSelections' : 'createDirectory'].filter(
        (value) => value !== 'createDirectory',
      ),
      filters: MEDIA_FILTERS,
      defaultPath: options.defaultPath || undefined,
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('dialog:open-files', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select files',
      properties: ['openFile', options.multiple ? 'multiSelections' : 'openFile'],
      filters: options.filters || MEDIA_FILTERS,
      defaultPath: options.defaultPath || undefined,
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('dialog:open-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: options.defaultPath || undefined,
    })
    if (result.canceled || !result.filePaths.length) return ''
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:pick-ffmpeg', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select the folder that contains ffmpeg.exe',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'FFmpeg binary', extensions: ['exe'] }],
    })
    if (result.canceled || !result.filePaths.length) return ''
    const picked = result.filePaths[0]
    return picked.replace(/[\\/]ffmpeg(\.exe)?$/i, '')
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize() ?? false)

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
    return true
  })

  ipcMain.handle('app:quit', () => {
    quitting = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    else app.quit()
    return true
  })

  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle('shell:reveal', async (_event, target) => {
    if (!target) return false
    shell.showItemInFolder(String(target))
    return true
  })

  ipcMain.handle('shell:open', async (_event, target) => {
    if (!target) return false
    await shell.openPath(String(target))
    return true
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: process.env.CUTWRIGHT_DATA,
    apiUrl,
    electron: process.versions.electron,
    ...QUIT_PROMPT,
  }))

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged || !hasUpdateFeed()) {
      updateStatus = {
        state: 'unavailable',
        version: app.getVersion(),
        percent: 0,
        message: 'This build has no update feed; install a release build to get updates',
      }
      broadcastUpdate()
      return updateStatus
    }
    setUpdateStatus({ state: 'checking', message: 'Checking for updates…' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setUpdateStatus({ state: 'error', message: err?.message ?? 'Could not check for updates' })
    }
    return updateStatus
  })

  ipcMain.handle('update:install', () => {
    if (updateStatus.state !== 'ready') return false
    quitting = true
    autoUpdater.quitAndInstall()
    return true
  })
}

function createWindow() {
  quitting = false
  const saved = loadWindowState()
  const bounds = saved ? fitToDisplays(saved) : null

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_BOUNDS.width,
    height: bounds?.height ?? DEFAULT_BOUNDS.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    backgroundColor: '#0c0d10',
    title: 'CrossCut',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    // Frameless: the app's own top bar is the title bar, with its own controls.
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  // Asking before the window is visible queues the maximise; asking again after
  // it is shown catches the case where Windows dropped the first request.
  if (saved?.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (saved?.maximized) {
      let tries = 0
      const applyMaximize = () => {
        if (!mainWindow || mainWindow.isDestroyed() || tries >= 6) return
        if (mainWindow.isMaximized()) return
        tries += 1
        mainWindow.maximize()
        setTimeout(applyMaximize, 150)
      }
      applyMaximize()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep the custom maximise/restore button in sync with the real window state.
  const sendMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
    queueSave()
  }
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  // Remember where and how big the window is, without thrashing the disk.
  let saveTimer = null
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveWindowState()
    }, 400)
  }
  mainWindow.on('resize', queueSave)
  mainWindow.on('move', queueSave)
  // Ask the renderer for a goodbye instead of closing straight away; Alt+F4,
  // the taskbar and the app's own close button all come through here.
  // The renderer decides what to show: a warning when the queue is still
  // working, the support card in a published build, or nothing at all. It
  // answers with `app:quit` once the user has had their say.
  mainWindow.on('close', (event) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowState()
    if (quitting || !mainWindow || mainWindow.webContents.isDestroyed()) return
    event.preventDefault()
    mainWindow.webContents.send('app:quit-requested')
  })
  // A window cannot be kept open while Windows shuts down, and a crashed
  // renderer will never answer, so both close immediately.
  mainWindow.on('session-end', () => {
    quitting = true
  })
  mainWindow.webContents.on('render-process-gone', () => {
    quitting = true
  })

  // Keep navigation inside the app; open real links in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = DEV_URL || apiUrl
  if (!target) throw new Error('No front-end target to load')
  mainWindow.loadURL(target)

  if (process.env.CUTWRIGHT_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      const { startServer } = await import('../server/index.mjs')
      const started = await startServer(API_PORT)
      apiUrl = started.url
      console.log(`[crosscut] engine ready at ${apiUrl}`)
    } catch (err) {
      dialog.showErrorBox(
        'CrossCut could not start',
        `The processing engine failed to start.\n\n${err?.message ?? err}`,
      )
      app.quit()
      return
    }

    registerIpc()
    createWindow()
    setupUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
