import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildEncode, getPreset } from './presets.mjs'
import { buildOverview } from './media.mjs'
import { keyframes, keyframesNear, isOnKeyframe, probe } from './probe.mjs'
import { runCapture, runFfmpeg } from './proc.mjs'
import { tools } from './bin.mjs'
import { CACHE_DIR, TEMP_DIR, ensureDir, safeName, settings, uniquePath } from './config.mjs'
import { updateFfmpeg } from './ffmpeg-update.mjs'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function timecode(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s % 1) * 1000)
  return `${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(sec).padStart(2, '0')}-${String(ms).padStart(3, '0')}`
}

function escapeConcatPath(file) {
  return path.resolve(file).replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function writeConcatList(files, dir) {
  const listPath = path.join(dir, `concat-${crypto.randomUUID()}.txt`)
  fs.writeFileSync(listPath, files.map((file) => `file '${escapeConcatPath(file)}'`).join('\n') + '\n')
  return listPath
}

function failureMessage(tail = []) {
  const useful = tail
    .filter((line) => /error|invalid|failed|could not|cannot|no such|unsupported|not found/i.test(line))
    .slice(-6)
  if (useful.length) return useful.join('\n')
  return tail.slice(-6).join('\n') || 'ffmpeg exited with an error'
}

function fileHash(file) {
  try {
    const stat = fs.statSync(file)
    return crypto
      .createHash('sha1')
      .update(`${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`)
      .digest('hex')
  } catch {
    return crypto.createHash('sha1').update(String(file)).digest('hex')
  }
}

function applyTemplate(template, tokens) {
  const raw = String(template || '{name} - {label}')
  const filled = raw.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in tokens) return String(tokens[key])
    return match
  })
  return safeName(filled, tokens.name || 'clip')
}

function losslessExt(sourcePath) {
  const ext = path.extname(sourcePath).slice(1).toLowerCase()
  if (['mp4', 'm4v', 'mov'].includes(ext)) return 'mp4'
  if (['mkv', 'webm'].includes(ext)) return 'mkv'
  if (['ts', 'm2ts', 'mts'].includes(ext)) return 'ts'
  if (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'mka', 'wma'].includes(ext)) return ext
  return 'mkv'
}

/** Encode args that keep the original codec so copy segments can be joined. */
function sourceMatchedEncode(info) {
  const codec = info.video?.codec ?? ''
  const audioCodec = info.audio?.codec ?? ''
  const v = []
  if (codec === 'hevc') {
    v.push('-c:v', 'libx265', '-preset', 'veryfast', '-crf', '20')
  } else if (codec === 'av1') {
    v.push('-c:v', 'libsvtav1', '-preset', '10', '-crf', '28')
  } else if (codec === 'vp9') {
    v.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5')
  } else {
    v.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18')
  }
  v.push('-pix_fmt', info.video?.pixFmt?.includes('10') ? 'yuv420p10le' : 'yuv420p')
  const a = audioCodec
    ? ['-c:a', audioCodec === 'mp3' ? 'libmp3lame' : 'aac', '-b:a', '256k']
    : ['-an']
  return { v, a, container: [], videoFilter: [], ext: '', notes: ['source-matched re-encode'] }
}

async function runOne(ctx, args, totalSec, stage) {
  if (ctx.isCanceled()) throw new Error('Canceled')
  if (stage) ctx.stage(stage)
  const { done } = runFfmpeg({
    ffmpeg: tools().ffmpeg,
    args,
    totalSec,
    onProgress: (progress) => ctx.progress(progress.percent, progress),
    onLog: (line) => ctx.log(line),
    onChild: (child) => ctx.onChild(child),
  })
  const res = await done
  if (ctx.isCanceled()) throw new Error('Canceled')
  if (res.code !== 0) throw new Error(failureMessage(res.tail))
  return res
}

async function syncInfo(file) {
  try {
    const info = await probe(file)
    const videoDuration = info.video?.duration || (info.video ? info.duration : 0)
    const audioDuration = info.audio?.duration || 0
    const deltaMs = Number.isFinite(audioDuration) && audioDuration > 0 ? Math.round((videoDuration - audioDuration) * 1000) : 0
    return {
      duration: info.duration,
      videoDuration,
      audioDuration,
      deltaMs,
      ok: Math.abs(deltaMs) <= 150,
      size: info.size,
    }
  } catch {
    return { duration: 0, videoDuration: 0, audioDuration: 0, deltaMs: 0, ok: true, size: 0 }
  }
}

/** Re-probe an exported file and report whether its streams still line up. */
export async function verifyOutput(file) {
  if (!fs.existsSync(file)) throw new Error(`Output is missing: ${path.basename(file)}`)
  const stats = await syncInfo(file)
  return { path: file, ...stats }
}

/**
 * Decode a finished export end to end and report what the decoder trips over.
 *
 * A file can look right in a player while a span is joined with mismatched
 * parameter sets, or a cut lands on frames that are no longer there; either way
 * the decoder complains long before the viewer does. Reading every frame is the
 * only check that covers the whole file, so it runs as a queue job with
 * progress and can be canceled like any other job.
 */
