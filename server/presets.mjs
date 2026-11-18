import { detectTools } from './bin.mjs'

/**
 * Encoding presets. `family` drives the codec argument builder.
 * quality: CRF-ish scale where lower = better quality / bigger file.
 */
export const PRESETS = [
  // Video ------------------------------------------------------------------
  {
    id: 'h264-mp4',
    label: 'H.264 · MP4',
    group: 'Video',
    family: 'x264',
    ext: 'mp4',
    qualityKind: 'crf',
    defaultQuality: 20,
    defaultSpeed: 'medium',
    note: 'Plays everywhere. The safe default for delivery.',
  },
  {
    id: 'h264-mkv',
    label: 'H.264 · MKV',
    group: 'Video',
    family: 'x264',
    ext: 'mkv',
    qualityKind: 'crf',
    defaultQuality: 20,
    defaultSpeed: 'medium',
    note: 'Same as MP4, container tolerant of odd streams.',
  },
  {
    id: 'hevc-mp4',
    label: 'H.265 / HEVC · MP4',
    group: 'Video',
    family: 'x265',
    ext: 'mp4',
    qualityKind: 'crf',
    defaultQuality: 24,
    defaultSpeed: 'medium',
    note: 'Half the size of H.264, slower to encode.',
  },
  {
    id: 'hevc-mkv',
    label: 'H.265 / HEVC · MKV',
    group: 'Video',
    family: 'x265',
    ext: 'mkv',
    qualityKind: 'crf',
    defaultQuality: 24,
    defaultSpeed: 'medium',
  },
  {
    id: 'av1-mp4',
    label: 'AV1 · MP4',
    group: 'Video',
    family: 'av1',
    ext: 'mp4',
    qualityKind: 'crf',
    defaultQuality: 32,
    defaultSpeed: 'medium',
    note: 'Best compression. Very slow without hardware AV1.',
  },
  {
    id: 'vp9-webm',
    label: 'VP9 · WebM',
    group: 'Video',
    family: 'vp9',
    ext: 'webm',
    qualityKind: 'crf',
    defaultQuality: 32,
    defaultSpeed: 'medium',
  },
  {
    id: 'prores-mov',
    label: 'ProRes 422 · MOV',
    group: 'Video',
    family: 'prores',
    ext: 'mov',
    qualityKind: 'prores',
    defaultQuality: 2,
    note: 'Editing intermediate, huge files, near-lossless.',
  },
  {
    id: 'prores4444-mov',
    label: 'ProRes 4444 · MOV',
    group: 'Video',
    family: 'prores4444',
    ext: 'mov',
    qualityKind: 'prores',
    defaultQuality: 4,
  },
  {
    id: 'dnxhr-mov',
    label: 'DNxHR HQ · MOV',
    group: 'Video',
    family: 'dnxhr',
    ext: 'mov',
    qualityKind: 'none',
    note: 'Avid intermediate format.',
  },
  {
    id: 'h264-fast',
    label: 'H.264 · Fast (hardware)',
    group: 'Video',
    family: 'x264',
    ext: 'mp4',
    qualityKind: 'crf',
    defaultQuality: 23,
    defaultSpeed: 'veryfast',
    preferHardware: true,
    note: 'Hardware encoder when available. Fast bulk exports.',
  },
  {
    id: 'gif',
    label: 'Animated GIF',
    group: 'Video',
    family: 'gif',
    ext: 'gif',
    qualityKind: 'size',
    defaultQuality: 480,
    note: 'Short clips only. Width in pixels.',
  },
  {
    id: 'copy-mp4',
    label: 'Remux · MP4',
    group: 'Remux',
    family: 'copy',
    ext: 'mp4',
    note: 'No re-encode. Instant. Keeps original quality.',
  },
  {
    id: 'copy-mkv',
    label: 'Remux · MKV',
    group: 'Remux',
    family: 'copy',
    ext: 'mkv',
  },
  {
    id: 'copy-mov',
    label: 'Remux · MOV',
    group: 'Remux',
    family: 'copy',
    ext: 'mov',
  },
  {
    id: 'copy-ts',
    label: 'Remux · MPEG-TS',
    group: 'Remux',
    family: 'copy',
    ext: 'ts',
    note: 'Streaming-friendly, tolerant of huge durations.',
  },

  // Audio ------------------------------------------------------------------
  {
    id: 'mp3',
    label: 'MP3 320',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'mp3',
    audioCodec: 'mp3',
    defaultAudioBitrate: 320,
  },
  {
    id: 'aac-m4a',
    label: 'AAC · M4A',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'm4a',
    audioCodec: 'aac',
    defaultAudioBitrate: 256,
  },
  {
    id: 'wav',
    label: 'WAV · PCM',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'wav',
    audioCodec: 'pcm',
  },
  {
    id: 'flac',
    label: 'FLAC · lossless',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'flac',
    audioCodec: 'flac',
  },
  {
    id: 'opus-ogg',
    label: 'Opus · OGG',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'ogg',
    audioCodec: 'opus',
    defaultAudioBitrate: 160,
  },
  {
    id: 'audio-copy',
    label: 'Extract audio · copy',
    group: 'Audio',
    family: 'audio',
    audioOnly: true,
    ext: 'mka',
    audioCodec: 'copy',
    note: 'Pulls the audio stream out without re-encoding.',
  },

  // Stills -----------------------------------------------------------------
  {
    id: 'jpeg-seq',
    label: 'JPEG sequence',
    group: 'Stills',
    family: 'imageseq',
    ext: 'jpg',
    qualityKind: 'crf',
    defaultQuality: 2,
    note: 'Writes numbered frames into a folder.',
  },
  {
    id: 'png-seq',
    label: 'PNG sequence',
    group: 'Stills',
    family: 'imageseq',
    ext: 'png',
    qualityKind: 'none',
  },

  // Utility ----------------------------------------------------------------
  {
    id: 'loudnorm-mp4',
    label: 'Loudness normalise · MP4',
    group: 'Utility',
    family: 'loudnorm',
    ext: 'mp4',
    defaultAudioBitrate: 192,
    note: 'Copies video, re-encodes audio to -16 LUFS.',
  },
]

