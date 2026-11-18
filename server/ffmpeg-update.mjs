// Refreshes the FFmpeg the app uses without shipping a new installer.
//
// The packaged copy lives in Program Files and cannot be replaced by a running
// app, so a refreshed build is unpacked into the writable data folder instead.
// `bin.mjs` checks that folder before the bundled one.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DATA_DIR, TEMP_DIR, ensureDir, writeJson } from './config.mjs'
import { detectTools, toolStatus } from './bin.mjs'

const VERSION_URL = 'https://www.gyan.dev/ffmpeg/builds/release-version'
const ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const TARGET_DIR = path.join(DATA_DIR, 'ffmpeg')

/** "9.0.2-essentials_build-www.gyan.dev" and "9.0.2" both give [9, 0, 2]. */
function numbers(version) {
  return String(version || '')
    .replace(/^n/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
}

function isNewer(candidate, current) {
  const a = numbers(candidate)
  const b = numbers(current)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

function installedVersion() {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(TARGET_DIR, 'version.json'), 'utf8'))
    if (stamp?.version) return String(stamp.version)
  } catch {
    /* never refreshed here */
  }
  const status = toolStatus()
  return status.source === 'updated' ? status.version : ''
}

async function latestVersion() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(VERSION_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`gyan.dev answered ${response.status}`)
    const text = (await response.text()).trim().split(/\r?\n/)[0]
    if (!/^\d/.test(text)) throw new Error('Could not read the current FFmpeg version')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Whether a newer release build exists, without downloading anything. */
export async function checkFfmpegUpdate() {
  const current = installedVersion() || toolStatus().version
  try {
    const latest = await latestVersion()
    return {
      current,
      latest,
      updateAvailable: isNewer(latest, current),
      managed: Boolean(installedVersion()),
      url: ZIP_URL,
    }
  } catch (err) {
    return { current, latest: '', updateAvailable: false, managed: Boolean(installedVersion()), error: err?.message ?? String(err) }
  }
}

async function download(url, target, onProgress) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
    const total = Number(response.headers.get('content-length')) || 0
    const out = fs.createWriteStream(target)
    let done = 0
    let lastTick = 0
    for await (const chunk of response.body) {
      done += chunk.length
      out.write(chunk)
      const now = Date.now()
      if (now - lastTick > 400) {
        lastTick = now
        onProgress(total ? Math.min(99, (done / total) * 100) : 0, done, total)
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()))
    })
    return done
  } finally {
    clearTimeout(timer)
  }
}

function walk(dir, depth = 0) {
  const found = []
  if (depth > 4) return found
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, depth + 1))
    else found.push(full)
  }
  return found
}

/**
 * Runs as a queue job so the download shows up like any other piece of work,
 * with progress and a log the user can read.
 */
export async function updateFfmpeg(ctx) {
  ctx.stage('Checking gyan.dev for the current build')
  const latest = await latestVersion()
  const current = installedVersion() || toolStatus().version
  if (!isNewer(latest, current)) {
    ctx.log(`FFmpeg ${current} is already the current release build`)
    ctx.progress(100, {})
    return { outputs: [], result: { updated: false, version: current } }
  }

  ctx.log(`Downloading FFmpeg ${latest} (about 100 MB)`)
  ensureDir(TEMP_DIR)
  const zip = path.join(TEMP_DIR, `ffmpeg-${Date.now()}.zip`)
  const staging = ensureDir(path.join(TEMP_DIR, `ffmpeg-unpack-${Date.now()}`))
  try {
    await download(ZIP_URL, zip, (percent, done, total) => {
      ctx.progress(percent, { stage: 'Downloading FFmpeg' })
      ctx.log(
        total
          ? `Downloaded ${(done / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(0)} MB`
          : `Downloaded ${(done / 1024 / 1024).toFixed(1)} MB`,
      )
    })

    ctx.stage('Unpacking')
    // Windows 10 and later ship bsdtar, which reads zip archives.
    const unpack = spawnSync('tar', ['-xf', zip, '-C', staging], { windowsHide: true, encoding: 'utf8' })
    if (unpack.status !== 0) {
      throw new Error(`Could not unpack the download: ${(unpack.stderr || '').trim() || unpack.status}`)
    }

    const files = walk(staging)
    const pick = (name) => files.find((file) => path.basename(file).toLowerCase() === name)
    const ffmpeg = pick(`ffmpeg${process.platform === 'win32' ? '.exe' : ''}`)
    const ffprobe = pick(`ffprobe${process.platform === 'win32' ? '.exe' : ''}`)
    if (!ffmpeg || !ffprobe) throw new Error('The download did not contain ffmpeg and ffprobe')

    ensureDir(TARGET_DIR)
    // Replace only once both binaries are copied, so a failed update cannot
    // leave the app pointing at half a pair.
    const staged = [ffmpeg, ffprobe].map((file) => {
      const target = path.join(TARGET_DIR, path.basename(file))
      fs.copyFileSync(file, `${target}.new`)
      return { target, fresh: `${target}.new` }
    })
    for (const entry of staged) fs.renameSync(entry.fresh, entry.target)

    for (const extra of ['LICENSE.txt', 'NOTICE.txt']) {
      const source = pick(extra)
      if (source) fs.copyFileSync(source, path.join(TARGET_DIR, extra))
    }
    writeJson(path.join(TARGET_DIR, 'version.json'), { version: latest, updatedAt: Date.now(), url: ZIP_URL })

    const status = detectTools({ force: true })
    if (!status.ok) throw new Error('The new FFmpeg did not start')
    ctx.log(`Now using FFmpeg ${status.version} from ${TARGET_DIR}`)
    ctx.progress(100, {})
    return { outputs: [], result: { updated: true, version: status.version } }
  } finally {
    for (const target of [zip, staging]) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