export async function verifyOutputJob(ctx, params = {}) {
  const file = String(params.path || '')
  if (!file) throw new Error('No output to verify')
  if (!fs.existsSync(file)) throw new Error(`Output is missing: ${path.basename(file)}`)

  ctx.stage('Checking the file')
  const info = await probe(file)
  const stats = await syncInfo(file)
  const total = info.duration || stats.duration || 0
  const video = info.video ? `${info.video.codec} ${info.video.width}x${info.video.height}` : 'no video'
  const audio = info.audio ? `${info.audio.codec} ${info.audio.sampleRate} Hz` : 'no audio'
  ctx.log(`${path.basename(file)} · ${timecode(total)} · ${video} · ${audio}`)
  if (stats.audioDuration > 0) {
    const side = stats.deltaMs >= 0 ? 'shorter' : 'longer'
    ctx.log(`Audio is ${Math.abs(stats.deltaMs)} ms ${side} than the picture`)
  }

  const errors = []
  let at = 0
  ctx.stage('Decoding every frame')
  const { done } = runFfmpeg({
    ffmpeg: tools().ffmpeg,
    args: ['-v', 'error', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?', '-f', 'null', '-'],
    totalSec: total,
    onProgress: (progress) => {
      at = progress.seconds
      ctx.progress(total > 0 ? Math.min(99, progress.percent) : 0, progress)
    },
    onLog: (line) => {
      const text = line.trim()
      if (!text) return
      errors.push({ at, line: text.slice(0, 240) })
      if (errors.length <= 12) ctx.log(text)
    },
    onChild: (child) => ctx.onChild(child),
  })
  const res = await done
  if (ctx.isCanceled()) throw new Error('Canceled')
  if (res.code !== 0 && !errors.length) throw new Error(failureMessage(res.tail))

  if (errors.length) {
    const first = errors[0]
    ctx.log(`Decoded ${timecode(total)} · ${errors.length} decoder complaint${errors.length === 1 ? '' : 's'}`)
    throw new Error(
      `${errors.length} decode error${errors.length === 1 ? '' : 's'} · first at ${timecode(first.at)} · ${first.line}`,
    )
  }

  ctx.log(`Decoded ${timecode(total)} · every frame and sample decoded cleanly`)
  return { result: { decodeErrors: 0, duration: total, sync: stats } }
}

function resolveOutDir(requested, source) {
  const dir = requested?.trim() ? requested : settings.outDir || path.dirname(source)
  ensureDir(dir)
  return dir
}

// ---------------------------------------------------------------------------
// cut / transcode
// ---------------------------------------------------------------------------

/**
 * Which audio stream an output keeps: first by default, an explicit stream
 * index, or every track. Accepts both `2` and `track:2`.
 *
 * The chosen track is a probe stream index, which is turned into its position
 * among the audio streams so the map stays right when a file also carries
 * subtitles or cover art (stream 0:3 is not audio track 3).
 */
function audioMapFor(track, tracks = []) {
  if (track === 'all') return '0:a?'
  if (track === 'none') return null
  const raw = typeof track === 'string' && track.startsWith('track:') ? track.slice(6) : track
  const index = Number(raw)
  if (Number.isInteger(index) && index >= 0) {
    const position = Array.isArray(tracks) ? tracks.findIndex((entry) => entry.index === index) : -1
    return position >= 0 ? `0:a:${position}` : `0:${index}?`
  }
  return '0:a:0?'
}

/**
 * Colour tags carried over from the source.
 *
 * A re-encode that drops them is how HDR comes back as washed-out SDR: the
 * pixels are still HDR, but nothing in the file says what they mean.
 */
function colorArgs(info) {
  const video = info?.video
  if (!video) return []
  const args = []
  if (video.colorPrimaries) args.push('-color_primaries', video.colorPrimaries)
  if (video.colorTransfer) args.push('-color_trc', video.colorTransfer)
  if (video.colorSpace) args.push('-colorspace', video.colorSpace)
  if (video.colorRange) args.push('-color_range', video.colorRange)
  return args
}

function buildSegmentArgs({ source, start, end, copy, encode, outPath, format, audioMap = '0:a:0?', keepExtras = false, videoCodec = '', info = null }) {
  const duration = Math.max(0.001, end - start)
  const args = ['-ss', start.toFixed(3), '-i', source, '-t', duration.toFixed(3)]

  if (copy) {
    // Subtitles and chapters survive a copy into Matroska, and only there: MP4
    // would need the subtitle codec converted, which is no longer a copy.
    const extras = keepExtras && path.extname(outPath).slice(1).toLowerCase() === 'mkv'
    args.push('-map', '0:v:0?')
    if (audioMap) args.push('-map', audioMap)
    if (extras) args.push('-map', '0:s?')
    else args.push('-sn')
    args.push('-dn', '-map_chapters', extras ? '0' : '-1')
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
    if (extras) args.push('-c:s', 'copy')
  } else if (encode.family === 'gif') {
    const width = Math.max(120, Number(encode.gifWidth) || 480)
    const fps = Number(encode.gifFps) || 15
    args.push(
      '-filter_complex',
      `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[v]`,
      '-map',
      '[v]',
      '-loop',
      '0',
      '-an',
    )
  } else {
    args.push('-map', '0:v:0?')
    if (audioMap) args.push('-map', audioMap)
    else args.push('-an')
    args.push('-sn', '-dn', '-map_chapters', '-1')
    if (encode.videoFilter?.length) args.push('-vf', encode.videoFilter.join(','))
    args.push(...encode.v)
    // Still images and GIFs are SDR by construction, so they keep no tags.
    if (encode.family !== 'imageseq') args.push(...colorArgs(info))
    args.push(...encode.a)
    if (encode.audioFilter) args.push('-af', encode.audioFilter)
    args.push(...(encode.container ?? []))
  }

  // A copied HEVC into an MP4 gets the tag the recordings carry.
  if (copy && !format && String(videoCodec).toLowerCase() === 'hevc' && /\.(mp4|mov)$/i.test(outPath)) {
    args.push('-tag:v', 'hvc1')
  }
  if (format) args.push('-f', format)
  args.push(outPath)
  return args
}

const MP4_VIDEO_OK = new Set(['h264', 'hevc', 'av1', 'mpeg4'])
const MP4_AUDIO_OK = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac'])

/**
 * How an HEVC track is tagged in an MP4.
 *
 * A straight copy of one bitstream keeps the recordings' own hvc1: the sample
 * description holds that bitstream's parameter sets and nothing changes them
 * mid-track, so the tag is true.
 *
 * A track that mixes bitstream families must never say hvc1. Wipes and fades
 * re-encode the split second at a cut with libx265, whose VPS/SPS/PPS differ
 * from the recording's; an MP4 carries one family in the sample description and
 * the other in-band. hvc1 promises there are no in-band parameter sets, so a
 * decoder that honours the tag parses the copied frames with the encoder's
 * SPS/PPS and paints garbage from the first frame of the file onward. hev1 is
 * the tag that allows the switch, and it is what FFmpeg writes by default.
 */
function hevcTagArgs(info, ext, mixed = false) {
  if (!['mp4', 'mov'].includes(ext)) return []
  if (String(info?.video?.codec || '').toLowerCase() !== 'hevc') return []
  return ['-tag:v', mixed ? 'hev1' : 'hvc1']
}

/** Whether this recording's streams can be copied straight into an MP4. */
function mp4Copyable(info) {
  const video = info.video?.codec ?? ''
  const audio = info.audio?.codec ?? ''
  if (video && !MP4_VIDEO_OK.has(video)) return false
  if (audio && !MP4_AUDIO_OK.has(audio)) return false
  return true
}

/**
 * The container a copy join can land in. Several recordings only ever become
 * MKV when their codecs would not survive in an MP4.
 */
function copyContainerFor(infos) {
  if (!infos.length) return 'mkv'
  if (new Set(infos.map((info) => info.path)).size <= 1) return losslessExt(infos[0].path)
  return infos.every((info) => mp4Copyable(info)) ? 'mp4' : 'mkv'
}

/**
 * Cut and join in a single ffmpeg pass: the concat demuxer takes per-file
 * in/out points, so nothing is written to a temp folder and the whole export is
 * one stream copy, the way SolveigMM does it.
 */
/**
 * Chapter marks for a merged export: one per kept fragment, in output time,
 * named after the fragment. The concat demuxer does not carry the source's own
 * chapters, and even if it did their times would no longer line up after cuts.
 */
function writeChapterMeta(segments, dir) {
  if (!segments.length) return ''
  const lines = [';FFMETADATA1']
  let cursor = 0
  segments.forEach((segment, index) => {
    const length = Math.max(0.001, segment.end - segment.start)
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000')
    lines.push(`START=${Math.round(cursor * 1000)}`)
    lines.push(`END=${Math.round((cursor + length) * 1000)}`)
    lines.push(`title=${String(segment.label || `Part ${index + 1}`).replace(/[\r\n]/g, ' ')}`)
    cursor += length
  })
  const file = path.join(dir, 'chapters.txt')
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

async function cutAndJoinCopy(ctx, pieces, finalPath, ext, totalDuration, faststart = false, audioMap = '0:a:0?', keepExtras = false, chapterFile = '') {
  // A concat list with inpoint/outpoint cannot start a piece mid-GOP: the video
  // is read from the keyframe before the cut while the audio starts on the cut,
  // which leaves the seam drifted by up to a GOP. Cut each piece on its own with
  // -ss instead, so picture and sound begin on the same frame, then copy-join
  // the finished parts.
  const dir = ensureDir(path.join(TEMP_DIR, `concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  const parts = []
  let completed = 0
  try {
    for (const [index, piece] of pieces.entries()) {
      if (ctx.isCanceled()) throw new Error('Canceled')
      const part = path.join(dir, `part-${String(index).padStart(4, '0')}.mkv`)
      ctx.stage(`Cutting piece ${index + 1}/${pieces.length}`)
      const args = buildSegmentArgs({
        source: piece.source,
        start: piece.start,
        end: piece.end,
        copy: true,
        encode: null,
        outPath: part,
        format: 'matroska',
        audioMap,
        keepExtras: keepExtras && ext === 'mkv',
        info: piece.info,
      })
      const base = completed
      const { done } = runFfmpeg({
        ffmpeg: tools().ffmpeg,
        args,
        totalSec: piece.duration,
        onProgress: (progress) => {
          const sofar = base + Math.min(piece.duration, (progress.percent / 100) * piece.duration)
          ctx.progress(totalDuration > 0 ? Math.min(92, (sofar / totalDuration) * 92) : 0, {
            ...progress,
            piece: index + 1,
            pieces: pieces.length,
          })
        },
        onLog: (line) => ctx.log(line),
        onChild: (child) => ctx.onChild(child),
      })
      const res = await done
      if (ctx.isCanceled()) throw new Error('Canceled')
      if (res.code !== 0) throw new Error(failureMessage(res.tail))
      completed = base + piece.duration
      parts.push(part)
      ctx.log(
        `Piece ${index + 1}/${pieces.length} · ${path.basename(piece.source)} ${timecode(piece.start)} → ${timecode(piece.end)} · copy`,
      )
    }

    ctx.stage('Joining pieces (copy)')
    const listPath = writeConcatList(parts, dir)
    const extras = keepExtras && ext === 'mkv'
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath]
    if (extras && chapterFile) args.push('-i', chapterFile)
    args.push('-map', '0:v:0?')
    // Each part already carries just the chosen track, so the join maps the
    // first audio stream it finds (or every one, when every track was asked).
    if (audioMap) args.push('-map', audioMap === '0:a?' ? '0:a?' : '0:a:0?')
    else args.push('-an')
    if (extras) args.push('-map', '0:s?')
    else args.push('-sn')
    args.push('-dn', '-c', 'copy')
    if (extras) {
      args.push('-c:s', 'copy')
      args.push('-map_chapters', chapterFile ? '1' : '-1')
      if (chapterFile) args.push('-map_metadata', '1')
    } else {
      args.push('-map_chapters', '-1')
    }
    if (['mp4', 'mov'].includes(ext)) {
      // Two recordings can describe their parameter sets differently; only a
      // single bitstream can honestly be tagged hvc1.
      const sources = new Set(pieces.map((piece) => piece.source))
      args.push(...hevcTagArgs(pieces[0]?.info, ext, sources.size > 1))
      args.push('-video_track_timescale', '90000')
      if (faststart) args.push('-movflags', '+faststart')
    }
    if (ext === 'mkv') args.push('-f', 'matroska')
    args.push(finalPath)

    await runOne(ctx, args, totalDuration, 'Joining pieces (copy)')
    ctx.log(`Cut ${parts.length} pieces and joined them with stream copy`)
    return true
  } catch (err) {
    if (ctx.isCanceled()) throw err
    ctx.log(`Copying the pieces first failed (${err.message}). Cutting them another way instead.`)
    try {
      fs.unlinkSync(finalPath)
    } catch {
      /* a partial file must not be left behind */
    }
    return false
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Encoder args that reproduce the export's own audio stream, so a re-encoded
 * fragment still joins the copied spans. Null when the codec cannot be encoded
 * here, which sends the export down the slower path instead.
 */
function exportAudioEncoder(info, audioMap) {
  if (!audioMap || !info?.audio) return null
  const position = /^0:a:(\d+)$/.exec(audioMap)
  const track = position && Array.isArray(info.audioTracks) ? info.audioTracks[Number(position[1])] : null
  const codec = String(track?.codec || info.audio.codec || '').toLowerCase()
  const encoder =
    codec === 'aac'
      ? ['-c:a', 'aac', '-b:a', '256k']
      : codec === 'mp3'
        ? ['-c:a', 'libmp3lame', '-b:a', '256k']
        : codec === 'ac3'
          ? ['-c:a', 'ac3', '-b:a', '384k']
          : codec === 'eac3'
            ? ['-c:a', 'eac3', '-b:a', '384k']
            : codec === 'flac'
              ? ['-c:a', 'flac']
              : codec === 'opus'
                ? ['-c:a', 'libopus', '-b:a', '192k']
                : null
  if (!encoder) return null
  const out = [...encoder]
  if (info.audio.sampleRate) out.push('-ar', String(info.audio.sampleRate))
  const channels = Number(track?.channels || info.audio.channels) || 0
  if (channels) out.push('-ac', String(channels))
  return out
}

/**
 * Lossless join where a fragment switches audio track. Only the switched
 * fragments are encoded; every other span is still a straight copy. Each span is
 * written as MPEG-TS because that carries its own parameter sets: joining a
 * re-encoded span with copied MP4 footage makes the decoder apply the new set to
 * the copied spans after it, which corrupts them. The spans are then joined with
 * one stream copy.
 */
async function cutAndJoinSwitchedAudio(ctx, {
  pieces,
  finalPath,
  ext,
  audioMap,
  audioEncoder,
  audioMapForPiece,
  switchesAudio,
  fps,
  faststart = false,
}) {
  const dir = ensureDir(path.join(TEMP_DIR, `switch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  const total = pieces.reduce((sum, piece) => sum + Math.max(0.001, piece.end - piece.start), 0)
  const switched = pieces.filter((piece) => switchesAudio(piece)).length
  const spans = []
  let done = 0
  try {
    for (const [index, piece] of pieces.entries()) {
      if (ctx.isCanceled()) throw new Error('Canceled')
      const duration = Math.max(0.001, piece.end - piece.start)
      const out = path.join(dir, `span-${String(index).padStart(4, '0')}.ts`)
      const switching = switchesAudio(piece)
      ctx.stage(
        switching
          ? `Re-encoding fragment ${index + 1}/${pieces.length} to switch audio`
          : `Copying fragment ${index + 1}/${pieces.length}`,
      )
      let args
      if (!switching) {
        // Cut the span with -ss so its picture and sound both start on the same
        // frame: a concat inpoint starts video on the preceding keyframe while
        // audio starts on the cut, which drifts the seam by up to a GOP.
        args = ['-ss', piece.start.toFixed(3), '-i', piece.source, '-t', duration.toFixed(3), '-map', '0:v:0?']
        if (audioMap) args.push('-map', audioMapForPiece(piece))
        else args.push('-an')
        // No frame cap: with B-frames the last few frames of the span are needed
        // to decode the ones just before the outpoint, and the join trims the
        // declared duration anyway.
        args.push('-sn', '-dn', '-c', 'copy')
      } else {
        // Seeking straight to the cut lands inside a GOP, where the opening
        // frames reference pictures the decoder no longer has and get dropped,
        // which loses the first frames of the fragment. Read from a little
        // earlier and trim on decoded frames instead, so the span starts exactly
        // on the cut.
        const backoff = Math.min(2, piece.start)
        args = [
          '-ss', (piece.start - backoff).toFixed(3), '-i', piece.source,
          '-t', (duration + backoff + 0.5).toFixed(3),
          '-map', '0:v:0?',
        ]
        if (audioMap) args.push('-map', audioMapForPiece(piece))
        else args.push('-an')
        args.push(...sourceMatchedEncode(piece.info).v)
        if (backoff > 0) args.push('-vf', `trim=start=${backoff.toFixed(3)},setpts=PTS-STARTPTS`)
        if (fps > 0) args.push('-r', String(Math.max(1, Math.round(fps))), '-fps_mode', 'cfr')
        args.push('-t', duration.toFixed(3))
        if (audioMap) {
          args.push(...audioEncoder)
          // apad + atrim keeps this span exactly as long as its video, so the
          // small AAC frame padding cannot add up across a long export.
          args.push(
            '-af',
            backoff > 0
              ? `atrim=start=${backoff.toFixed(3)},asetpts=PTS-STARTPTS,apad,atrim=0:${duration.toFixed(3)}`
              : `apad,atrim=0:${duration.toFixed(3)}`,
          )
        }
        args.push('-sn', '-dn')
      }
      args.push(...SPAN_TS_OPTS, out)

      const base = done
      const { done: finished } = runFfmpeg({
        ffmpeg: tools().ffmpeg,
        args,
        totalSec: duration,
        onProgress: (progress) => {
          const sofar = base + Math.min(duration, (progress.percent / 100) * duration)
          ctx.progress(total > 0 ? Math.min(92, (sofar / total) * 92) : 0, {
            ...progress,
            piece: index + 1,
            pieces: pieces.length,
          })
        },
        onLog: (line) => ctx.log(line),
        onChild: (child) => ctx.onChild(child),
      })
      const res = await finished
      if (ctx.isCanceled()) throw new Error('Canceled')
      if (res.code !== 0) throw new Error(failureMessage(res.tail))
      done = base + duration
      spans.push({ file: out, duration })
      ctx.log(
        `Piece ${index + 1}/${pieces.length} · ${path.basename(piece.source)} ${timecode(piece.start)} → ${timecode(piece.end)} · ${switching ? 're-encode (audio switch)' : 'copy'}`,
      )
    }

    // Each entry's planned length is declared, otherwise the demuxer offsets the
    // next span by whatever the previous file really measured. The inpoint reads
    // each span from its own start so a span whose muxer shifted its timestamps
    // (B-frames delay the first PTS) still lands on the declared boundary.
    const lines = []
    for (const span of spans) {
      lines.push(`file '${escapeConcatPath(span.file)}'`)
      lines.push('inpoint 0.000000')
      lines.push(`duration ${span.duration.toFixed(6)}`)
    }
    const listPath = path.join(dir, 'list.txt')
    fs.writeFileSync(listPath, `${lines.join('\n')}\n`)

    ctx.stage('Joining the copied and switched fragments')
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v:0?']
    if (audioMap) args.push('-map', '0:a:0?')
    else args.push('-an')
    args.push('-sn', '-dn', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-map_chapters', '-1')
    if (['mp4', 'mov'].includes(ext)) {
      // Re-encoded fragments mixed with copied ones: hev1, so the in-band
      // parameter sets that come with each span are honoured.
      args.push(...hevcTagArgs(pieces[0]?.info, ext, true))
      args.push('-video_track_timescale', '90000')
      if (faststart) args.push('-movflags', '+faststart')
    }
    if (ext === 'mkv') args.push('-f', 'matroska')
    args.push(finalPath)
    await runOne(ctx, args, total, null)
    ctx.log(
      `Copied ${spans.length - switched} of ${spans.length} spans · re-encoded ${switched} fragment${switched === 1 ? '' : 's'} to switch audio track`,
    )
    return true
  } catch (err) {
    if (ctx.isCanceled()) throw err
    ctx.log(`Switched-audio join failed (${err.message}). Encoding the pieces instead.`)
    try {
      fs.unlinkSync(finalPath)
    } catch {
      /* a partial file must not be left behind */
    }
    return false
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// cut transitions
// ---------------------------------------------------------------------------

/**
 * Cut transitions only touch the split second either side of a cut; the rest of
 * the timeline stays a stream copy, so a 25 hour export keeps its speed.
 */

/**
 * Every span is muxed from zero on the same clock. Left at the muxer's default
 * 1.4 s preload the offsets between spans disagree by a few frames, which makes
 * the decoder see pictures out of order at the seams.
 */
const SPAN_TS_OPTS = ['-muxdelay', '0', '-muxpreload', '0', '-avoid_negative_ts', 'make_zero', '-f', 'mpegts']

/**
 * Plan the transition chunks. `scope` decides where they land: 'joins' fades
 * every cut, 'ends' only the opening and closing frames, 'both' does the lot.
 * Only the split second at each of those points is re-encoded.
 */
function transitionPlan(groups, seconds, kind, scope) {
  const D = Math.max(0.1, seconds)
  const fadeStart = scope === 'ends' || scope === 'both'
  const fadeEnd = fadeStart
  const fadeJoins = scope === 'joins' || scope === 'both'
  const lastIndex = groups.length - 1
  const groupLength = (group) => Math.max(0, group.segment.end - group.segment.start)
  const lastPieceOf = (group) => group.pieces[group.pieces.length - 1]
  // A blur or a wipe mixes the two sides across the join, so it eats into both.
  const overlapping = OVERLAP_KINDS.has(kind)

  // Both sides of one join get the same length, so a blur can dissolve evenly.
  const joinLength = []
  for (let index = 1; index <= lastIndex; index += 1) {
    const prev = groups[index - 1]
    const next = groups[index]
    const prevTail = lastPieceOf(prev)
    const nextHead = next.pieces[0]
    joinLength[index] = fadeJoins
      ? Math.min(
          D,
          groupLength(prev) / 2,
          groupLength(next) / 2,
          prevTail.end - prevTail.start,
          nextHead.end - nextHead.start,
        )
      : 0
  }

  const chunks = []
  groups.forEach((group, index) => {
    const isFirst = index === 0
    const isLast = index === lastIndex
    const headPiece = group.pieces[0]
    const tailPiece = lastPieceOf(group)
    const head = isFirst
      ? fadeStart
        ? Math.min(D, groupLength(group) / 2, headPiece.end - headPiece.start)
        : 0
      : joinLength[index]
    const tail = isLast
      ? fadeEnd
        ? Math.min(D, groupLength(group) / 2, tailPiece.end - tailPiece.start)
        : 0
      : joinLength[index + 1]

    // The head of a join dissolves from the previous recording's tail; an end has
    // nothing to dissolve with, so it always dips from black.
    if (head > 0.02) {
      if (!isFirst && overlapping) {
        const prevTail = lastPieceOf(groups[index - 1])
        chunks.push({
          type: kind,
          duration: head,
          from: { source: prevTail.source, start: prevTail.end - head, end: prevTail.end, info: prevTail.info },
          to: { source: headPiece.source, start: headPiece.start, end: headPiece.start + head, info: headPiece.info },
          info: headPiece.info,
        })
      } else {
        chunks.push({
          type: 'dip',
          mode: 'in',
          source: headPiece.source,
          start: headPiece.start,
          end: headPiece.start + head,
          info: headPiece.info,
        })
      }
    }

    // The copies give up exactly the spans the transition chunks cover.
    group.pieces.forEach((piece, pieceIndex) => {
      const start = piece.start + (pieceIndex === 0 ? head : 0)
      const end = piece.end - (pieceIndex === group.pieces.length - 1 ? tail : 0)
      if (end - start > 0.02) chunks.push({ type: 'copy', source: piece.source, start, end, info: piece.info })
    })

    // A dip fades out here; a blur or wipe join fades out as the next group's mix.
    if (tail > 0.02 && (!overlapping || isLast)) {
      chunks.push({
        type: 'dip',
        mode: 'out',
        source: tailPiece.source,
        start: tailPiece.end - tail,
        end: tailPiece.end,
        info: tailPiece.info,
      })
    }
  })
  return chunks
}

/** Blur and wipe both mix the two sides of a join, so they share every code path. */
const OVERLAP_KINDS = new Set(['blur', 'wipe'])

/** Encoder args that keep a re-encoded chunk interchangeable with the source. */
function chunkEncoder(info, fps) {
  const matched = sourceMatchedEncode(info)
  const args = [...matched.v]
  args.push(...colorArgs(info))
  if (fps > 0) args.push('-r', String(Math.max(1, Math.round(fps))))
  args.push('-fps_mode', 'cfr')
  if (matched.a.length) {
    args.push(...matched.a)
    if (info.audio?.sampleRate) args.push('-ar', String(info.audio.sampleRate))
    if (info.audio?.channels) args.push('-ac', String(info.audio.channels))
  }
  return args
}

function dipChunkArgs(chunk, audioMap, fps) {
  const duration = Math.max(0.02, chunk.end - chunk.start)
  const args = ['-ss', chunk.start.toFixed(3), '-t', duration.toFixed(3), '-i', chunk.source, '-map', '0:v:0']
  if (audioMap) args.push('-map', audioMap)
  else args.push('-an')
  args.push('-vf', `fade=t=${chunk.mode}:st=0:d=${duration.toFixed(3)}`)
  // apad + atrim keeps the audio exactly as long as the video, so the small AAC
  // frame padding cannot add up across a long export.
  if (audioMap)
    args.push('-af', `afade=t=${chunk.mode}:st=0:d=${duration.toFixed(3)},apad,atrim=0:${duration.toFixed(3)}`)
  args.push(...chunkEncoder(chunk.info, fps), '-sn', '-dn')
  return args
}

/** A straight re-encode: no fade, used for the frames before the next keyframe. */
function fillChunkArgs(chunk, audioMap, fps) {
  const duration = Math.max(0.02, chunk.end - chunk.start)
  const args = ['-ss', chunk.start.toFixed(3), '-t', duration.toFixed(3), '-i', chunk.source, '-map', '0:v:0']
  if (audioMap) args.push('-map', audioMap, '-af', `apad,atrim=0:${duration.toFixed(3)}`)
  else args.push('-an')
  args.push(...chunkEncoder(chunk.info, fps), '-sn', '-dn')
  return args
}

/**
 * A copied span has to begin on a keyframe, or its first frames reference
 * pictures that are not in the file. Anything before that keyframe is re-encoded
 * instead, so the cut keeps its exact length.
 */
async function alignCopyChunks(chunks) {
  const out = []
  for (const chunk of chunks) {
    if (chunk.type !== 'copy') {
      out.push(chunk)
      continue
    }
    const start = chunk.start
    if (start <= 0.001 || !chunk.info) {
      out.push(chunk)
      continue
    }
    let frames = []
    try {
      frames = await keyframesNear(chunk.source, start)
    } catch {
      frames = []
    }
    const next = frames.find((time) => time >= start - 0.002)
    if (next === undefined) {
      out.push(chunk)
    } else if (next <= start + 0.02) {
      out.push({ ...chunk, start: next })
    } else if (next < chunk.end - 0.05) {
      out.push({ type: 'fill', source: chunk.source, start, end: next, info: chunk.info })
      out.push({ ...chunk, start: next })
    } else {
      out.push({ type: 'fill', source: chunk.source, start, end: chunk.end, info: chunk.info })
    }
  }
  return out
}

/**
 * Blend the two sides of a join: a blur dissolve, or a soft wipe that travels
 * across the frame with a feathered edge (PowerDirector's "wipe soft").
 */
function overlapChunkArgs(kind, chunk, audioMap, fps, pcm = false) {
  const d = Math.max(0.02, chunk.duration)
  const rate = Math.max(1, Math.round(fps || 30))
  const sigma = Math.max(6, Math.round((chunk.info?.video?.width || 1280) / 90))
  const args = [
    '-ss', chunk.from.start.toFixed(3), '-t', d.toFixed(3), '-i', chunk.from.source,
    '-ss', chunk.to.start.toFixed(3), '-t', d.toFixed(3), '-i', chunk.to.source,
  ]
  const blur = kind === 'blur' ? `,gblur=sigma=${sigma}` : ''
  const mix = kind === 'wipe' ? 'smoothleft' : 'fade'
  const stage = (tag) => `fps=${rate},setsar=1,format=yuv420p${blur},setpts=PTS-STARTPTS[${tag}]`
  const graph = [`[0:v]${stage('a')}`, `[1:v]${stage('b')}`, `[a][b]xfade=transition=${mix}:duration=${d.toFixed(3)}:offset=0[v]`]
  if (audioMap) {
    const spec = audioStreamSpec(audioMap)
    graph.push(`[0:${spec}][1:${spec}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri,apad,atrim=0:${d.toFixed(3)}[aud]`)
  }
  args.push('-filter_complex', graph.join(';'), '-map', '[v]')
  if (audioMap && !pcm) args.push('-map', '[aud]')
  else args.push('-an')
  args.push(...chunkEncoder(chunk.info, fps), '-sn', '-dn')
  return args
}

/** The audio stream a map such as `0:a:1` or `0:3?` selects, as `a:1` or `3`. */
function audioStreamSpec(audioMap) {
  const position = /^0:a:(\d+)/.exec(String(audioMap || ''))
  if (position) return `a:${position[1]}`
  const absolute = /^0:(\d+)/.exec(String(audioMap || ''))
  return absolute ? String(absolute[1]) : 'a:0'
}

/**
 * The audio half of a span pass, written as PCM beside its video piece.
 *
 * Decoding the source again in the join pass read a six hour recording twice and
 * cost about a third of the export's speed. Taking the audio here adds nothing:
 * the input is already being read for the video. PCM carries no encoder priming
 * delay, so the join can splice the spans sample to sample and encode AAC once,
 * which is what keeps the seams free of the old click.
 */
function pcmOutputArgs({ duration, audio, out, map, fade }) {
  const d = duration.toFixed(3)
  const args = ['-t', d, '-map', map || audio.map, '-vn', '-sn', '-dn']
  if (fade !== undefined) {
    const filters = [fade ? `afade=t=${fade}:st=0:d=${d}` : null, 'apad', `atrim=0:${d}`].filter(Boolean).join(',')
    args.push('-af', filters)
  }
  args.push('-c:a', 'pcm_s24le', '-ar', String(audio.rate), '-ac', String(audio.channels), out)
  return args
}

/** One continuous stream from the spans' PCM pieces, spliced sample to sample. */
function audioConcatGraph(count) {
  if (count === 1) return '[1:a]anull[aout]'
  const labels = []
  for (let index = 0; index < count; index += 1) labels.push(`[${index + 1}:a]`)
  return `${labels.join('')}concat=n=${count}:v=0:a=1[aout]`
}

/**
 * Bake the transitions into the joins and copy everything else. Returns null when
 * the pass could not be done, so the caller can fall back to the plain cut.
 */
async function cutWithTransitions(ctx, { groups, finalPath, ext, audioMap, kind, seconds, scope, fps, faststart }) {
  const planned = transitionPlan(groups, seconds, kind, scope)
  if (!planned.length) return null
  const chunks = await alignCopyChunks(planned)
  const dir = ensureDir(path.join(TEMP_DIR, `fx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
  const listPath = path.join(dir, 'list.txt')
  const expected = chunks.reduce(
    (sum, chunk) => sum + (OVERLAP_KINDS.has(chunk.type) ? chunk.duration : chunk.end - chunk.start),
    0,
  )
  const firstInfo = groups[0].pieces[0].info
  const isHevc = String(firstInfo.video?.codec || '').toLowerCase() === 'hevc'
  if (process.env.CROSSCUT_DEBUG_FX) {
    console.log(
      '[fx] plan:',
      chunks
        .map((c) =>
          OVERLAP_KINDS.has(c.type)
            ? `${c.type} ${c.duration.toFixed(2)}`
            : `${c.type} ${c.start.toFixed(2)}-${c.end.toFixed(2)}`,
        )
        .join(' | '),
    )
  }

  try {
    // Every span is written as MPEG-TS so it carries its own VPS/SPS/PPS. Joining
    // re-encoded chunks with copied MP4 footage in one concat makes the decoder
    // apply the chunk's parameter sets to the copied spans, which corrupts every
    // frame after the first transition (fatal on HEVC, luck-of-the-draw on H.264).
    const audioRate = Number(firstInfo.audio?.sampleRate) || 48000
    const audioChannels = Number(firstInfo.audio?.channels) || 2
    // The chosen track is taken during the span passes, so the recording is
    // read once for the whole export instead of again in the join.
    const audio = audioMap && firstInfo.audio
      ? { map: audioMap, rate: audioRate, channels: audioChannels }
      : null

    const pieces = []
    let index = 0
    for (const chunk of chunks) {
      if (ctx.isCanceled()) throw new Error('Canceled')
      const stem = `piece-${String(index).padStart(4, '0')}`
      const out = path.join(dir, `${stem}.ts`)
      const wav = audio ? path.join(dir, `${stem}.wav`) : null
      index += 1
      let args
      let work
      let copied = false
      let fade = null
      if (chunk.type === 'copy') {
        copied = true
        work = chunk.end - chunk.start
        // Frame count rather than a duration: a copied span that overshoots by a
        // frame duplicates pictures at the next seam and the decoder trips over
        // the overlapping timestamps.
        const rate = fps > 0 ? fps : 30
        const frames = Math.max(1, Math.round(work * rate))
        args = [
          '-ss', chunk.start.toFixed(3), '-i', chunk.source,
          '-frames:v', String(frames), '-t', work.toFixed(3),
          '-map', '0:v:0',
        ]
        args.push('-an', '-sn', '-dn', '-c', 'copy', ...SPAN_TS_OPTS, out)
      } else if (chunk.type === 'fill') {
        work = chunk.end - chunk.start
        args = fillChunkArgs(chunk, null, fps)
        args.push(...SPAN_TS_OPTS, out)
      } else {
        // Blur and wipe exports still fade at the start and end, so dispatch on the
        // chunk itself rather than on the chosen transition.
        const overlap = OVERLAP_KINDS.has(chunk.type)
        ctx.stage(
          chunk.type === 'blur' ? 'Blurring each cut' : chunk.type === 'wipe' ? 'Wiping each cut' : 'Fading each cut',
        )
        work = overlap ? chunk.duration : chunk.end - chunk.start
        args = overlap
          ? overlapChunkArgs(chunk.type, chunk, audio ? audioMap : null, fps, Boolean(audio))
          : dipChunkArgs(chunk, null, fps)
        if (!overlap) fade = chunk.mode === 'out' ? 'out' : 'in'
        args.push(...SPAN_TS_OPTS, out)
      }
      if (audio && OVERLAP_KINDS.has(chunk.type)) {
        // A blur or wipe already blended its audio inside the filter graph.
        args.push(...pcmOutputArgs({ duration: work, audio, out: wav, map: '[aud]' }))
      } else if (audio) {
        args.push(...pcmOutputArgs({ duration: work, audio, out: wav, fade }))
      }
      await runOne(ctx, args, work, null)
      pieces.push({ file: out, wav, duration: work, copied })
    }

    // Each entry's planned length is declared, otherwise the demuxer offsets the
    // next span by whatever the previous file really measured and the cut grows.
    const lines = []
    for (const piece of pieces) {
      lines.push(`file '${escapeConcatPath(piece.file)}'`)
      lines.push(`duration ${piece.duration.toFixed(6)}`)
    }
    fs.writeFileSync(listPath, `${lines.join('\n')}\n`)

    ctx.stage('Joining the cut with its transitions')
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath]
    if (audio) {
      for (const piece of pieces) args.push('-i', piece.wav)
      args.push('-filter_complex', audioConcatGraph(pieces.length))
    }
    args.push('-map', '0:v:0?')
    if (audio) args.push('-map', '[aout]')
    args.push('-sn', '-dn', '-c:v', 'copy')
    // One encoder for the whole cut, so the joins are sample-continuous. The
    // bundled AAC encoder runs at about 60x realtime and becomes the slowest
    // stage of a long export; Windows' own encoder is a little over twice as
    // fast at the same quality, so it is asked for first and the bundled one
    // still covers machines where it is missing.
    const audioEncoder = (codec) => ['-c:a', codec, '-b:a', '256k', '-ar', String(audioRate), '-ac', String(audioChannels)]
    if (!audio) args.push('-an')
    const tailArgs = ['-avoid_negative_ts', 'make_zero']
    if (['mp4', 'mov'].includes(ext)) {
      // Mixed by construction: the transition spans are libx265 output and the
      // rest is the recording copied untouched, so the track carries two
      // parameter-set families and must be tagged hev1.
      if (isHevc) tailArgs.push('-tag:v', 'hev1')
      tailArgs.push('-video_track_timescale', '90000')
      if (faststart) tailArgs.push('-movflags', '+faststart')
    }
    if (ext === 'mkv') tailArgs.push('-f', 'matroska')
    try {
      await runOne(ctx, [...args, ...(audio ? audioEncoder('aac_mf') : []), ...tailArgs, finalPath], expected, null)
    } catch (err) {
      if (!audio || ctx.isCanceled()) throw err
      ctx.log('System audio encoder unavailable, using the bundled one (slower on long exports)')
      try {
        fs.unlinkSync(finalPath)
      } catch {
        /* a partial file is rewritten below */
      }
      await runOne(ctx, [...args, ...audioEncoder('aac'), ...tailArgs, finalPath], expected, null)
    }
    const flavour = kind === 'blur' ? 'Blur dissolves' : kind === 'wipe' ? 'Soft wipes' : 'Fades to black'
    const pointCount = chunks.filter((c) => c.type === 'dip' || OVERLAP_KINDS.has(c.type)).length
    const copyCount = pieces.filter((p) => p.copied).length
    ctx.log(
      `${flavour} baked into ${pointCount} point${pointCount === 1 ? '' : 's'} · ${copyCount} span${copyCount === 1 ? '' : 's'} copied untouched`,
    )
    if (chunks.some((c) => c.type === 'fill')) {
      ctx.log('Frames before the next keyframe were re-encoded so the cuts stay exact')
    }
    return expected
  } catch (err) {
    if (ctx.isCanceled()) throw err
    ctx.log(`Transitions could not be applied (${err.message}). Exporting the cut without them.`)
    try {
      fs.unlinkSync(finalPath)
    } catch {
      /* a partial file must not be left behind */
    }
    return null
  } finally {
    if (!process.env.CROSSCUT_KEEP_TEMP) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    } else {
      console.log('[fx] kept temp chunks in', dir)
    }
  }
}

/** Join rendered pieces into one file, copying when the sources agree. */
async function joinPieces(ctx, parts, finalPath, ext, pieceInfos, presetId, options, faststart = false) {
  const mixed =
    pieceInfos.length > 1 &&
    pieceInfos.some((info, index) => index > 0 && !streamsMatch(pieceInfos[0], info))

  if (!mixed) {
    ctx.stage('Joining parts')
    const listPath = writeConcatList(parts, path.dirname(parts[0]))
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy']
    if (['mp4', 'mov'].includes(ext)) {
      // Separate pieces were encoded separately, so only a single piece can
      // still be one bitstream's worth of parameter sets.
      args.push(...hevcTagArgs(pieceInfos[0], ext, pieceInfos.length > 1))
      args.push('-video_track_timescale', '90000')
      if (faststart) args.push('-movflags', '+faststart')
    }
    if (ext === 'mkv') args.push('-f', 'matroska')
    args.push(finalPath)
    try {
      await runOne(ctx, args, 0, 'Joining parts (copy)')
      try {
        fs.unlinkSync(listPath)
      } catch {
        /* ignore */
      }
      ctx.log(`Joined ${parts.length} pieces with stream copy`)
      return
    } catch (err) {
      if (ctx.isCanceled()) throw err
      ctx.log(`Copy join failed (${err.message}). Re-encoding the join instead.`)
      try {
        fs.unlinkSync(listPath)
      } catch {
        /* ignore */
      }
    }
  } else {
    ctx.log('The recordings differ in codec, size or audio layout, so the join is re-encoded')
  }

  const withAudio = pieceInfos.every((info) => Boolean(info.audio))
  const width = pieceInfos[0]?.video?.width || 0
  const height = pieceInfos[0]?.video?.height || 0
  const inputs = []
  const filters = []
  for (const [index, part] of parts.entries()) {
    inputs.push('-i', part)
    const fit =
      width && height
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,`
        : ''
    filters.push(`[${index}:v:0]${fit}setpts=PTS-STARTPTS[v${index}]`)
    if (withAudio) filters.push(`[${index}:a:0]asetpts=PTS-STARTPTS[a${index}]`)
  }
  const concatInputs = parts.map((_, index) => (withAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join('')
  const graph = `${filters.join(';')};${concatInputs}concat=n=${parts.length}:v=1:a=${withAudio ? 1 : 0}[v][a]`
  const built = buildEncode(presetId || 'h264-mp4', { ...(options ?? {}), faststart })
  const args = [...inputs, '-filter_complex', graph, '-map', '[v]']
  if (withAudio) args.push('-map', '[a]')
  args.push('-sn', '-dn', ...colorArgs(pieceInfos[0]), ...built.v, ...built.a, ...built.container, finalPath)
  await runOne(ctx, args, 0, 'Joining parts (re-encode)')
}

/**
 * A project is an ordered list of clips, so a cut list is expressed on the
 * project timeline. One fragment can cover the tail of one recording and the
 * head of the next; it is rendered as one piece per source and then joined.
 */
export async function cut(ctx, params) {
  const requested = (Array.isArray(params.clips) ? params.clips : [])
    .map((clip) => ({ path: String(clip?.path ?? ''), duration: Math.max(0, Number(clip?.duration) || 0) }))
    .filter((clip) => clip.path)

  if (!requested.length && params.source) requested.push({ path: String(params.source), duration: 0 })
  if (!requested.length) throw new Error('Nothing to export: add a clip to the timeline first')

  for (const clip of requested) {
    if (!fs.existsSync(clip.path)) throw new Error(`Source file is missing: ${path.basename(clip.path)}`)
  }

  const infos = []
  for (const clip of requested) {
    const info = await probe(clip.path)
    infos.push(info)
    if (!(clip.duration > 0)) clip.duration = info.duration
  }

  const clips = []
  let cursor = 0
  for (const clip of requested) {
    clips.push({ path: clip.path, offset: cursor, duration: clip.duration })
    cursor += clip.duration
  }
  const totalDuration = cursor
  if (!(totalDuration > 0)) throw new Error('The timeline is empty')

  const mode = params.mode || 'lossless'
  const preset = getPreset(params.preset || 'h264-mp4')
  const options = params.options ?? {}
  const single = params.output === 'single'
  const audioMap = audioMapFor(params.audioTrack, infos[0].audioTracks)
  // 'clip' keeps each recording's own track: the app sends the stream index it
  // previewed each source with, keyed by path.
  const clipTracks = params.clipTracks && typeof params.clipTracks === 'object' ? params.clipTracks : {}
  const perClipAudio = params.audioTrack === 'clip'
  // Keep subtitles and chapters when the output container can hold them.
  const keepExtras = params.keepExtras === true
  const containerOverride = params.container && params.container !== 'auto' ? params.container : ''
  // Off by default: the faststart pass rewrites the whole output, which on a
  // long export costs as much as the cut itself and YouTube does not need it.
  const faststart = params.faststart === true

  if (!infos.some((info) => info.video) && !preset.audioOnly) {
    throw new Error('This source has no video stream. Pick an audio preset to export it.')
  }

  let segments = (params.segments ?? [])
    .map((segment) => ({
      start: Math.max(0, Math.min(totalDuration, Number(segment.start) || 0)),
      end: Math.max(0, Math.min(totalDuration, Number(segment.end) || 0)),
      label: segment.label || '',
      // A fragment may follow a different microphone or commentary track than
      // the rest of the project, in which case only that fragment re-encodes.
      audio: typeof segment.audio === 'string' ? segment.audio : '',
    }))
    .filter((segment) => segment.end - segment.start > 0.01)
    .sort((a, b) => a.start - b.start)
  if (!segments.length) segments = [{ start: 0, end: totalDuration, label: 'full' }]

  const outDir = resolveOutDir(params.outDir, requested[0].path)
  // A named project supplies the export name; an unnamed timeline names itself
  // after its first recording.
  const baseName =
    String(params.name ?? '').trim() || path.basename(requested[0].path, path.extname(requested[0].path))

  /** The track one recording is set to export with, as a `track:<index>` value. */
  const clipAudioFor = (sourcePath) => {
    const index = Number(clipTracks[sourcePath])
    return Number.isInteger(index) && index >= 0 ? `track:${index}` : ''
  }

  /** Split one timestamped cut into a piece per recording it touches. */
  const piecesFor = (segment) => {
    const pieces = []
    for (const [index, clip] of clips.entries()) {
      const from = Math.max(segment.start, clip.offset)
      const to = Math.min(segment.end, clip.offset + clip.duration)
      if (to - from <= 0.01) continue
      pieces.push({
        source: clip.path,
        info: infos[index],
        start: from - clip.offset,
        end: to - clip.offset,
        duration: to - from,
        audio: segment.audio || (perClipAudio ? clipAudioFor(clip.path) : ''),
      })
    }
    return pieces
  }

  /** The audio map one piece uses: its fragment's own track, or the export's. */
  const audioMapForPiece = (piece) =>
    piece.audio ? audioMapFor(piece.audio, piece.info.audioTracks) : audioMap
  /**
   * Whether this piece keeps a different track from the rest of the export. The
   * optional-stream `?` is not part of the choice, so re-picking the export's own
   * track must not look like a switch and re-encode the fragment.
   */
  const pieceSwitchesAudio = (piece) =>
    Boolean(audioMap) &&
    Boolean(piece.audio) &&
    audioMapForPiece(piece).replace(/\?$/, '') !== audioMap.replace(/\?$/, '')

  // Lossless never needs keyframes. Smart render only wants to know whether a
  // cut starts on one, which costs a few seconds of reading around that point.
  const copyAllowed = async (piece) => {
    if (mode === 'lossless') return true
    if (mode !== 'smart') return false
    const frames = await keyframesNear(piece.source, piece.start)
    return isOnKeyframe(frames, piece.start, 0.12)
  }

  const encodeFor = (piece, copy, final = false) => {
    if (copy) return { copy: true }
    if (mode === 'smart') return { copy: false, encode: sourceMatchedEncode(piece.info) }
    const built = buildEncode(params.preset, final ? { ...options, faststart } : options)
    return {
      copy: false,
      encode: {
        ...built,
        family: preset.family,
        gifWidth: options.quality,
        gifFps: options.gifFps,
        audioFilter:
          options.loudnorm && built.a.includes('-c:a') && !built.a.includes('copy')
            ? 'loudnorm=I=-16:TP=-1.5:LRA=11'
            : undefined,
      },
    }
  }

  const totalKept = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
  const pieceCount = segments.reduce((sum, segment) => sum + piecesFor(segment).length, 0)
  let completed = 0
  let rendered = 0

  const renderPiece = async (piece, outPath, format, stage, final = false) => {
    if (ctx.isCanceled()) throw new Error('Canceled')
    ctx.stage(stage)
    const pieceMap = audioMapForPiece(piece)
    // Swapping the audio track inside a copied fragment is not something the
    // concat demuxer can express, so that fragment is re-encoded instead.
    const copy = (await copyAllowed(piece)) && !pieceSwitchesAudio(piece)
    const choice = encodeFor(piece, copy, final)
    const args = buildSegmentArgs({
      source: piece.source,
      start: piece.start,
      end: piece.end,
      copy: choice.copy,
      encode: choice.encode,
      outPath,
      format,
      audioMap: pieceMap,
      keepExtras,
      videoCodec: piece.info?.video?.codec ?? '',
      info: piece.info,
    })
    const base = completed
    const { done } = runFfmpeg({
      ffmpeg: tools().ffmpeg,
      args,
      totalSec: piece.duration,
      onProgress: (progress) => {
        const sofar = base + Math.min(piece.duration, (progress.percent / 100) * piece.duration)
        ctx.progress(
          totalKept > 0 ? Math.min(92, (sofar / totalKept) * 92) : 0,
          { ...progress, piece: rendered + 1, pieces: pieceCount },
        )
      },
      onLog: (line) => ctx.log(line),
      onChild: (child) => ctx.onChild(child),
    })
    const res = await done
    if (ctx.isCanceled()) throw new Error('Canceled')
    if (res.code !== 0) throw new Error(failureMessage(res.tail))
    completed = base + piece.duration
    rendered += 1
    ctx.log(
      `Piece ${rendered}/${pieceCount} · ${path.basename(piece.source)} ${timecode(piece.start)} → ${timecode(piece.end)} · ${copy ? 'copy' : 're-encode'}`,
    )
  }

  const templated = (segment, index) =>
    applyTemplate(params.nameTemplate, {
      name: baseName,
      label: segment.label || `Part ${index + 1}`,
      index: String(index + 1).padStart(2, '0'),
      start: timecode(segment.start),
      end: timecode(segment.end),
      preset: preset.id,
    })

  const report = async (file) => {
    const stats = await syncInfo(file)
    if (stats.audioDuration > 0 && !stats.ok) {
      ctx.log(`WARNING: audio/video durations differ by ${stats.deltaMs} ms in ${path.basename(file)}`)
    }
    if (!faststart && /\.(mp4|mov)$/i.test(file)) {
      ctx.log('MP4 index left at the end of the file (no rewrite pass). Turn on Faststart in Export for instant web playback.')
    }
    return { path: file, size: stats.size, duration: stats.duration, sync: stats }
  }

  /** Extension for a file made from these pieces; MP4 whenever copy allows it. */
  const extFor = (pieces) => {
    if (containerOverride) return containerOverride
    if (mode === 'encode') return preset.ext
    return copyContainerFor(pieces.map((piece) => piece.info))
  }

  /** One cut that lives entirely inside one recording. */
  const renderDirect = async (piece, segment, index, stage) => {
    if (preset.family === 'imageseq' && mode === 'encode') {
      const folder = uniquePath(path.join(outDir, templated(segment, index)))
      ensureDir(folder)
      const pattern = path.join(folder, `frame_%05d.${preset.ext}`)
      const args = buildSegmentArgs({
        source: piece.source,
        start: piece.start,
        end: piece.end,
        copy: false,
        encode: { ...buildEncode(params.preset, options), family: 'imageseq' },
        outPath: pattern,
        audioMap,
      })
      await runOne(ctx, args, piece.duration, stage)
      completed += piece.duration
      return { path: folder, size: 0, duration: piece.duration }
    }
    const finalPath = uniquePath(path.join(outDir, `${templated(segment, index)}.${extFor([piece])}`))
    await renderPiece(piece, finalPath, null, stage, true)
    return report(finalPath)
  }

  /** A cut that spans more than one recording: cut and join it. */
  const renderJoined = async (segment, index, pieces, stage) => {
    const ext = extFor(pieces)
    const finalPath = uniquePath(path.join(outDir, `${templated(segment, index)}.${ext}`))
    const infos = pieces.map((piece) => piece.info)
    const copyable =
      mode === 'lossless' && !pieces.some(pieceSwitchesAudio) && infos.every((info) => streamsMatch(infos[0], info))

    // Lossless with matching streams: one pass, straight into the output file.
    if (
      copyable &&
      (await cutAndJoinCopy(ctx, pieces, finalPath, ext, segment.end - segment.start, faststart, audioMap))
    ) {
      return report(finalPath)
    }

    const tempDir = ensureDir(path.join(TEMP_DIR, `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
    const parts = []
    try {
      for (const [position, piece] of pieces.entries()) {
        const partPath = path.join(tempDir, `part-${String(position).padStart(4, '0')}.mkv`)
        await renderPiece(piece, partPath, 'matroska', `${stage} · piece ${position + 1}/${pieces.length}`)
        parts.push(partPath)
      }
      ctx.log(`Joining ${parts.length} pieces from ${new Set(pieces.map((piece) => piece.source)).size} recordings`)
      await joinPieces(ctx, parts, finalPath, ext, infos, params.preset, options, faststart)
      return report(finalPath)
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  // One merged file --------------------------------------------------------
  if (single) {
    if (preset.family === 'imageseq' && mode === 'encode') {
      throw new Error('Image sequences must be exported as separate segments')
    }
    const groups = segments
      .map((segment, index) => ({ segment, index, pieces: piecesFor(segment) }))
      .filter((group) => group.pieces.length > 0)
    const allPieces = groups.flatMap((group) => group.pieces)
    const allInfos = allPieces.map((piece) => piece.info)
    const copyable = mode === 'lossless' && allInfos.every((info) => streamsMatch(allInfos[0], info))
    const transitionKind =
      params.transition === 'dip' || params.transition === 'blur' || params.transition === 'wipe'
        ? params.transition
        : 'none'
    // Where the fades land: every join, only the opening and closing frames, or both.
    const transitionScope =
      params.transitionScope === 'joins' || params.transitionScope === 'ends' ? params.transitionScope : 'both'
    const transitionSeconds = Math.max(0.1, Math.min(3, Number(params.transitionSeconds) || 0.5))

    // Lossless with matching streams: cut and join the whole cut list in one
    // pass, straight into the output file, with nothing written to a temp folder.
    const finalExt = containerOverride || (mode === 'encode' ? preset.ext || 'mkv' : copyContainerFor(allInfos))
    const finalPath = uniquePath(
      path.join(
        outDir,
        `${applyTemplate(params.nameTemplate, {
          name: baseName,
          label: 'merged',
          index: '01',
          start: timecode(segments[0].start),
          end: timecode(segments[segments.length - 1].end),
          preset: preset.id,
        })}.${finalExt}`,
      ),
    )
    // A fragment that switches audio track no longer takes the whole export out
    // of the copy path: only the switched fragments are encoded, the rest stay
    // copies, and the spans are joined with one stream copy.
    const switchableAudio = Boolean(audioMap) && audioMap !== '0:a?' && !keepExtras
    const switchPieces = switchableAudio ? allPieces.filter((piece) => pieceSwitchesAudio(piece)) : []
    // A track choice the copy path cannot express (every track, or extras kept)
    // still sends the export down the older per-piece route.
    const fragmentsSwitchAudio = segments.some((segment) => segment.audio) && !switchableAudio

    // A fade or blur has to be encoded, so only the split second at each join or
    // end is re-encoded; every other span is still a straight copy.
    const wantsTransitions =
      copyable &&
      !fragmentsSwitchAudio &&
      switchPieces.length === 0 &&
      transitionKind !== 'none' &&
      (groups.length > 1 || transitionScope !== 'joins')
    if (wantsTransitions) {
      const where =
        transitionScope === 'ends'
          ? 'at the start and end'
          : transitionScope === 'joins'
            ? 'at each join'
            : 'at each join and both ends'
      ctx.log(
        `${segments.length} cuts · ${transitionKind === 'blur' ? 'blur dissolve' : 'dip to black'} ${transitionSeconds}s ${where} · ${finalExt.toUpperCase()}`,
      )
      const expected = await cutWithTransitions(ctx, {
        groups,
        finalPath,
        ext: finalExt,
        audioMap,
        kind: transitionKind,
        seconds: transitionSeconds,
        scope: transitionScope,
        fps: infos[0].video?.fps || 30,
        faststart,
      })
      if (expected) {
        ctx.progress(97, {})
        const stats = await syncInfo(finalPath)
        ctx.log(
          `Output: ${path.basename(finalPath)} · expected ${(expected / 60).toFixed(2)} min · got ${(stats.duration / 60).toFixed(2)} min · A/V drift ${stats.deltaMs} ms`,
        )
        if (stats.audioDuration > 0 && !stats.ok) ctx.log(`WARNING: audio lags/leads video by ${stats.deltaMs} ms`)
        return {
          outputs: [await report(finalPath)],
          result: {
            parts: allPieces.length,
            recordings: clips.length,
            copied: true,
            transition: transitionKind,
            expectedDuration: expected,
            sync: stats,
          },
        }
      }
    }

    if (allPieces.length === 1) {
      const only = groups[0]
      const single = uniquePath(path.join(outDir, `${templated(only.segment, 0)}.${extFor(allPieces)}`))
      await renderPiece(allPieces[0], single, null, 'Exporting', true)
      const stats = await syncInfo(single)
      ctx.log(
        `Output: ${path.basename(single)} · expected ${(totalDuration / 60).toFixed(2)} min · got ${(stats.duration / 60).toFixed(2)} min`,
      )
      return { outputs: [await report(single)] }
    }

    const switchEncoder = switchPieces.length ? exportAudioEncoder(allPieces[0].info, audioMap) : null
    if (copyable && switchPieces.length && switchEncoder) {
      ctx.log(
        `${switchPieces.length} fragment${switchPieces.length === 1 ? '' : 's'} switch audio · ${allPieces.length - switchPieces.length} of ${allPieces.length} spans copied`,
      )
      if (
        await cutAndJoinSwitchedAudio(ctx, {
          pieces: allPieces,
          finalPath,
          ext: finalExt,
          audioMap,
          audioEncoder: switchEncoder,
          audioMapForPiece,
          switchesAudio: pieceSwitchesAudio,
          fps: infos[0].video?.fps || 30,
          faststart,
        })
      ) {
        ctx.progress(97, {})
        const stats = await syncInfo(finalPath)
        ctx.log(
          `Output: ${path.basename(finalPath)} · expected ${(totalKept / 60).toFixed(2)} min · got ${(stats.duration / 60).toFixed(2)} min · A/V drift ${stats.deltaMs} ms`,
        )
        if (Math.abs(stats.duration - totalKept) > Math.max(1, totalKept * 0.002)) {
          ctx.log(`WARNING: output duration differs from the sum of segments by ${(stats.duration - totalKept).toFixed(2)}s`)
        }
        if (stats.audioDuration > 0 && !stats.ok) ctx.log(`WARNING: audio lags/leads video by ${stats.deltaMs} ms`)
        return {
          outputs: [await report(finalPath)],
          result: {
            parts: allPieces.length,
            recordings: clips.length,
            copied: true,
            reencodedFragments: switchPieces.length,
            expectedDuration: totalKept,
            sync: stats,
          },
        }
      }
    }

    if (copyable && !fragmentsSwitchAudio && switchPieces.length === 0) {
      ctx.log(`${segments.length} cuts · ${allPieces.length} pieces from ${clips.length} recordings · ${finalExt.toUpperCase()}`)
      if (
        await cutAndJoinCopy(
          ctx,
          allPieces,
          finalPath,
          finalExt,
          totalKept,
          faststart,
          audioMap,
          keepExtras,
          keepExtras ? writeChapterMeta(segments, ensureDir(path.join(TEMP_DIR, `chapters-${Date.now()}`))) : '',
        )
      ) {
        ctx.progress(97, {})
        const stats = await syncInfo(finalPath)
        ctx.log(
          `Output: ${path.basename(finalPath)} · expected ${(totalKept / 60).toFixed(2)} min · got ${(stats.duration / 60).toFixed(2)} min · A/V drift ${stats.deltaMs} ms`,
        )
        if (Math.abs(stats.duration - totalKept) > Math.max(1, totalKept * 0.002)) {
          ctx.log(`WARNING: output duration differs from the sum of segments by ${(stats.duration - totalKept).toFixed(2)}s`)
        }
        if (stats.audioDuration > 0 && !stats.ok) ctx.log(`WARNING: audio lags/leads video by ${stats.deltaMs} ms`)
        return {
          outputs: [await report(finalPath)],
          result: {
            parts: allPieces.length,
            recordings: clips.length,
            copied: true,
            expectedDuration: totalKept,
            sync: stats,
          },
        }
      }
    }

    const tempDir = ensureDir(path.join(TEMP_DIR, `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`))
    const parts = []
    const pieceInfos = []
    try {
      let position = 0
      for (const group of groups) {
        for (const piece of group.pieces) {
          const partPath = path.join(tempDir, `part-${String(position).padStart(4, '0')}.mkv`)
          position += 1
          await renderPiece(piece, partPath, 'matroska', `Part ${group.index + 1}/${segments.length}`)
          parts.push(partPath)
          pieceInfos.push(piece.info)
        }
      }

      ctx.log(`${segments.length} cuts · ${parts.length} pieces from ${clips.length} recording${clips.length === 1 ? '' : 's'}`)
      await joinPieces(ctx, parts, finalPath, finalExt, pieceInfos, params.preset, options, faststart)
      ctx.progress(97, {})
      const stats = await syncInfo(finalPath)
      ctx.log(
        `Output: ${path.basename(finalPath)} · expected ${(totalKept / 60).toFixed(2)} min · got ${(stats.duration / 60).toFixed(2)} min · A/V drift ${stats.deltaMs} ms`,
      )
      if (Math.abs(stats.duration - totalKept) > Math.max(1, totalKept * 0.002)) {
        ctx.log(`WARNING: output duration differs from the sum of segments by ${(stats.duration - totalKept).toFixed(2)}s`)
      }
      if (stats.audioDuration > 0 && !stats.ok) {
        ctx.log(`WARNING: audio lags/leads video by ${stats.deltaMs} ms`)
      }
      return {
        outputs: [await report(finalPath)],
        result: {
          parts: parts.length,
          recordings: clips.length,
          copied: mode === 'lossless',
          reencoded: mode !== 'lossless',
          expectedDuration: totalKept,
          sync: stats,
        },
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  // Separate files ---------------------------------------------------------
  const outputs = []
  for (const [index, segment] of segments.entries()) {
    const pieces = piecesFor(segment)
    if (!pieces.length) continue
    const stage = `Segment ${index + 1}/${segments.length}`
    if (pieces.length === 1) {
      outputs.push(await renderDirect(pieces[0], segment, index, stage))
    } else {
      ctx.log(`Segment ${index + 1} spans ${pieces.length} recordings`)
      outputs.push(await renderJoined(segment, index, pieces, stage))
    }
  }
  return { outputs }
}

// ---------------------------------------------------------------------------
// concat existing files
// ---------------------------------------------------------------------------

function streamsMatch(a, b) {
  if (!a.video || !b.video) return false
  if (a.video.codec !== b.video.codec) return false
  if (a.video.width !== b.video.width || a.video.height !== b.video.height) return false
  if (a.video.pixFmt !== b.video.pixFmt) return false
  const aAudio = a.audio
  const bAudio = b.audio
  if (Boolean(aAudio) !== Boolean(bAudio)) return false
  if (aAudio && bAudio) {
    if (aAudio.codec !== bAudio.codec) return false
    if (aAudio.sampleRate !== bAudio.sampleRate) return false
    if (aAudio.channels !== bAudio.channels) return false
  }
  return true
}

export async function concatFiles(ctx, params) {
  const files = (params.files ?? []).filter((file) => file && fs.existsSync(file))
  if (files.length < 2) throw new Error('Pick at least two files to merge')
  const infos = []
  for (const file of files) infos.push(await probe(file))

  let compatible = true
  for (let i = 1; i < infos.length; i += 1) {
    if (!streamsMatch(infos[0], infos[i])) compatible = false
  }

  const strategy = params.strategy === 'encode' ? 'encode' : params.strategy === 'copy' ? 'copy' : compatible ? 'copy' : 'encode'
  if (strategy === 'copy' && !compatible) {
    throw new Error('Files have different codecs or resolutions, so they cannot be joined without re-encoding. Use Encode mode.')
  }

  const outDir = resolveOutDir(params.outDir, files[0])
  const ext = strategy === 'copy' ? path.extname(files[0]).slice(1) || 'mkv' : getPreset(params.preset || 'h264-mp4').ext
  const outPath = uniquePath(
    path.join(outDir, `${safeName(params.name || `merged ${new Date().toISOString().slice(0, 10)}`)}.${ext}`),
  )
  const totalDuration = infos.reduce((sum, info) => sum + info.duration, 0)

  if (strategy === 'copy') {
    ctx.log(`Joining ${files.length} files with stream copy`)
    const listPath = writeConcatList(files, TEMP_DIR)
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v?', '-map', '0:a?', '-sn', '-dn', '-c', 'copy']
    if (['mp4', 'mov'].includes(ext)) {
      args.push('-video_track_timescale', '90000')
      if (params.faststart === true) args.push('-movflags', '+faststart')
    }
    args.push(outPath)
    try {
      await runOne(ctx, args, totalDuration, 'Joining files')
    } finally {
      try {
        fs.unlinkSync(listPath)
      } catch {
        /* ignore */
      }
    }
  } else {
    ctx.log(`Re-encoding ${files.length} files into one`)
    const inputs = []
    const filters = []
    const withAudio = infos.every((info) => Boolean(info.audio))
    for (const [index, file] of files.entries()) {
      inputs.push('-i', file)
      filters.push(`[${index}:v:0]setpts=PTS-STARTPTS,scale=${infos[0].video.width}:${infos[0].video.height}:force_original_aspect_ratio=decrease,pad=${infos[0].video.width}:${infos[0].video.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`)
      if (withAudio) filters.push(`[${index}:a:0]asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[a${index}]`)
    }
    const concatInputs = files.map((_, index) => (withAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join('')
    const graph = `${filters.join(';')};${concatInputs}concat=n=${files.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? '[a]' : ''}`
    const built = buildEncode(params.preset || 'h264-mp4', params.options ?? {})
    const args = [...inputs, '-filter_complex', graph, '-map', '[v]']
    if (withAudio) args.push('-map', '[a]')
    args.push('-sn', '-dn', ...built.v, ...built.a, ...built.container, outPath)
    await runOne(ctx, args, totalDuration, 'Re-encoding join')
  }

  ctx.progress(99, {})
  const stats = await syncInfo(outPath)
  ctx.log(`Output duration ${(stats.duration / 60).toFixed(2)} min (expected ${(totalDuration / 60).toFixed(2)} min)`)
  if (Math.abs(stats.duration - totalDuration) > Math.max(1.5, totalDuration * 0.002)) {
    ctx.log(`WARNING: joined duration differs by ${(stats.duration - totalDuration).toFixed(2)}s`)
  }
  if (stats.audioDuration > 0 && !stats.ok) ctx.log(`WARNING: A/V drift ${stats.deltaMs} ms`)
  return { outputs: [{ path: outPath, size: stats.size, duration: stats.duration, sync: stats }], result: { strategy, compatible, sync: stats } }
}

// ---------------------------------------------------------------------------
// mux video + audio (the "audio desync" repair path)
// ---------------------------------------------------------------------------

function atempoChain(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return []
  const parts = []
  let r = ratio
  while (r > 2) {
    parts.push(2)
    r /= 2
  }
  while (r < 0.5) {
    parts.push(0.5)
    r /= 0.5
  }
  if (Math.abs(r - 1) > 0.0002) parts.push(Number(r.toFixed(6)))
  return parts.map((value) => `atempo=${value}`)
}

const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac'])
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9'])

export async function compareSync(params) {
  const video = params.video
  const audio = params.audio
  if (!video || !audio) throw new Error('Pick both a video and an audio source')
  const vInfo = await probe(video)
  const aInfo = await probe(audio)
  const videoDuration = vInfo.video?.duration || vInfo.duration
  const audioDuration = aInfo.audio?.duration || aInfo.duration
  const drift = audioDuration - videoDuration
  return {
    video: { path: video, duration: videoDuration, streams: vInfo },
    audio: { path: audio, duration: audioDuration, codec: aInfo.audio?.codec, channels: aInfo.audio?.channels },
    driftSeconds: drift,
    driftMs: Math.round(drift * 1000),
    ppm: videoDuration > 0 ? Math.round((drift / videoDuration) * 1_000_000) : 0,
    suggestedRatio: videoDuration > 0 ? audioDuration / videoDuration : 1,
    suggestion:
      Math.abs(drift) < 0.05
        ? 'Lengths match. A straight copy mux will be in sync.'
        : `Audio is ${Math.abs(drift).toFixed(3)}s ${drift > 0 ? 'longer' : 'shorter'}. Use Stretch to remove the drift, or Trim to cut the tail.`,
  }
}

export async function mux(ctx, params) {
  if (!params.video || !fs.existsSync(params.video)) throw new Error('Video file is missing')
  if (!params.audio || !fs.existsSync(params.audio)) throw new Error('Audio file is missing')

  const vInfo = await probe(params.video)
  const aInfo = await probe(params.audio)
  const videoDuration = vInfo.video?.duration || vInfo.duration
  const audioDuration = aInfo.audio?.duration || aInfo.duration
  const offset = Number(params.offset) || 0
  const mode = params.sync || 'copy'
  const keepOriginal = Boolean(params.keepOriginalAudio) && Boolean(vInfo.audio)

  const ext = (params.container || 'mkv').toLowerCase()
  const outDir = resolveOutDir(params.outDir, params.video)
  const outPath = uniquePath(
    path.join(outDir, `${safeName(params.name || `${path.basename(params.video, path.extname(params.video))} synced`)}.${ext}`),
  )

  const args = []
  if (offset) args.push('-itsoffset', String(offset))
  args.push('-i', params.video)
  if (offset) args.push('-itsoffset', String(offset))
  args.push('-i', params.audio)

  args.push('-map', '0:v:0')
  args.push('-map', '1:a:0')
  if (keepOriginal) args.push('-map', '0:a:0')

  const videoCopyable = ['mkv', 'mp4', 'mov', 'ts'].includes(ext) && MP4_VIDEO.has(vInfo.video?.codec ?? '') || ['mkv', 'ts'].includes(ext)
  if (!videoCopyable) {
    ctx.log(`Container .${ext} may not accept ${vInfo.video?.codec}; using MKV instead`)
  }
  args.push('-c:v', 'copy')
  args.push('-sn', '-dn')

  let audioArgs = []
  if (mode === 'stretch') {
    const measured = audioDuration > 0 && videoDuration > 0 ? audioDuration / videoDuration : 1
    const ratio = Number(params.ratio) > 0 ? Number(params.ratio) : measured
    const chain = atempoChain(ratio)
    const filter = [...chain, 'aresample=async=1:first_pts=0'].join(',')
    ctx.log(`Stretching audio by ${ratio.toFixed(6)}× (${(ratio - 1).toFixed(4)}) to match ${videoDuration.toFixed(3)}s`)
    if (!chain.length) ctx.log('Ratio is 1.0 — no stretch needed')
    audioArgs = ['-filter:a', filter, '-c:a', MP4_AUDIO.has('aac') ? 'aac' : 'aac', '-b:a', `${Number(params.audioBitrate) || 320}k`]
  } else if (mode === 'trim') {
    audioArgs = ['-c:a', 'copy', '-shortest']
    ctx.log('Trimming audio to the length of the video')
  } else {
    const copyable = (ext === 'mp4' || ext === 'mov') ? MP4_AUDIO.has(aInfo.audio?.codec ?? '') : true
    if (copyable) {
      audioArgs = ['-c:a', 'copy']
      ctx.log('Copying audio stream without re-encoding')
    } else {
      audioArgs = ['-c:a', 'aac', '-b:a', `${Number(params.audioBitrate) || 320}k`]
      ctx.log(`Audio codec ${aInfo.audio?.codec} is not valid in .${ext}; encoding AAC instead`)
    }
  }
  args.push(...audioArgs)
  if (keepOriginal) args.push('-c:a:1', 'copy')
  if (['mp4', 'mov'].includes(ext)) {
    args.push('-video_track_timescale', '90000')
    if (params.faststart === true) args.push('-movflags', '+faststart')
  }
  args.push('-y', outPath)

  const totalSec = Math.max(videoDuration, audioDuration)
  await runOne(ctx, args, totalSec, 'Muxing')
  ctx.progress(99, {})
  const stats = await syncInfo(outPath)
  ctx.log(
    `Done · video ${stats.videoDuration.toFixed(3)}s · audio ${stats.audioDuration.toFixed(3)}s · drift ${stats.deltaMs} ms`,
  )
  return {
    outputs: [{ path: outPath, size: stats.size, duration: stats.duration, sync: stats }],
    result: { videoDuration, audioDuration, driftMs: stats.deltaMs, offset, mode, sync: stats },
  }
}

// ---------------------------------------------------------------------------
// analysis (silence / black / scene)
// ---------------------------------------------------------------------------

export async function analyze(ctx, params) {
  const source = params.source
  if (!source || !fs.existsSync(source)) throw new Error('Source file is missing')
  const info = await probe(source)
  const kind = params.kind || 'silence'
  const lines = []

  let args = []
  if (kind === 'silence') {
    if (!info.audio) throw new Error('No audio stream to analyse')
    const noise = Number(params.noiseDb) || -35
    const min = Number(params.minDuration) || 1.5
    args = ['-i', source, '-map', '0:a:0', '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-']
  } else if (kind === 'black') {
    const min = Number(params.minDuration) || 0.5
    args = ['-i', source, '-map', '0:v:0?', '-vf', `blackdetect=d=${min}:pix_th=0.10:pic_th=0.98`, '-an', '-f', 'null', '-']
  } else if (kind === 'scene') {
    const threshold = Number(params.threshold) || 0.35
    args = [
      '-i', source,
      '-map', '0:v:0?',
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ]
  } else if (kind === 'keyframes') {
    const frames = await keyframes(source)
    return { outputs: [], result: { kind, keyframes: frames } }
  } else {
    throw new Error(`Unknown analysis: ${kind}`)
  }

  const { done } = runFfmpeg({
    ffmpeg: tools().ffmpeg,
    args,
    totalSec: info.duration,
    onProgress: (progress) => ctx.progress(progress.percent, progress),
    onLog: (line) => {
      lines.push(line)
      if (lines.length > 20000) lines.shift()
    },
    onChild: (child) => ctx.onChild(child),
  })
  const res = await done
  if (res.code !== 0 && !lines.length) throw new Error(failureMessage(res.tail))

  const result = { kind, duration: info.duration }
  if (kind === 'silence') {
    const silences = []
    let openStart = null
    for (const line of lines) {
      const start = line.match(/silence_start:\s*(-?[\d.]+)/)
      const end = line.match(/silence_end:\s*(-?[\d.]+)/)
      if (start) openStart = Math.max(0, Number(start[1]))
      if (end) {
        const endTime = Number(end[1])
        if (openStart !== null && endTime > openStart) silences.push({ start: openStart, end: endTime })
        openStart = null
      }
    }
    if (openStart !== null && info.duration > openStart) silences.push({ start: openStart, end: info.duration })
    result.silences = silences
    const speech = []
    let cursor = 0
    for (const silence of silences) {
      if (silence.start > cursor + 0.05) speech.push({ start: cursor, end: silence.start })
      cursor = Math.max(cursor, silence.end)
    }
    if (cursor < info.duration) speech.push({ start: cursor, end: info.duration })
    result.speech = speech
    result.suggestions = silences
      .filter((silence) => silence.end - silence.start >= (Number(params.minDuration) || 1.5))
      .map((silence, index) => ({
        kind: 'silence',
        start: silence.start,
        end: silence.end,
        label: `silence ${index + 1}`,
      }))
    ctx.log(`Found ${silences.length} silences, ${speech.length} speech blocks`)
  } else if (kind === 'black') {
    const black = []
    let openStart = null
    for (const line of lines) {
      const start = line.match(/black_start:\s*(-?[\d.]+)/)
      const end = line.match(/black_end:\s*(-?[\d.]+)/)
      if (start) openStart = Math.max(0, Number(start[1]))
      if (end) {
        const endTime = Number(end[1])
        if (openStart !== null) black.push({ start: openStart, end: endTime })
        openStart = null
      }
    }
    result.black = black
    result.suggestions = black.map((entry, index) => ({
      kind: 'black',
      start: entry.start,
      end: entry.end,
      label: `black ${index + 1}`,
    }))
    ctx.log(`Found ${black.length} black spans`)
  } else {
    const scenes = []
    for (const line of lines) {
      const match = line.match(/pts_time:\s*([\d.]+)/)
      if (match) {
        const time = Number(match[1])
        if (Number.isFinite(time) && (!scenes.length || time - scenes[scenes.length - 1] > 0.05)) scenes.push(time)
      }
    }
    result.scenes = scenes
    result.suggestions = scenes.map((time) => ({ kind: 'scene', time, label: `scene @ ${time.toFixed(2)}` }))
    ctx.log(`Found ${scenes.length} scene changes`)
  }

  return { outputs: [], result }
}

// ---------------------------------------------------------------------------
// full-file waveform (only when explicitly asked for)
// ---------------------------------------------------------------------------

export async function waveformJob(ctx, params) {
  if (!params.source || !fs.existsSync(params.source)) throw new Error('Source file is missing')
  const buckets = Math.max(1000, Math.min(20000, Number(params.buckets) || 4000))
  const track = Math.max(0, Number(params.track) || 0)
  ctx.stage('Reading audio')
  const peaks = await buildOverview(
    params.source,
    buckets,
    (pct) => ctx.progress(pct, { stage: 'Reading audio' }),
    track,
  )
  ctx.log(`Waveform overview built with ${peaks.length} points`)
  return { outputs: [], result: { buckets: peaks.length } }
}

// ---------------------------------------------------------------------------
// browser preview proxy
// ---------------------------------------------------------------------------

export async function proxy(ctx, params) {
  if (!params.source || !fs.existsSync(params.source)) throw new Error('Source file is missing')
  const info = await probe(params.source)
  if (!info.video) throw new Error('No video stream to preview')
  const dir = ensureDir(path.join(CACHE_DIR, 'proxies'))
  const target = path.join(dir, `${fileHash(params.source)}.mp4`)

  if (fs.existsSync(target) && fs.statSync(target).size > 1024) {
    ctx.log('Reusing cached preview proxy')
    ctx.progress(100, {})
    return { outputs: [{ path: target, size: fs.statSync(target).size, duration: info.duration }] }
  }

  const height = Math.min(720, info.video.height || 720)
  const args = [
    '-i', params.source,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:${height}:flags=bilinear`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', target,
  ]
  ctx.log(`Building a ${height}p preview proxy (this keeps the original file untouched)`)
  await runOne(ctx, args, info.duration, 'Building preview')
  return { outputs: [{ path: target, size: fs.statSync(target).size, duration: info.duration }] }
}

// ---------------------------------------------------------------------------

export async function runJob(job, ctx) {
  switch (job.type) {
    case 'tool':
      return updateFfmpeg(ctx)
    case 'cut':
      return cut(ctx, job.params)
    case 'concat':
      return concatFiles(ctx, job.params)
    case 'mux':
      return mux(ctx, job.params)
    case 'analyze':
      return analyze(ctx, job.params)
    case 'proxy':
      return proxy(ctx, job.params)
    case 'waveform':
      return waveformJob(ctx, job.params)
    case 'verify':
      return verifyOutputJob(ctx, job.params)
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}
