import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  APP_DIR,
  DATA_DIR,
  DEFAULT_PROJECTS_DIR,
  ROOT,
  ensureDir,
  projectDirectory,
  readJson,
  saveSettings,
  settings,
  writeJson,
} from './config.mjs'
import { detectTools, toolStatus } from './bin.mjs'
import { keyframes, probe } from './probe.mjs'
import {
  AUDIO_WINDOW_SECONDS,
  MAX_WINDOW_SECONDS,
  audioTrackState,
  filmstrip,
  overviewState,
  pruneCaches,
  sweepTemp,
  thumbnail,
  waveformWindow,
} from './media.mjs'
import { presetCatalog } from './presets.mjs'
import { JobQueue } from './queue.mjs'
import { compareSync, verifyOutput } from './tasks.mjs'
import { checkFfmpegUpdate } from './ffmpeg-update.mjs'
import { deleteProject, listProjects, saveProject } from './projects.mjs'

const PORT = Number(process.env.PORT) || 4545
const APP_VERSION = readJson(path.join(ROOT, 'package.json'), {}).version ?? ''
const app = express()
app.use(express.json({ limit: '20mb' }))

const queue = new JobQueue()
queue.setConcurrency(settings.concurrency || 1)

const CUTLIST_FILE = path.join(DATA_DIR, 'cutlists.json')

const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg',
  'wmv', 'flv', 'mxf', 'ogv', '3gp', 'vob', 'rmvb', 'asf', 'f4v',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'mka', 'aiff', 'aif', 'alac',
  'srt', 'ass', 'vtt', 'ssa',
])

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mka: 'audio/x-matroska',
  wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg',
  png: 'image/png',
}

function mimeFor(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream'
}

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? String(err) })
      else res.end()
    })
  }
}

function requirePath(value, label = 'path') {
  if (!value || typeof value !== 'string') {
    const err = new Error(`Missing ${label}`)
    err.status = 400
    throw err
  }
  return path.resolve(value)
}

// ---------------------------------------------------------------------------
// status + settings
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    tools: toolStatus(),
    settings,
    platform: process.platform,
    home: os.homedir(),
    dataDir: DATA_DIR,
    projectsDir: projectDirectory(),
    defaultProjectsDir: DEFAULT_PROJECTS_DIR,
    appDir: APP_DIR,
  })
})

app.get('/api/settings', (_req, res) => {
  res.json({ settings, tools: toolStatus() })
})

