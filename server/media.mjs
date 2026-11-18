import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CACHE_DIR, TEMP_DIR } from './config.mjs'
import { tools } from './bin.mjs'
import { probe } from './probe.mjs'

const WAVE_DIR = path.join(CACHE_DIR, 'waveforms')
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs')
const AUDIO_DIR = path.join(CACHE_DIR, 'audiotracks')
const SAMPLE_RATE = 4000

/** Longest stretch of audio decoded in one go for the timeline. */
export const MAX_WINDOW_SECONDS = 1800

function signature(file, extra = '') {
  const stat = fs.statSync(file)
  return crypto
    .createHash('sha1')
    .update(`${path.resolve(file)}|${stat.size}|${stat.mtimeMs}|${extra}`)
    .digest('hex')
}

const tasks = new Map()

function publicState(task) {
  return {
    state: task.state,
    progress: task.progress,
    peaks: task.peaks ?? null,
    path: task.path ?? null,
    error: task.error ?? '',
    start: task.start ?? 0,
    end: task.end ?? 0,
  }
}

function resample(peaks, buckets) {
  if (peaks.length === buckets) return peaks
  if (peaks.length === 0) return []
  const out = new Array(buckets).fill(0)
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor((i * peaks.length) / buckets)
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / buckets))
    let peak = 0
    for (let j = from; j < to && j < peaks.length; j += 1) if (peaks[j] > peak) peak = peaks[j]
    out[i] = peak
  }
  return out
}

/**
 * Decode only the requested slice of audio and reduce it to per-bucket peaks.
 * Nothing else is touched, which keeps zoomed-in editing instant on huge files.
 */
function decodePeaks({ file, start, span, buckets, track = 0, onProgress, onPartial }) {
  return new Promise((resolve, reject) => {
    const expected = Math.max(1, Math.floor(span * SAMPLE_RATE))
    const blockSize = Math.max(1, Math.floor(expected / buckets))
    const peaks = []
    let blockPeak = 0
    let blockCount = 0
    let total = 0
    let leftover = Buffer.alloc(0)

    const args = [
      '-v', 'error', '-nostdin',
      '-ss', Math.max(0, start).toFixed(3),
      '-i', file,
      '-t', span.toFixed(3),
      '-map', `0:a:${Math.max(0, Math.floor(track))}`,
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-',
    ]

    const child = spawn(tools().ffmpeg, args, { windowsHide: true })

    child.stdout.on('data', (chunk) => {
      const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      const usable = buffer.length - (buffer.length % 2)
      for (let i = 0; i < usable; i += 2) {
        const sample = Math.abs(buffer.readInt16LE(i)) / 32768
        if (sample > blockPeak) blockPeak = sample
        blockCount += 1
        total += 1
        if (blockCount >= blockSize) {
          peaks.push(blockPeak)
          blockPeak = 0
          blockCount = 0
          // Hand over what is decoded so far, so the timeline draws while FFmpeg reads.
          if (onPartial && peaks.length % 32 === 0) onPartial(peaks)
        }
      }
      leftover = buffer.subarray(usable)
      if (onProgress) onProgress(Math.min(99, (total / expected) * 100))
    })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      if (blockCount > 0) peaks.push(blockPeak)
      if (!peaks.length && code !== 0) {
        reject(new Error('FFmpeg could not decode audio from this file'))
        return
      }
      resolve(resample(peaks, buckets))
    })
  })
}

/** Peaks for one visible window. Cached per window so panning back is instant. */
export async function waveformWindow(file, start, end, buckets, trackIndex = 0) {
  const span = Math.max(0.2, end - start)
  if (span > MAX_WINDOW_SECONDS) {
    return { state: 'coarse', progress: 100, peaks: null, error: '', start, end }
  }

  const key = signature(file, `w|${start.toFixed(1)}|${(start + span).toFixed(1)}|${buckets}|a${trackIndex}`)
  const running = tasks.get(key)
  if (running) return publicState(running)

  const disk = path.join(WAVE_DIR, `${key}.json`)
  try {
    const stored = JSON.parse(fs.readFileSync(disk, 'utf8'))
    if (Array.isArray(stored.peaks)) {
      const ready = { state: 'ready', progress: 100, peaks: stored.peaks, start, end: start + span }
      tasks.set(key, ready)
      return publicState(ready)
    }
  } catch {
    /* regenerate */
  }

  let info
  try {
    info = await probe(file)
  } catch (err) {
    return { state: 'error', progress: 0, peaks: null, error: err.message, start, end }
  }
  if (!info.audio) return { state: 'empty', progress: 100, peaks: [], error: '', start, end }

  // AudioTrack.index is the stream index; FFmpeg wants the ordinal among the
  // audio streams, which is where the probe's list puts it.
  const position = Math.max(0, info.audioTracks.findIndex((entry) => entry.index === trackIndex))
  const task = { state: 'running', progress: 0, peaks: [], error: '', start, end: start + span }
  tasks.set(key, task)

  decodePeaks({
    file,
    start,
    span,
    buckets,
    track: position,
    onProgress: (pct) => {
      task.progress = pct
    },
    // Peaks arrive as they are decoded; the client pads the rest flat, so the
    // waveform fills in instead of appearing in one jump.
    onPartial: (partial) => {
      task.peaks = partial.slice(0, buckets)
    },
  })
    .then((peaks) => {
      task.peaks = peaks
      task.progress = 100
      task.state = 'ready'
      try {
        fs.writeFileSync(disk, JSON.stringify({ file, start, end: start + span, buckets, peaks }))
      } catch {
        /* cache is best effort */
      }
    })
    .catch((err) => {
      task.state = 'error'
      task.error = err.message
    })

  return publicState(task)
}

