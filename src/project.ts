import type { Segment } from './types'

export function uid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`
}

export const EPSILON = 1e-4

export function keptDuration(segments: Segment[]): number {
  return segments.reduce((sum, segment) => (segment.enabled ? sum + (segment.end - segment.start) : sum), 0)
}

export function markerTimes(segments: Segment[]): number[] {
  const markers: number[] = []
  for (let index = 0; index < segments.length - 1; index += 1) markers.push(segments[index].end)
  return markers
}

export function markerForTime(segments: Segment[], time: number): number {
  let best = -1
  let distance = Infinity
  for (let index = 0; index < segments.length - 1; index += 1) {
    const gap = Math.abs(segments[index].end - time)
    if (gap < distance) {
      distance = gap
      best = index
    }
  }
  return best
}

/**
 * Fragments must tile the whole clip with no gaps or overlaps, the way markers
 * behave in SolveigMM. Anything the caller hands over is repaired into that shape.
 */
export function normalizePartition(list: Segment[], duration: number): Segment[] {
  if (!(duration > 0)) return []
  const sorted = list
    .filter((segment) => segment && segment.end > segment.start + EPSILON)
    .slice()
    .sort((a, b) => a.start - b.start)

  // A clip with no saved project starts as one fragment keeping everything.
  if (!sorted.length) return [{ id: uid(), start: 0, end: duration, label: '', enabled: true }]

  const out: Segment[] = []
  let cursor = 0

  for (const segment of sorted) {
    const start = Math.min(Math.max(segment.start, cursor), duration)
    const end = Math.min(Math.max(segment.end, start), duration)
    if (start > cursor + EPSILON) {
      out.push({ id: uid(), start: cursor, end: start, label: '', enabled: false })
    }
    if (end > start + EPSILON) {
      out.push({ ...segment, start, end, enabled: segment.enabled !== false })
    }
    cursor = Math.max(cursor, end)
  }

  if (cursor < duration - EPSILON) {
    out.push({ id: uid(), start: cursor, end: duration, label: '', enabled: false })
  }

  if (!out.length) return [{ id: uid(), start: 0, end: duration, label: '', enabled: true }]
  return out
}

/** Add a marker at `time`: the fragment under the playhead becomes two. */
export function splitAt(segments: Segment[], time: number, minimum = 0.02): { segments: Segment[]; markerIndex: number } {
  const index = segments.findIndex((segment) => time > segment.start + minimum && time < segment.end - minimum)
  if (index < 0) return { segments, markerIndex: -1 }
  const left = { ...segments[index], end: time }
  const right = { ...segments[index], id: uid(), start: time }
  const next = [...segments.slice(0, index), left, right, ...segments.slice(index + 1)]
  return { segments: next, markerIndex: index }
}

/** Delete a marker: the two neighbouring fragments become one. */
export function removeMarker(segments: Segment[], index: number): Segment[] {
  if (index < 0 || index >= segments.length - 1) return segments
  const left = segments[index]
  const right = segments[index + 1]
  const merged: Segment = {
    ...left,
    end: right.end,
    enabled: left.enabled || right.enabled,
    label: left.label || right.label,
  }
  return [...segments.slice(0, index), merged, ...segments.slice(index + 2)]
}

export function setEnabled(segments: Segment[], id: string | null, enabled: boolean): Segment[] {
  if (!id) return segments
  return segments.map((segment) => (segment.id === id ? { ...segment, enabled } : segment))
}

export function invert(segments: Segment[]): Segment[] {
  return segments.map((segment) => ({ ...segment, enabled: !segment.enabled }))
}

export function toggleAt(segments: Segment[], time: number): Segment[] {
  return segments.map((segment) =>
    time >= segment.start && time < segment.end ? { ...segment, enabled: !segment.enabled } : segment,
  )
}

export function previousIndex(segments: Segment[], id: string | null): number {
  const index = segments.findIndex((segment) => segment.id === id)
  return index > 0 ? index - 1 : -1
}

export function neighbourId(segments: Segment[], id: string | null, direction: 1 | -1): string | null {
  const index = segments.findIndex((segment) => segment.id === id)
  if (index < 0) return null
  const next = index + direction
  if (next < 0 || next >= segments.length) return null
  return segments[next].id
}

/** Trim everything before/after the playhead by cutting out the outer fragments. */
export function trimBefore(segments: Segment[], time: number): Segment[] {
  return segments.map((segment) => (segment.end <= time + EPSILON ? { ...segment, enabled: false } : segment))
}

export function trimAfter(segments: Segment[], time: number): Segment[] {
  return segments.map((segment) => (segment.start >= time - EPSILON ? { ...segment, enabled: false } : segment))
}

export function cutRange(segments: Segment[], start: number, end: number): Segment[] {
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  return segments.map((segment) => {
    const overlaps = segment.start < to && segment.end > from
    return overlaps ? { ...segment, enabled: false } : segment
  })
}

/**
 * Divide the kept result into equal slices. Each slice is a list of source
 * segments, so a slice can span a removed fragment without including it.
 */
export function chunkSegments(
  segments: Segment[],
  options: { parts?: number; chunkSeconds?: number },
): Segment[][] {
  const kept = segments.filter((segment) => segment.enabled && segment.end - segment.start > EPSILON)
  if (!kept.length) return []
  const total = kept.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
  const parts = Math.floor(Number(options.parts) || 0)
  const chunkSeconds = Number(options.chunkSeconds) || 0
  const chunkLength = parts >= 2 ? total / parts : chunkSeconds
  if (!(chunkLength > 0.05) || chunkLength >= total) return [kept]

  const chunks: Segment[][] = []
  let current: Segment[] = []
  let filled = 0

  for (const segment of kept) {
    let cursor = segment.start
    while (cursor < segment.end - EPSILON) {
      if (filled >= chunkLength - EPSILON) {
        if (current.length) chunks.push(current)
        current = []
        filled = 0
      }
      const take = Math.min(chunkLength - filled, segment.end - cursor)
      if (take <= EPSILON) break
      current.push({
        id: uid(),
        start: cursor,
        end: cursor + take,
        label: segment.label,
        enabled: true,
        audio: segment.audio,
      })
      cursor += take
      filled += take
    }
  }
  if (current.length) chunks.push(current)
  return chunks
}

export function frameStep(fps: number): number {
  return 1 / Math.max(1, fps || 25)
}