export const PRESET_MAP = new Map(PRESETS.map((preset) => [preset.id, preset]))

export function getPreset(id) {
  const preset = PRESET_MAP.get(id)
  if (!preset) throw new Error(`Unknown preset: ${id}`)
  return preset
}

function resolveHardware(family, mode) {
  const encoders = detectTools().encoders
  const table = {
    x264: { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' },
    x265: { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf' },
    av1: { nvenc: 'av1_nvenc', qsv: 'av1_qsv' },
  }
  const row = table[family]
  if (!row || !mode || mode === 'none') return null
  if (mode === 'auto') {
    for (const key of ['nvenc', 'qsv', 'amf']) {
      if (row[key] && encoders.has(row[key])) return row[key]
    }
    return null
  }
  const name = row[mode]
  return name && encoders.has(name) ? name : null
}

function svtPreset(speed) {
  const map = {
    ultrafast: '12',
    veryfast: '10',
    fast: '8',
    medium: '6',
    slow: '4',
    veryslow: '2',
  }
  return map[speed] ?? '6'
}

function vp9CpuUsed(speed) {
  const map = { ultrafast: '6', veryfast: '5', fast: '4', medium: '2', slow: '1', veryslow: '0' }
  return map[speed] ?? '2'
}

export function buildEncode(presetId, options = {}) {
  const preset = getPreset(presetId)
  const quality = Number.isFinite(Number(options.quality))
    ? Number(options.quality)
    : (preset.defaultQuality ?? 20)
  const speed = options.speed || preset.defaultSpeed || 'medium'
  const audioBitrate = Number(options.audioBitrate) || preset.defaultAudioBitrate || 192
  const hwMode = options.hardware || 'none'
  const v = []
  const a = []
  const container = []
  const videoFilter = []
  const notes = []

  if (preset.audioOnly) {
    a.push('-vn')
  } else if (!preset.audioOnly) {
    if (options.scale && options.scale !== 'source') {
      videoFilter.push(`scale=-2:${Math.max(2, Number(options.scale))}:flags=lanczos`)
    }
    if (options.fps && options.fps !== 'source') {
      videoFilter.push(`fps=${Number(options.fps)}`)
    }
  }

  const family = preset.family

  if (family === 'x264' || family === 'x265' || family === 'av1' || family === 'vp9') {
    const hw =
      hwMode === 'none' ? null : resolveHardware(family, hwMode === 'auto' && !preset.preferHardware ? 'none' : hwMode)
    const pix = '-pix_fmt'
    if (family === 'x264') {
      if (hw === 'h264_nvenc') {
        v.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0')
        notes.push('NVENC H.264')
      } else if (hw === 'h264_qsv') {
        v.push('-c:v', 'h264_qsv', '-global_quality', String(quality))
        notes.push('QSV H.264')
      } else if (hw === 'h264_amf') {
        v.push('-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality), '-quality', 'balanced')
        notes.push('AMF H.264')
      } else {
        v.push('-c:v', 'libx264', '-preset', speed, '-crf', String(quality))
      }
      v.push(pix, 'yuv420p')
    } else if (family === 'x265') {
      if (hw === 'hevc_nvenc') {
        v.push('-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0')
        notes.push('NVENC HEVC')
      } else if (hw === 'hevc_qsv') {
        v.push('-c:v', 'hevc_qsv', '-global_quality', String(quality))
        notes.push('QSV HEVC')
      } else if (hw === 'hevc_amf') {
        v.push('-c:v', 'hevc_amf', '-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality), '-quality', 'balanced')
        notes.push('AMF HEVC')
      } else {
        v.push('-c:v', 'libx265', '-preset', speed, '-crf', String(quality))
      }
      v.push(pix, 'yuv420p')
      if (preset.ext === 'mp4') container.push('-tag:v', 'hvc1')
    } else if (family === 'av1') {
      if (hw === 'av1_nvenc') {
        v.push('-c:v', 'av1_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0')
        notes.push('NVENC AV1')
      } else if (hw === 'av1_qsv') {
        v.push('-c:v', 'av1_qsv', '-global_quality', String(quality))
        notes.push('QSV AV1')
      } else if (detectTools().encoders.has('libsvtav1')) {
        v.push('-c:v', 'libsvtav1', '-preset', svtPreset(speed), '-crf', String(quality))
      } else {
        v.push('-c:v', 'libaom-av1', '-crf', String(quality), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1')
      }
      v.push(pix, 'yuv420p')
    } else if (family === 'vp9') {
      v.push('-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', vp9CpuUsed(speed))
      v.push(pix, 'yuv420p')
    }
  } else if (family === 'prores' || family === 'prores4444') {
    const profile = family === 'prores4444' ? 4 : Number(quality) || 2
    v.push('-c:v', 'prores_ks', '-profile:v', String(profile), '-vendor', 'apl0')
    v.push('-pix_fmt', family === 'prores4444' ? 'yuva444p10le' : 'yuv422p10le')
    notes.push('ProRes 422 HQ' )
  } else if (family === 'dnxhr') {
    v.push('-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p')
  } else if (family === 'copy') {
    v.push('-c:v', 'copy')
  } else if (family === 'loudnorm') {
    v.push('-c:v', 'copy')
  } else if (family === 'gif') {
    // handled by the filter graph in the cut task
  } else if (family === 'imageseq') {
    v.push('-c:v', preset.ext === 'png' ? 'png' : 'mjpeg')
    if (preset.ext !== 'png') v.push('-q:v', String(quality))
    v.push('-f', 'image2')
  } else if (family === 'audio') {
    a.push('-vn')
  }

  // Audio ------------------------------------------------------------------
  const audioMode = options.audio || 'auto'
  if (preset.audioOnly) {
    const codec = preset.audioCodec || 'aac'
    if (codec === 'copy') a.push('-c:a', 'copy')
    else if (codec === 'pcm') a.push('-c:a', 'pcm_s16le')
    else if (codec === 'mp3') a.push('-c:a', 'libmp3lame', '-b:a', `${audioBitrate}k`)
    else if (codec === 'flac') a.push('-c:a', 'flac', '-compression_level', '8')
    else if (codec === 'opus') a.push('-c:a', 'libopus', '-b:a', `${audioBitrate}k`)
    else a.push('-c:a', 'aac', '-b:a', `${audioBitrate}k`)
    if (options.loudnorm) {
      a.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
    }
  } else if (family === 'copy' || family === 'loudnorm') {
    if (audioMode === 'none') a.push('-an')
    else if (family === 'loudnorm') {
      a.push('-c:a', 'aac', '-b:a', `${audioBitrate}k`, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
    } else if (audioMode === 'transcode') {
      a.push('-c:a', 'aac', '-b:a', `${audioBitrate}k`)
    } else {
      a.push('-c:a', 'copy')
    }
  } else if (family === 'gif') {
    a.push('-an')
  } else if (family === 'imageseq') {
    a.push('-an')
  } else {
    if (audioMode === 'none') a.push('-an')
    else if (audioMode === 'copy' && family !== 'prores' && family !== 'prores4444') a.push('-c:a', 'copy')
    else if (preset.ext === 'webm') a.push('-c:a', 'libopus', '-b:a', `${Math.min(audioBitrate, 256)}k`)
    else if (family === 'prores' || family === 'prores4444' || family === 'dnxhr') a.push('-c:a', 'pcm_s16le')
    else {
      a.push('-c:a', 'aac', '-b:a', `${audioBitrate}k`)
      if (options.loudnorm) a.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
    }
  }

  // Faststart rewrites the whole file to move the index to the front, which
  // doubles the write time on a long export, so it is opt-in.
  if (options.faststart && (preset.ext === 'mp4' || preset.ext === 'mov')) {
    container.push('-movflags', '+faststart')
  }
  if (preset.ext === 'mp4' || preset.ext === 'mov') {
    container.push('-video_track_timescale', '90000')
  }

  return { preset, v, a, container, videoFilter, ext: preset.ext, notes }
}

export function presetCatalog() {
  const status = detectTools()
  return {
    presets: PRESETS,
    hardware: {
      nvenc: status.encoders.has('h264_nvenc') || status.encoders.has('hevc_nvenc'),
      qsv: status.encoders.has('h264_qsv') || status.encoders.has('hevc_qsv'),
      amf: status.encoders.has('h264_amf') || status.encoders.has('hevc_amf'),
      av1: status.encoders.has('av1_nvenc') || status.encoders.has('av1_qsv'),
    },
  }
}
