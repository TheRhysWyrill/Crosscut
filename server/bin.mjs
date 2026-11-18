import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, settings } from './config.mjs'

const isWin = process.platform === 'win32'
const exe = isWin ? '.exe' : ''
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function which(name) {
  const cmd = isWin ? 'where' : 'which'
  try {
    const res = spawnSync(cmd, [name], { encoding: 'utf8', windowsHide: true })
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
      if (first) return first
    }
  } catch {
    /* not on PATH */
  }
  return ''
}

function filesIn(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * FFmpeg copies the app can use on its own. A copy refreshed from inside the
 * app lives in the writable data folder and wins, because the packaged one sits
 * in Program Files and cannot be replaced without an installer.
 */
function managedDirs() {
  return [path.join(DATA_DIR, 'ffmpeg')]
}

/** The FFmpeg pair that ships with the app: the packaged copy first, then the
 *  working folder `npm run ffmpeg` fills when running from source. */
function bundledDirs() {
  const dirs = []
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'))
  dirs.push(path.join(ROOT, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`))
  return dirs
}

function knownBundles() {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramW6432'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'),
  ].filter(Boolean)

  const appDirs = [
    'LosslessCut-win-x64',
    'LosslessCut',
    path.join('Shutter Encoder', 'runtime'),
    path.join('Shutter Encoder', 'Library'),
    'Shutter Encoder',
    path.join('Solveig Multimedia', 'SolveigMM Video Splitter x64'),
    path.join('Solveig Multimedia', 'SolveigMM Video Splitter'),
  ]

  const dirs = []
  for (const root of roots) {
    for (const appDir of appDirs) dirs.push(path.join(root, appDir))
  }
  dirs.push(
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), 'bin'),
  )

  const found = []
  for (const dir of dirs) {
    for (const file of filesIn(dir)) {
      if (/^(ffmpeg|ffprobe)(\.exe)?$/i.test(path.basename(file))) found.push(file)
    }
  }
  return found
}

function pairFor(candidate) {
  if (!candidate) return null
  let file = candidate
  // A folder is the usual way to configure this, so look inside it first.
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, `ffmpeg${exe}`)
  } catch {
    return null
  }
  if (!fs.existsSync(file) && !/\.exe$/i.test(file) && isWin && fs.existsSync(`${file}.exe`)) file = `${file}.exe`
  if (!fs.existsSync(file)) return null
  const dir = path.dirname(file)
  const probeName = path.basename(file).replace(/^ffmpeg/i, 'ffprobe')
  const probePath = path.join(dir, probeName)
  return { ffmpeg: file, ffprobe: fs.existsSync(probePath) ? probePath : '' }
}

function probeVersion(ffmpegPath) {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    if (res.status !== 0) return null
    const firstLine = (res.stdout || '').split(/\r?\n/)[0] || ''
    const match = firstLine.match(/ffmpeg version (\S+)/i)
    return { version: match ? match[1] : firstLine.trim(), config: firstLine }
  } catch {
    return null
  }
}

function detectEncoders(ffmpegPath) {
  const set = new Set()
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    })
    for (const line of (res.stdout || '').split(/\r?\n/)) {
      const match = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/)
      if (match) set.add(match[1])
    }
  } catch {
    /* encoders unavailable */
  }
  return set
}

let cached = null

export function detectTools({ force = false } = {}) {
  if (cached && !force) return cached

  // The bundled build wins: the app always has a known-good FFmpeg. A folder
  // chosen in Settings, FFMPEG_PATH or the PATH is only a fallback for a build
  // where the bundled copy is missing.
  const managed = managedDirs()
  const bundled = bundledDirs()
  const candidates = [...managed, ...bundled]
  const fromSettings = String(settings.ffmpegDir || '').trim()
  if (fromSettings) candidates.push(fromSettings)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)

  const onPath = which(`ffmpeg${exe}`) || which('ffmpeg')
  if (onPath) candidates.push(onPath)

  candidates.push(...knownBundles())

  let resolved = null
  let source = ''
  for (const candidate of candidates) {
    const pair = pairFor(candidate)
    if (pair && pair.ffmpeg && pair.ffprobe) {
      resolved = pair
      source = managed.includes(candidate)
        ? 'updated'
        : bundled.includes(candidate)
        ? 'bundled'
        : candidate === fromSettings
          ? 'settings'
          : candidate === process.env.FFMPEG_PATH
            ? 'FFMPEG_PATH'
            : candidate === onPath
              ? 'PATH'
              : 'installed app'
      break
    }
  }

  // Last resort: ffmpeg without ffprobe still allows encoding, but probing fails.
  if (!resolved) {
    for (const candidate of candidates) {
      const pair = pairFor(candidate)
      if (pair) {
        resolved = pair
        source = 'partial'
        break
      }
    }
  }

  const version = resolved ? probeVersion(resolved.ffmpeg) : null
  const encoders = resolved ? detectEncoders(resolved.ffmpeg) : new Set()

  cached = {
    ffmpeg: resolved?.ffmpeg ?? '',
    ffprobe: resolved?.ffprobe ?? '',
    source,
    version: version?.version ?? '',
    banner: version?.config ?? '',
    encoders,
    ok: Boolean(resolved?.ffmpeg && resolved?.ffprobe && version),
    checkedAt: Date.now(),
  }
  return cached
}

export function tools() {
  const found = detectTools()
  if (!found.ok) {
    throw new Error(
      'FFmpeg/ffprobe not found. Install FFmpeg or set the FFmpeg folder in Settings.',
    )
  }
  return found
}

export { pairFor, probeVersion }

export function hasEncoder(name) {
  return detectTools().encoders.has(name)
}

export function toolStatus() {
  const found = detectTools()
  const encoders = [...found.encoders]
  return {
    ok: found.ok,
    ffmpeg: found.ffmpeg,
    ffprobe: found.ffprobe,
    source: found.source,
    version: found.version,
    checkedAt: found.checkedAt,
    hardware: {
      nvenc: encoders.includes('h264_nvenc') || encoders.includes('hevc_nvenc'),
      qsv: encoders.includes('h264_qsv') || encoders.includes('hevc_qsv'),
      amf: encoders.includes('h264_amf') || encoders.includes('hevc_amf'),
      av1: encoders.includes('libsvtav1') || encoders.includes('av1_nvenc'),
    },
    encoders: {
      x264: encoders.includes('libx264'),
      x265: encoders.includes('libx265'),
      svtav1: encoders.includes('libsvtav1'),
      vp9: encoders.includes('libvpx-vp9'),
      prores: encoders.includes('prores_ks') || encoders.includes('prores'),
      dnxhd: encoders.includes('dnxhd'),
      opus: encoders.includes('libopus'),
    },
  }
}