/** The optional full-file waveform, only built when the user asks for it. */
export async function overviewState(file, buckets = 4000, trackIndex = 0) {
  const key = signature(file, `overview|${buckets}|a${trackIndex}`)
  const disk = path.join(WAVE_DIR, `${key}.json`)
  try {
    const stored = JSON.parse(fs.readFileSync(disk, 'utf8'))
    if (Array.isArray(stored.peaks)) {
      return { state: 'ready', progress: 100, peaks: stored.peaks, error: '', start: 0, end: stored.duration ?? 0 }
    }
  } catch {
    /* not built yet */
  }
  const running = tasks.get(key)
  if (running) return publicState(running)
  return { state: 'missing', progress: 0, peaks: null, error: '', start: 0, end: 0 }
}

export async function buildOverview(file, buckets, onProgress, trackIndex = 0) {
  const info = await probe(file)
  if (!info.audio) throw new Error('This clip has no audio to draw')
  const key = signature(file, `overview|${buckets}|a${trackIndex}`)
  const disk = path.join(WAVE_DIR, `${key}.json`)
  const task = { state: 'running', progress: 0, peaks: null, error: '', start: 0, end: info.duration }
  tasks.set(key, task)
  try {
    const peaks = await decodePeaks({
      file,
      start: 0,
      span: info.duration,
      buckets,
      track: Math.max(0, info.audioTracks.findIndex((entry) => entry.index === trackIndex)),
      onProgress: (pct) => {
        task.progress = pct
        onProgress?.(pct)
      },
    })
    task.peaks = peaks
    task.progress = 100
    task.state = 'ready'
    try {
      fs.writeFileSync(disk, JSON.stringify({ file, duration: info.duration, buckets, peaks }))
    } catch {
      /* ignore */
    }
    return peaks
  } catch (err) {
    task.state = 'error'
    task.error = err.message
    tasks.delete(key)
    throw err
  }
}

export async function thumbnail(file, time, width = 160) {
  const key = signature(file, `${Math.round(time * 2)}|${width}`)
  const target = path.join(THUMB_DIR, `${key}.jpg`)
  if (fs.existsSync(target)) return target

  await new Promise((resolve) => {
    const args = [
      '-v', 'error', '-nostdin',
      '-ss', Math.max(0, time).toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${Math.max(16, width)}:-2:flags=bilinear`,
      '-q:v', '5',
      '-y', target,
    ]
    const child = spawn(tools().ffmpeg, args, { windowsHide: true })
    child.on('error', resolve)
    child.on('close', resolve)
  })

  return fs.existsSync(target) ? target : null
}

export async function filmstrip(file, start, end, count, width = 150) {
  const span = Math.max(0.1, end - start)
  const frames = []
  const safeCount = Math.min(24, Math.max(1, count))
  for (let i = 0; i < safeCount; i += 1) {
    const time = start + (span * (i + 0.5)) / safeCount
    try {
      const thumb = await thumbnail(file, time, width)
      if (thumb) frames.push({ time, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(thumb).toString('base64')}` })
    } catch {
      /* skip frame */
    }
  }
  return frames
}

