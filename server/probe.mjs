import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from './config.mjs'
import { tools } from './bin.mjs'
import { runCapture } from './proc.mjs'

const KEY_DIR = path.join(CACHE_DIR, 'keyframes')

function fraction(value) {
  if (!value || typeof value !== 'string') return 0
  const [num, den] = value.split('/').map(Number)
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den
  const plain = Number(value)
  return Number.isFinite(plain) ? plain : 0
}

function cacheKey(file) {
  const stat = fs.statSync(file)
  const signature = `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`
  return crypto.createHash('sha1').update(signature).digest('hex')
}

export async function probe(file) {
  const { ffprobe } = tools()
  const stat = fs.statSync(file)
  const { code, stdout, stderr } = await runCapture(
    ffprobe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      file,
    ],
    { timeoutMs: 120000 },
  )

  if (code !== 0) {
    throw new Error(`Could not read media: ${stderr.trim() || 'unknown ffprobe error'}`)
  }

  const raw = JSON.parse(stdout)
  const streams = raw.streams ?? []
  const videoRaw = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audioRaw = streams.find((s) => s.codec_type === 'audio')
  const allAudio = streams.filter((s) => s.codec_type === 'audio')
  const subtitleCount = streams.filter((s) => s.codec_type === 'subtitle').length

  const duration =
    Number(raw.format?.duration) ||
    Number(videoRaw?.duration) ||
    Number(audioRaw?.duration) ||
    0

  const video = videoRaw
    ? {
        index: videoRaw.index,
        codec: videoRaw.codec_name ?? '',
        codecLong: videoRaw.codec_long_name ?? '',
        profile: videoRaw.profile ?? '',
        width: videoRaw.width ?? 0,
        height: videoRaw.height ?? 0,
        pixFmt: videoRaw.pix_fmt ?? '',
        fps: fraction(videoRaw.avg_frame_rate) || fraction(videoRaw.r_frame_rate),
        rFps: fraction(videoRaw.r_frame_rate),
        bitrate: Number(videoRaw.bit_rate) || 0,
        frames: Number(videoRaw.nb_frames) || 0,
        colorSpace: videoRaw.color_space ?? '',
        colorTransfer: videoRaw.color_transfer ?? '',
        colorPrimaries: videoRaw.color_primaries ?? '',
        colorRange: videoRaw.color_range ?? '',
        fieldOrder: videoRaw.field_order ?? 'progressive',
        level: videoRaw.level ?? 0,
        timeBase: videoRaw.time_base ?? '',
        duration: Number(videoRaw.duration) || 0,
        rotation: Number(videoRaw.tags?.rotate ?? videoRaw.side_data_list?.[0]?.rotation ?? 0) || 0,
      }
    : null

  const audio = audioRaw
    ? {
        index: audioRaw.index,
        codec: audioRaw.codec_name ?? '',
        codecLong: audioRaw.codec_long_name ?? '',
        sampleRate: Number(audioRaw.sample_rate) || 0,
        channels: audioRaw.channels ?? 0,
        channelLayout: audioRaw.channel_layout ?? '',
        bitrate: Number(audioRaw.bit_rate) || 0,
        duration: Number(audioRaw.duration) || 0,
        language: audioRaw.tags?.language ?? '',
        streams: allAudio.length,
      }
    : null

  return {
    path: path.resolve(file),
    name: path.basename(file),
    dir: path.dirname(path.resolve(file)),
    size: stat.size,
    duration,
    startTime: Number(raw.format?.start_time) || 0,
    bitrate: Number(raw.format?.bit_rate) || 0,
    formatName: raw.format?.format_name ?? '',
    formatLong: raw.format?.format_long_name ?? '',
    video,
    audio,
    subtitleCount,
    chapters: (raw.chapters ?? []).map((c) => ({
      start: Number(c.start_time) || 0,
      end: Number(c.end_time) || 0,
      title: c.tags?.title ?? '',
    })),
    streamCount: streams.length,
    audioTracks: allAudio.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      language: a.tags?.language ?? '',
      title: a.tags?.title ?? '',
    })),
    isAudioOnly: !videoRaw && Boolean(audioRaw),
    isImage: Boolean(videoRaw && Number(videoRaw.nb_frames) === 1 && duration < 1),
  }
}

const keyframeCache = new Map()
const windowCache = new Map()

async function scanKeyframes(file, start, length) {
  const { ffprobe } = tools()
  const args = ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey']
  const windowed = Number.isFinite(start) && Number.isFinite(length) && length > 0
  // A window seeks instead of demuxing the file, so it costs milliseconds even
  // on a multi-hour recording.
  if (windowed) args.push('-read_intervals', `${Math.max(0, start).toFixed(3)}%+${length.toFixed(3)}`)
  args.push('-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file)

  const { code, stdout } = await runCapture(ffprobe, args, { timeoutMs: (windowed ? 2 : 20) * 60 * 1000 })
  if (code !== 0) return []
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line.split(',')[0]))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
}

/**
 * Keyframes for a slice of the file when `start`/`end` are given, otherwise for
 * the whole file. Whole-file scans are only for an explicit request: on a long
 * recording they take minutes, so nothing should do one implicitly.
 */
export async function keyframes(file, start, end) {
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const windowKey = `${cacheKey(file)}|${Number(start).toFixed(2)}|${Number(end).toFixed(2)}`
    if (windowCache.has(windowKey)) return windowCache.get(windowKey)
    const frames = await scanKeyframes(file, Number(start), Number(end) - Number(start))
    if (windowCache.size > 300) windowCache.clear()
    windowCache.set(windowKey, frames)
    return frames
  }

  const key = cacheKey(file)
  if (keyframeCache.has(key)) return keyframeCache.get(key)
  const disk = path.join(KEY_DIR, `${key}.json`)
  try {
    const stored = JSON.parse(fs.readFileSync(disk, 'utf8'))
    if (Array.isArray(stored.frames)) {
      keyframeCache.set(key, stored.frames)
      return stored.frames
    }
  } catch {
    /* regenerate */
  }

  const frames = await scanKeyframes(file)
  fs.writeFileSync(disk, JSON.stringify({ file: path.resolve(file), frames }))
  keyframeCache.set(key, frames)
  return frames
}

/** Keyframes close to a single instant — everything smart render needs. */
export async function keyframesNear(file, time, radius = 4) {
  const at = Number(time) || 0
  return keyframes(file, Math.max(0, at - radius), at + radius)
}

export function nearestKeyframe(frames, time, direction = 'before') {
  if (!frames.length) return time
  let lo = 0
  let hi = frames.length - 1
  if (time <= frames[0]) return frames[0]
  if (time >= frames[hi]) return frames[hi]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid] < time) lo = mid + 1
    else if (frames[mid] > time) hi = mid - 1
    else return frames[mid]
  }
  if (direction === 'after') return frames[lo]
  return frames[hi]
}

export function isOnKeyframe(frames, time, tolerance = 0.08) {
  if (!frames.length) return false
  return Math.abs(nearestKeyframe(frames, time) - time) <= tolerance
}

