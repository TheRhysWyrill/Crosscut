import type { MediaInfo, Segment } from './types'
import { EPSILON, normalizePartition, uid } from './project'

/** Where one clip sits on the project timeline. */
export interface ClipSpan {
  info: MediaInfo
  index: number
  start: number
  end: number
}

export interface ClipWindow {
  span: ClipSpan
  /** Visible part of this clip, in project time. */
  start: number
  end: number
  /** The same range inside the recording. */
  localStart: number
  localEnd: number
}

/**
 * A project is a sequence of clips. They always tile [0, total] in order, so
 * every clip starts where the previous one ended.
 */
export function clipSpans(clips: MediaInfo[]): ClipSpan[] {
  let cursor = 0
  return clips.map((info, index) => {
    const start = cursor
    cursor += Math.max(0, info.duration || 0)
    return { info, index, start, end: cursor }
  })
}

export function timelineDuration(clips: MediaInfo[]): number {
  return clips.reduce((sum, info) => sum + Math.max(0, info.duration || 0), 0)
}

/** The clip under a project time, with the time inside that recording. */
export function locateClip(clips: MediaInfo[], time: number): { span: ClipSpan; local: number } | null {
  if (!clips.length) return null
  const spans = clipSpans(clips)
  const clamped = Math.max(0, time)
  const found = spans.find((span) => clamped >= span.start && clamped < span.end - EPSILON)
  if (found) return { span: found, local: Math.min(found.end - found.start, Math.max(0, clamped - found.start)) }
  const last = spans[spans.length - 1]
  return { span: last, local: last.end - last.start }
}

/** The visible part of the timeline, split into one window per clip. */
export function clipWindows(clips: MediaInfo[], start: number, end: number): ClipWindow[] {
  const windows: ClipWindow[] = []
  for (const span of clipSpans(clips)) {
    const from = Math.max(start, span.start)
    const to = Math.min(end, span.end)
    if (to - from <= EPSILON) continue
    windows.push({
      span,
      start: from,
      end: to,
      localStart: from - span.start,
      localEnd: to - span.start,
    })
  }
  return windows
}

/** New material is kept by default: the last fragment grows to cover it. */
export function appendSegments(segments: Segment[], duration: number): Segment[] {
  if (!(duration > 0)) return []
  if (!segments.length) return normalizePartition([], duration)
  const last = segments[segments.length - 1]
  if (last.end >= duration - EPSILON) return segments
  if (last.enabled) return [...segments.slice(0, -1), { ...last, end: duration }]
  return [...segments, { id: uid(), start: last.end, end: duration, label: '', enabled: true }]
}

/**
 * Keeps a cut list meaningful when clips are removed or reordered: every
 * fragment is carried across by matching recording, then re-tiled so it still
 * covers the project with no gaps.
 */
export function remapSegments(segments: Segment[], before: MediaInfo[], after: MediaInfo[]): Segment[] {
  const total = timelineDuration(after)
  if (!(total > 0)) return []
  if (!segments.length) return normalizePartition([], total)
  const oldSpans = clipSpans(before)
  const starts = new Map<string, number>()
  for (const span of clipSpans(after)) starts.set(span.info.path, span.start)

  const pieces: Segment[] = []
  for (const segment of segments) {
    for (const span of oldSpans) {
      const from = Math.max(segment.start, span.start)
      const to = Math.min(segment.end, span.end)
      if (to - from <= EPSILON) continue
      const target = starts.get(span.info.path)
      if (target === undefined) continue
      const shift = target - span.start
      const start = from + shift
      const end = to + shift
      const last = pieces[pieces.length - 1]
      if (last && Math.abs(last.end - start) < EPSILON && last.enabled === (segment.enabled !== false)) {
        last.end = end
      } else {
        pieces.push({
          id: `${segment.id}-${pieces.length}`,
          start,
          end,
          label: segment.label,
          enabled: segment.enabled !== false,
          audio: segment.audio ?? '',
        })
      }
    }
  }

  if (!pieces.length) return normalizePartition([], total)
  return normalizePartition(pieces, total)
}