app.post('/api/settings', (req, res) => {
  const patch = req.body ?? {}
  const allowed = [
    'ffmpegDir',
    'outDir',
    'concurrency',
    'lastDir',
    'hardware',
    'accent',
    'projectsDir',
    'queueOpen',
    'lastProjectId',
    'reopenLastProject',
    'seenTour',
  ]
  const clean = {}
  for (const key of allowed) if (patch[key] !== undefined) clean[key] = patch[key]
  if (clean.concurrency) clean.concurrency = Math.max(1, Math.min(8, Number(clean.concurrency) || 1))
  if (clean.accent !== undefined && !/^#[0-9a-f]{6}$/i.test(String(clean.accent))) delete clean.accent
  if (clean.queueOpen !== undefined) clean.queueOpen = Boolean(clean.queueOpen)
  if (clean.seenTour !== undefined) clean.seenTour = Boolean(clean.seenTour)
  if (clean.lastProjectId !== undefined) clean.lastProjectId = String(clean.lastProjectId ?? '').trim().slice(0, 120)
  if (clean.reopenLastProject !== undefined) clean.reopenLastProject = Boolean(clean.reopenLastProject)
  if (clean.projectsDir !== undefined) {
    const raw = String(clean.projectsDir ?? '').trim()
    if (!raw) {
      clean.projectsDir = ''
    } else {
      const resolved = path.resolve(raw)
      try {
        fs.mkdirSync(resolved, { recursive: true })
        fs.accessSync(resolved, fs.constants.W_OK)
      } catch (err) {
        res.status(400).json({ error: `Cannot save projects there: ${err.message}` })
        return
      }
      clean.projectsDir = resolved
    }
  }
  const saved = saveSettings(clean)
  if (clean.ffmpegDir !== undefined) detectTools({ force: true })
  if (clean.concurrency) queue.setConcurrency(saved.concurrency)
  res.json({
    settings: saved,
    tools: toolStatus(),
    projectsDir: projectDirectory(),
    defaultProjectsDir: DEFAULT_PROJECTS_DIR,
    appDir: APP_DIR,
  })
})

app.post('/api/settings/refresh-tools', (_req, res) => {
  detectTools({ force: true })
  res.json({ tools: toolStatus() })
})

// ---------------------------------------------------------------------------
// filesystem browsing
// ---------------------------------------------------------------------------

app.get('/api/fs/roots', (_req, res) => {
  const home = os.homedir()
  const roots = [
    { label: 'Home', path: home },
    { label: 'Videos', path: path.join(home, 'Videos') },
    { label: 'Downloads', path: path.join(home, 'Downloads') },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Documents', path: path.join(home, 'Documents') },
    { label: 'Exports', path: settings.outDir },
  ].filter((entry) => {
    try {
      return fs.statSync(entry.path).isDirectory()
    } catch {
      return false
    }
  })

  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`
      try {
        if (fs.existsSync(drive)) roots.push({ label: drive, path: drive })
      } catch {
        /* skip */
      }
    }
  } else {
    roots.push({ label: '/', path: '/' })
  }
  res.json({ roots, lastDir: settings.lastDir })
})

app.get('/api/fs/list', (req, res) => {
  const target = req.query.path ? path.resolve(String(req.query.path)) : path.resolve(settings.lastDir || os.homedir())
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    res.status(404).json({ error: `Cannot open ${target}` })
    return
  }
  const dir = stat.isDirectory() ? target : path.dirname(target)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const full = path.join(dir, entry.name)
      const ext = path.extname(entry.name).slice(1).toLowerCase()
      let size = 0
      let mtime = 0
      try {
        const info = fs.statSync(full)
        size = info.size
        mtime = info.mtimeMs
      } catch {
        /* ignore */
      }
      return {
        name: entry.name,
        path: full,
        isDir: entry.isDirectory(),
        ext,
        size,
        mtime,
        media: !entry.isDirectory() && MEDIA_EXTENSIONS.has(ext),
      }
    })
  } catch (err) {
    res.status(403).json({ error: `Cannot read ${dir}: ${err.message}` })
    return
  }

  const filter = String(req.query.filter || 'media')
  const visible = entries
    .filter((entry) => {
      if (entry.name.startsWith('.')) return false
      if (entry.isDir) return true
      if (filter === 'all') return true
      return entry.media
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  res.json({
    dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    entries: visible,
    allCount: entries.length,
  })
})

app.get('/api/fs/stat', (req, res) => {
  try {
    const target = requirePath(req.query.path)
    const stat = fs.statSync(target)
    res.json({ exists: true, isDir: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs })
  } catch {
    res.json({ exists: false })
  }
})

app.post('/api/fs/reveal', (req, res) => {
  try {
    const target = requirePath(req.body?.path)
    if (process.platform === 'win32') {
      spawn('explorer', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref()
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve media with byte ranges so the browser can seek without downloading.
app.get('/api/stream', (req, res) => {
  let file
  try {
    file = requirePath(req.query.path)
  } catch {
    res.status(400).end()
    return
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    res.status(404).end()
    return
  }
  const total = stat.size
  const range = req.headers.range
  res.setHeader('Content-Type', mimeFor(file))
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')

  if (!range) {
    res.setHeader('Content-Length', total)
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    return
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) {
    res.status(416).end()
    return
  }
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
  if (start >= total || start > end) {
    res.setHeader('Content-Range', `bytes */${total}`)
    res.status(416).end()
    return
  }
  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  res.setHeader('Content-Length', end - start + 1)
  // A seek abandons the request mid-stream; closing the file handle at once
  // keeps fast scrubbing on a 30 GB file from piling up open reads.
  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
})

// ---------------------------------------------------------------------------
// media inspection
// ---------------------------------------------------------------------------

app.post('/api/probe', asyncRoute(async (req, res) => {
  const file = requirePath(req.body?.path)
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'File not found' })
    return
  }
  const info = await probe(file)
  saveSettings({ lastDir: path.dirname(file) })
  res.json({ info, tools: toolStatus() })
}))

app.post('/api/keyframes', asyncRoute(async (req, res) => {
  const file = requirePath(req.body?.path)
  const start = Number(req.body?.start)
  const end = Number(req.body?.end)
  // With a window this seeks, so a 20 hour recording is not scanned for a view
  // that only shows a few minutes of it.
  const frames = await keyframes(file, start, end)
  res.json({ frames })
}))

// Waveforms are decoded per visible window, never for the whole file up front.
app.get('/api/media/waveform', asyncRoute(async (req, res) => {
  const file = requirePath(req.query.path)
  const buckets = Math.max(200, Math.min(8000, Number(req.query.buckets) || 2000))
  const start = Number(req.query.start)
  const end = Number(req.query.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    res.json({ state: 'coarse', progress: 0, peaks: null, error: '', start: 0, end: 0, maxWindow: MAX_WINDOW_SECONDS })
    return
  }
  const track = Math.max(0, Number(req.query.track) || 0)
  const state = await waveformWindow(file, start, end, buckets, track)
  res.json({ ...state, maxWindow: MAX_WINDOW_SECONDS })
}))

app.get('/api/media/overview', asyncRoute(async (req, res) => {
  const file = requirePath(req.query.path)
  const buckets = Math.max(1000, Math.min(20000, Number(req.query.buckets) || 4000))
  const track = Math.max(0, Number(req.query.track) || 0)
  res.json(await overviewState(file, buckets, track))
}))

// One audio track of a file as its own AAC file, for previewing a track the
// browser cannot switch to inside the original container.
app.get('/api/media/audiotrack', asyncRoute(async (req, res) => {
  const file = requirePath(req.query.path)
  const track = Math.max(0, Number(req.query.track) || 0)
  const start = Math.max(0, Number(req.query.start) || 0)
  const length = Number(req.query.length) || AUDIO_WINDOW_SECONDS
  res.json(await audioTrackState(file, track, start, length))
}))

app.get('/api/media/thumb', asyncRoute(async (req, res) => {
  const file = requirePath(req.query.path)
  const time = Number(req.query.time) || 0
  const width = Math.max(48, Math.min(640, Number(req.query.w) || 160))
  const target = await thumbnail(file, time, width)
  if (!target) {
    res.status(404).end()
    return
  }
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'max-age=86400')
  fs.createReadStream(target).pipe(res)
}))

app.get('/api/media/filmstrip', asyncRoute(async (req, res) => {
  const file = requirePath(req.query.path)
  const start = Number(req.query.start) || 0
  const end = Number(req.query.end) || start + 60
  const count = Math.max(1, Math.min(24, Number(req.query.count) || 10))
  const width = Math.max(64, Math.min(320, Number(req.query.w) || 150))
  const frames = await filmstrip(file, start, end, count, width)
  res.json({ frames })
}))

app.get('/api/presets', (_req, res) => {
  res.json(presetCatalog())
})

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

app.get('/api/queue', (_req, res) => {
  res.json(queue.snapshot())
})

app.post('/api/queue/jobs', (req, res) => {
  const { type, label, params } = req.body ?? {}
  if (!type || !params) {
    res.status(400).json({ error: 'type and params are required' })
    return
  }
  const job = queue.add({ type, label, params })
  res.json({ job })
})

app.post('/api/queue/batch', (req, res) => {
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : []
  const created = jobs
    .filter((entry) => entry?.type && entry?.params)
    .map((entry) => queue.add({ type: entry.type, label: entry.label, params: entry.params }))
  res.json({ jobs: created })
})

app.post('/api/queue/start', (_req, res) => {
  queue.start()
  res.json(queue.snapshot())
})

app.post('/api/queue/pause', (_req, res) => {
  queue.pause()
  res.json(queue.snapshot())
})

app.post('/api/queue/resume-interrupted', (_req, res) => {
  const resumed = queue.resumeInterrupted()
  res.json({ resumed, queue: queue.snapshot() })
})

app.post('/api/queue/cancel-all', (_req, res) => {
  queue.cancelAll()
  res.json(queue.snapshot())
})

app.post('/api/queue/concurrency', (req, res) => {
  const value = queue.setConcurrency(req.body?.concurrency)
  saveSettings({ concurrency: value })
  res.json(queue.snapshot())
})

app.post('/api/queue/reorder', (req, res) => {
  queue.reorder(Array.isArray(req.body?.ids) ? req.body.ids : [])
  res.json(queue.snapshot())
})

app.post('/api/queue/clear', (req, res) => {
  const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses : undefined
  if (statuses) queue.clear(statuses)
  else queue.clear()
  res.json(queue.snapshot())
})

app.post('/api/queue/:id/:action', (req, res) => {
  const { id, action } = req.params
  let ok = false
  if (action === 'cancel') ok = queue.cancel(id)
  else if (action === 'retry') ok = queue.retry(id)
  else if (action === 'remove') ok = queue.remove(id)
  else {
    res.status(400).json({ error: `Unknown action ${action}` })
    return
  }
  res.json({ ok, queue: queue.snapshot() })
})

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  send('queue', queue.snapshot())
  send('tools', toolStatus())

  // The tools status rides along with every queue update, so an FFmpeg refresh
  // shows its new version without another poll.
  const onUpdate = (snapshot) => {
    send('queue', snapshot)
    send('tools', toolStatus())
  }
  queue.on('update', onUpdate)
  const ping = setInterval(() => res.write(': ping\n\n'), 15000)

  req.on('close', () => {
    clearInterval(ping)
    queue.off('update', onUpdate)
  })
})

// ---------------------------------------------------------------------------
// sync helpers + cut lists
// ---------------------------------------------------------------------------

app.post('/api/verify', asyncRoute(async (req, res) => {
  const file = requirePath(req.body?.path, 'output')
  res.json(await verifyOutput(file))
}))

// ---------------------------------------------------------------------------
// bundled ffmpeg
// ---------------------------------------------------------------------------

app.get('/api/ffmpeg/update-check', asyncRoute(async (_req, res) => {
  res.json(await checkFfmpegUpdate())
}))

app.post('/api/ffmpeg/update', asyncRoute(async (_req, res) => {
  const job = queue.add({ type: 'tool', label: 'FFmpeg update', params: {} })
  queue.start()
  res.json({ job, queue: queue.snapshot() })
}))

app.post('/api/sync/compare', asyncRoute(async (req, res) => {
  const result = await compareSync({
    video: requirePath(req.body?.video, 'video'),
    audio: requirePath(req.body?.audio, 'audio'),
  })
  res.json(result)
}))

app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects() })
})

app.post('/api/projects', (req, res) => {
  const project = saveProject(req.body ?? {})
  res.json({ project })
})

app.delete('/api/projects/:id', (req, res) => {
  res.json({ ok: deleteProject(req.params.id) })
})

app.get('/api/cutlists', (_req, res) => {
  res.json(readJson(CUTLIST_FILE, {}))
})

app.post('/api/cutlists', (req, res) => {
  const file = requirePath(req.body?.path)
  const store = readJson(CUTLIST_FILE, {})
  const segments = Array.isArray(req.body?.segments) ? req.body.segments : []
  if (segments.length === 0) delete store[file]
  else store[file] = { segments, updatedAt: Date.now(), duration: req.body?.duration ?? 0 }
  writeJson(CUTLIST_FILE, store)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// static client
// ---------------------------------------------------------------------------

const DIST = path.join(ROOT, 'dist')
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.use((err, _req, res, _next) => {
  const status = err?.status || 500
  res.status(status).json({ error: err?.message ?? String(err) })
})

ensureDir(settings.outDir)
pruneCaches()
const swept = sweepTemp()
if (swept.removed) {
  console.log(`[crosscut] cleared ${swept.removed} stale temp entr${swept.removed === 1 ? 'y' : 'ies'}`)
}
detectTools()

/** Start the local engine. Electron imports this; `npm run server` also uses it. */
export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address()?.port ?? port
      const status = toolStatus()
      console.log(`[crosscut] engine on http://127.0.0.1:${actual}`)
      console.log(`[crosscut] data folder ${DATA_DIR}`)
      console.log(
        status.ok
          ? `[crosscut] ffmpeg ${status.version} (${status.source})`
          : '[crosscut] ffmpeg not found — point at it in Settings',
      )
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}` })
    })
    server.on('error', reject)
  })
}

export { app, queue }

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  startServer().catch((err) => {
    console.error('[crosscut] could not start:', err?.message ?? err)
    process.exit(1)
  })
}