function pruneDir(dir, maxFiles) {
  try {
    const files = fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    if (files.length <= maxFiles) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const entry of files.slice(0, files.length - maxFiles)) {
      try {
        fs.unlinkSync(entry.file)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function pruneCaches() {
  pruneDir(THUMB_DIR, 6000)
  pruneDir(WAVE_DIR, 4000)
  // Pulled-out preview tracks: a handful of windows is plenty of history.
  pruneDir(AUDIO_DIR, 40)
}

/** Newest modification time in a folder, so a folder being written right now is spared. */
function newestMtime(target) {
  let newest = 0
  const visit = (entry) => {
    let stat
    try {
      stat = fs.statSync(entry)
    } catch {
      return
    }
    if (!stat.isDirectory()) {
      newest = Math.max(newest, stat.mtimeMs)
      return
    }
    let names = []
    try {
      names = fs.readdirSync(entry)
    } catch {
      return
    }
    for (const name of names) visit(path.join(entry, name))
  }
  visit(target)
  return newest
}

/**
 * Transition exports leave their span files behind when an export is cancelled
 * or the app is closed mid-job. They can add up to the size of an export, so any
 * folder left untouched for a few hours is cleared on startup.
 */
export function sweepTemp(maxAgeMs = 3 * 60 * 60 * 1000) {
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(TEMP_DIR)
  } catch {
    return { removed }
  }
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    const entry = path.join(TEMP_DIR, name)
    let stat
    try {
      stat = fs.statSync(entry)
    } catch {
      continue
    }
    const newest = stat.isDirectory() ? newestMtime(entry) : stat.mtimeMs
    // A folder still being written keeps moving its newest file, so only idle
    // leftovers are old enough to qualify.
    if (newest > cutoff) continue
    try {
      if (stat.isDirectory()) fs.rmSync(entry, { recursive: true, force: true })
      else fs.unlinkSync(entry)
      removed += 1
    } catch {
      /* ignore */
    }
  }
  return { removed }
}

/**
 * Browsers always play the first audio track of a file and cannot switch to
 * another one, so a stretch of the chosen track is written out as its own AAC
 * file and played alongside the muted picture. Only the window around the
 * playhead is written, which takes seconds even on a six hour recording, and the
 * file only appears once FFmpeg has finished, so an interrupted run can never
 * leave a truncated track that plays nothing.
 */
export const AUDIO_WINDOW_SECONDS = 600

export async function audioTrackState(file, trackIndex = 0, start = 0, length = AUDIO_WINDOW_SECONDS) {
  const from = Math.max(0, Number(start) || 0)
  const span = Math.max(0, Math.min(3600, Number(length) || AUDIO_WINDOW_SECONDS))
  const key = signature(file, `a|${trackIndex}|${Math.round(from)}|${Math.round(span)}`)
  const target = path.join(AUDIO_DIR, `${key}.m4a`)
  if (fs.existsSync(target) && fs.statSync(target).size > 512) {
    return { state: 'ready', progress: 100, path: target, peaks: null, error: '', start: from, end: from + span }
  }
  const running = tasks.get(key)
  if (running) return publicState(running)

  let info
  try {
    info = await probe(file)
  } catch (err) {
    return { state: 'error', progress: 0, path: null, peaks: null, error: err.message, start: from, end: from + span }
  }
  const position = Array.isArray(info.audioTracks) ? info.audioTracks.findIndex((entry) => entry.index === trackIndex) : -1
  if (position < 0) {
    return { state: 'empty', progress: 100, path: null, peaks: null, error: '', start: from, end: from + span }
  }

  const task = { state: 'running', progress: 0, path: null, peaks: null, error: '', start: from, end: from + span }
  tasks.set(key, task)
  const expected = Math.max(1, Math.min(span || info.duration, Math.max(0.001, info.duration - from)))
  const part = `${target}.part`

  // An AAC track is copied out, so even an hour of it is quick. Anything else is
  // converted once to AAC so the browser can play it.
  const copy = info.audioTracks[position].codec === 'aac'
  const args = [
    '-v', 'error', '-nostdin',
    // Seeking before the input keeps FFmpeg from reading the file up to here.
    '-ss', from.toFixed(3),
    '-i', file,
    '-map', `0:a:${position}`,
    '-vn',
    ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
    ...(span ? ['-t', span.toFixed(3)] : []),
    '-movflags', '+faststart',
    // The temporary file has no extension to go by.
    '-f', 'ipod',
    '-progress', 'pipe:1',
    '-y', part,
  ]

  await new Promise((resolve, reject) => {
    const child = spawn(tools().ffmpeg, args, { windowsHide: true })
    let tail = ''
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim())
        if (match) task.progress = Math.min(99, (Number(match[1]) / 1e6 / expected) * 100)
      }
    })
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk.toString()).slice(-400)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      let size = 0
      try {
        size = fs.statSync(part).size
      } catch {
        size = 0
      }
      if (code !== 0 || size <= 512) {
        try {
          fs.unlinkSync(part)
        } catch {
          /* nothing to clean */
        }
        reject(new Error(tail.trim() || 'FFmpeg could not read this audio track'))
        return
      }
      // The finished window only takes its real name once it is whole.
      try {
        fs.rmSync(target, { force: true })
        fs.renameSync(part, target)
      } catch (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
    .then(() => {
      task.state = 'ready'
      task.progress = 100
      task.path = target
    })
    .catch((err) => {
      task.state = 'error'
      task.error = err.message
    })

  return publicState(task)
}