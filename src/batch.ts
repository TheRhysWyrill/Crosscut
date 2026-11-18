import type { AudioTrack, ExportConfig, JobInput, Segment } from './types'
import { baseName } from './format'
import { chunkSegments } from './project'

export interface SourceRef {
  /** The project timeline: clips in playback order. */
  clips: { path: string; offset: number; duration: number }[]
  duration: number
  audioTracks: AudioTrack[]
  /** Per-recording audio stream choice, keyed by source path. */
  tracks?: Record<string, number>
  /** A saved project's name, which becomes the export's {name}. */
  name?: string
}

export interface AudioTarget {
  value: string
  label: string
  /** Appended to the file name so two audio runs never collide. */
  suffix: string
}

export function trackName(track: AudioTrack, position: number): string {
  const fallback = `audio ${String(position + 1).padStart(2, '0')}`
  return track.title || (track.language && track.language !== 'und' ? `${fallback} (${track.language})` : fallback)
}

export function describeTrack(track: AudioTrack, position: number): string {
  const bits = [`track ${position + 1}`, track.codec || 'audio']
  if (track.channels) bits.push(`${track.channels}ch`)
  const name = track.title || (track.language && track.language !== 'und' ? track.language : '')
  return name ? `${bits.join(' · ')} · ${name}` : bits.join(' · ')
}

/**
 * Which audio streams one export run keeps. `both` fans out one job per track,
 * which is what commentary + game audio recordings need.
 */
export function audioTargets(mode: string, tracks: AudioTrack[]): AudioTarget[] {
  const usable = Array.isArray(tracks) ? tracks : []
  if (!usable.length) return [{ value: 'first', label: '', suffix: '' }]
  // Each recording can keep its own track, so the app sends a stream index per
  // source path instead of one index for the whole project.
  if (mode === 'clip') return [{ value: 'clip', label: 'each recording\u2019s own track', suffix: '' }]
  if (mode === 'both') {
    return usable.map((track, position) => ({
      value: `track:${track.index}`,
      label: describeTrack(track, position),
      suffix: ` - ${trackName(track, position)}`,
    }))
  }
  if (mode === 'all') return [{ value: 'all', label: 'all tracks', suffix: ' - all audio' }]
  if (typeof mode === 'string' && mode.startsWith('track:')) {
    const index = Number(mode.slice(6))
    const position = usable.findIndex((track) => track.index === index)
    if (position >= 0) {
      return [
        {
          value: mode,
          label: describeTrack(usable[position], position),
          suffix: ` - ${trackName(usable[position], position)}`,
        },
      ]
    }
  }
  return [{ value: 'first', label: '', suffix: '' }]
}

/**
 * A merged export is one file, so it takes exactly the project name: the index
 * token and the separator in front of it are dropped.
 */
function withoutIndex(template: string): string {
  const cleaned = String(template ?? '')
    .replace(/\s*[-\u2013\u2014_|\u00b7]\s*\{index\}/gi, '')
    .replace(/\{index\}\s*[-\u2013\u2014_|\u00b7]\s*/gi, '')
    .replace(/\{index\}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned || '{name}'
}

/** Separate files and slices need an index, so add one when the pattern lacks it. */
function withIndex(template: string): string {
  const raw = String(template ?? '').trim() || '{name}'
  return /\{index\}/i.test(raw) ? raw : `${raw} - {index}`
}

/** One or more queue jobs for the project timeline and its cut list. */
export function buildCutJobs(source: SourceRef, segments: Segment[], config: ExportConfig): JobInput[] {
  const clips = source.clips.filter((clip) => clip.path)
  if (!clips.length) return []
  const enabled = segments.filter((segment) => segment.enabled)
  const list = enabled.length
    ? enabled
    : [{ id: 'full', start: 0, end: source.duration, label: '', enabled: true }]
  const targets = audioTargets(config.audioMode, source.audioTracks ?? [])
  const modeLabel = config.mode === 'encode' ? config.presetLabel || config.presetId : config.mode
  const name = source.name?.trim() || baseName(clips[0].path)
  // A named project names the export; the recording is only the fallback.
  const template =
    config.sliceMode === 'none' && config.output !== 'separate'
      ? withoutIndex(config.nameTemplate)
      : withIndex(config.nameTemplate)
  const clipTracks = source.tracks && typeof source.tracks === 'object' ? source.tracks : {}
  const jobs: JobInput[] = []

  for (const target of targets) {
    const base = {
      clips: clips.map((clip) => ({ path: clip.path, offset: clip.offset, duration: clip.duration })),
      name,
      mode: config.mode,
      preset: config.presetId,
      options: config.options,
      container: config.mode === 'encode' ? config.presetExt || 'mp4' : config.container,
      outDir: config.outDir,
      audioTrack: target.value,
      clipTracks,
      faststart: config.faststart === true,
      transition: config.transition ?? 'none',
      transitionScope: config.transitionScope ?? 'both',
      transitionSeconds: config.transitionSeconds ?? 0.5,
      keepExtras: config.keepExtras === true,
    }
    const audioNote = target.label ? ` · ${target.label}` : ''

    if (config.sliceMode === 'none') {
      jobs.push({
        type: 'cut',
        label: `${name} · ${list.length} cut${list.length === 1 ? '' : 's'} · ${modeLabel}${audioNote}`,
        params: {
          ...base,
          output: config.output,
          segments: list.map((segment) => ({
            start: segment.start,
            end: segment.end,
            label: segment.label,
            audio: segment.audio ?? '',
          })),
          nameTemplate: `${template}${target.suffix}`,
        },
      })
      continue
    }

    const chunks = chunkSegments(list, {
      parts: config.sliceMode === 'parts' ? config.sliceParts : 0,
      chunkSeconds: config.sliceMode === 'duration' ? config.sliceMinutes * 60 : 0,
    })
    if (!chunks.length) continue
    const width = String(chunks.length).padStart(2, '0')
    chunks.forEach((chunk, index) => {
      const part = String(index + 1).padStart(2, '0')
      jobs.push({
        type: 'cut',
        label: `${name} · Part ${part}/${width}${audioNote}`,
        params: {
          ...base,
          output: 'single',
          segments: chunk.map((segment) => ({
            start: segment.start,
            end: segment.end,
            label: segment.label,
            audio: segment.audio ?? '',
          })),
          nameTemplate: `${template.replace('{index}', part)}${target.suffix}`,
        },
      })
    })
  }

  return jobs
}
