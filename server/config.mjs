import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Electron points this at the per-user app data folder so the installed app
// never tries to write inside its own (read-only) bundle.
export const DATA_DIR = process.env.CUTWRIGHT_DATA
  ? path.resolve(process.env.CUTWRIGHT_DATA)
  : path.join(ROOT, 'data')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const TEMP_DIR = path.join(DATA_DIR, 'temp')

for (const dir of [
  DATA_DIR,
  CACHE_DIR,
  TEMP_DIR,
  path.join(CACHE_DIR, 'thumbs'),
  path.join(CACHE_DIR, 'keyframes'),
  path.join(CACHE_DIR, 'waveforms'),
  path.join(CACHE_DIR, 'audiotracks'),
]) {
  fs.mkdirSync(dir, { recursive: true })
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

const DEFAULTS = {
  ffmpegDir: '',
  // Empty means the default under the app data folder.
  projectsDir: '',
  concurrency: 1,
  outDir: path.join(os.homedir(), 'Videos', 'CrossCut exports'),
  lastDir: os.homedir(),
  hardware: 'auto',
  accent: '#f0a33c',
  // Interface state worth remembering between sessions.
  queueOpen: true,
  // The project that was open, so Settings can reopen it at launch.
  lastProjectId: '',
  // Off by default: the app starts with an empty timeline.
  reopenLastProject: false,
  // The one-time walkthrough is done.
  seenTour: false,
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('[store] write failed', file, err.message)
  }
}

export const settings = { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) }

export function saveSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) settings[key] = value
  }
  writeJson(SETTINGS_FILE, settings)
  return settings
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** The app's own folder, next to the executable when packaged. */
export const APP_DIR = process.env.CUTWRIGHT_APP_DIR ? path.resolve(process.env.CUTWRIGHT_APP_DIR) : ROOT

export const DEFAULT_PROJECTS_DIR = path.join(DATA_DIR, 'projects')

/** Where saved projects live: the configured folder, or the default. */
export function projectDirectory() {
  const custom = String(settings.projectsDir || '').trim()
  const dir = custom ? path.resolve(custom) : DEFAULT_PROJECTS_DIR
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Turn any user supplied name into something safe for a filename.
export function safeName(name, fallback = 'clip') {
  const cleaned = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return (cleaned || fallback).slice(0, 120)
}

// Never overwrite silently: file.mp4 -> file (2).mp4
export function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let i = 2; i < 5000; i += 1) {
    const next = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(next)) return next
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}
