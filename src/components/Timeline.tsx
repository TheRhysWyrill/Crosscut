import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Segment } from '../types'
import { shortTimecode, timecode } from '../format'

export interface TimelineView {
  start: number
  end: number
}

export interface TimelineClipMark {
  /** The recording this stretch comes from. */
  path: string
  start: number
  end: number
  name: string
  index: number
}

interface TimelineProps {
  duration: number
  fps: number
  /** The interface accent, so drawing never has to read the document style. */
  accent: string
  /** Where each recording starts and ends on the project timeline. */
  clips: TimelineClipMark[]
  view: TimelineView
  onView: (view: TimelineView) => void
  segments: Segment[]
  selectedId: string | null
  selectedMarker: number | null
  range: { start: number; end: number } | null
  waveform: { start: number; end: number; peaks: number[] } | null
  filmstrip: { time: number; dataUrl: string }[]
  playhead: number
  snap: boolean
  keyframes: number[]
  onSeek: (time: number) => void
  onSelect: (id: string | null) => void
  onSelectMarker: (index: number | null) => void
  onBoundary: (index: number, time: number) => void
  onBoundaryCommit: () => void
  onRange: (range: { start: number; end: number } | null) => void
  /** Dragging a clip band reorders the recordings on the timeline. */
  onReorderClips: (path: string, toIndex: number) => void
  /** The ruler is being dragged, so the preview should wait for the release. */
  onScrubStart?: () => void
  onScrubEnd?: () => void
}

const RULER_H = 22
const CLIP_TOP = RULER_H + 5
const CLIP_H = 15
const SEG_TOP = CLIP_TOP + CLIP_H + 4
const SEG_H = 34
const CANVAS_H = 176
const STRIP_H = 34
const WAVE_TOP = SEG_TOP + SEG_H + 7
const WAVE_BOTTOM = CANVAS_H - 14

const PALETTE = {
  bg: '#101217',
  ruler: '#171a20',
  grid: 'rgba(255,255,255,0.028)',
  text: '#77808f',
  wave: '#2d6b67',
  waveBright: '#46a099',
  keep: 'rgba(242, 163, 60, 0.15)',
  keepBorder: 'rgba(242, 163, 60, 0.45)',
  keepSel: 'rgba(242, 163, 60, 0.32)',
  cut: 'rgba(150, 62, 52, 0.28)',
  cutBorder: 'rgba(214, 96, 78, 0.55)',
  marker: '#7fb2ff',
  markerSel: '#ffffff',
  playhead: '#ff5d5d',
  range: 'rgba(94, 176, 255, 0.20)',
  key: '#4d5666',
}

function nearestValue(frames: number[], time: number): number | null {
  if (!frames.length) return null
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
  const before = frames[Math.max(0, hi)]
  const after = frames[Math.min(frames.length - 1, lo)]
  return Math.abs(before - time) <= Math.abs(after - time) ? before : after
}

function lowerBound(frames: number[], value: number): number {
  let lo = 0
  let hi = frames.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function rulerStep(spanSeconds: number, width: number): number {
  const steps = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800]
  for (const step of steps) if ((step / spanSeconds) * width >= 82) return step
  return steps[steps.length - 1]
}

export default function Timeline({
  duration,
  fps,
  accent,
  clips,
  view,
  onView,
  segments,
  selectedId,
  selectedMarker,
  range,
  waveform,
  filmstrip,
  playhead,
  snap,
  keyframes,
  onSeek,
  onSelect,
  onSelectMarker,
  onBoundary,
  onBoundaryCommit,
  onRange,
  onReorderClips,
  onScrubStart,
  onScrubEnd,
}: TimelineProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hatchRef = useRef<CanvasPattern | null>(null)
  const [width, setWidth] = useState(900)
  const [hover, setHover] = useState<{ marker: number | null; fragment: string | null; band: string | null }>({
    marker: null,
    fragment: null,
    band: null,
  })
  // The clip being dragged, and where it would land: drawn as a line on the band.
  const [clipDrag, setClipDrag] = useState<{ path: string; toIndex: number } | null>(null)

  const drag = useRef<
    | { kind: 'clip'; path: string; index: number; toIndex: number }
    | { kind: 'scrub'; hold: boolean }
    | { kind: 'marquee'; anchor: number }
    | { kind: 'marker'; index: number }
    | null
  >(null)
  // Pointer moves arrive faster than the screen redraws; while the ruler is
  // held, one playhead update per frame keeps the drag smooth.
  const scrubFrame = useRef(0)
  const scrubPending = useRef<number | null>(null)

  const span = Math.max(0.0005, view.end - view.start)
  const toX = useCallback((time: number) => ((time - view.start) / span) * width, [view.start, span, width])
  const toT = useCallback((x: number) => view.start + (x / Math.max(1, width)) * span, [view.start, span, width])

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(Math.max(240, entry.contentRect.width))
    })
    observer.observe(element)
    setWidth(Math.max(240, element.clientWidth))
    return () => observer.disconnect()
  }, [])

  // ---- drawing -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = CANVAS_H * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${CANVAS_H}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, CANVAS_H)

    if (!hatchRef.current) {
      const tile = document.createElement('canvas')
      tile.width = 8
      tile.height = 8
      const tctx = tile.getContext('2d')
      if (tctx) {
        tctx.strokeStyle = 'rgba(232, 116, 96, 0.24)'
        tctx.lineWidth = 1.4
        tctx.beginPath()
        tctx.moveTo(-2, 10)
        tctx.lineTo(10, -2)
        tctx.stroke()
      }
      hatchRef.current = ctx.createPattern(tile, 'repeat')
    }

    ctx.fillStyle = PALETTE.bg
    ctx.fillRect(0, 0, width, CANVAS_H)

    // ruler
    ctx.fillStyle = PALETTE.ruler
    ctx.fillRect(0, 0, width, RULER_H)
    const step = rulerStep(span, width)
    const firstTick = Math.floor(view.start / step) * step
    ctx.font = '10px ui-monospace, "Cascadia Mono", monospace'
    ctx.textBaseline = 'middle'
    for (let time = firstTick; time <= view.end + step; time += step) {
      if (time < 0) continue
      const x = Math.round(toX(time)) + 0.5
      if (x < -60 || x > width + 60) continue
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.moveTo(x, RULER_H - 6)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      ctx.fillStyle = PALETTE.text
      ctx.fillText(step >= 1 ? shortTimecode(time) : timecode(time, fps), x + 4, 9)
      ctx.strokeStyle = PALETTE.grid
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, CANVAS_H)
      ctx.stroke()
    }

    // clip band: which recording each stretch of the timeline comes from
    const bandAccent = accent || '#f0a33c'
    for (const clip of clips) {
      const x1 = toX(clip.start)
      const x2 = toX(clip.end)
      if (x2 < -2 || x1 > width + 2) continue
      const left = Math.max(0, x1)
      const right = Math.min(width, x2)
      if (right - left < 0.5) continue
      ctx.fillStyle = clip.index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)'
      ctx.fillRect(left, CLIP_TOP, right - left, CLIP_H)
      ctx.fillStyle = bandAccent
      ctx.globalAlpha = 0.55
      ctx.fillRect(left, CLIP_TOP + CLIP_H - 2, right - left, 2)
      ctx.globalAlpha = 1
      if (right - left > 40) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(left + 4, CLIP_TOP, right - left - 8, CLIP_H)
        ctx.clip()
        ctx.font = '9px "Inter", system-ui, sans-serif'
        ctx.fillStyle = '#9aa3b2'
        ctx.fillText(`${clip.index + 1} · ${clip.name}`, left + 5, CLIP_TOP + 6)
        ctx.restore()
      }
    }
    // where one recording hands over to the next
    for (const clip of clips) {
      if (clip.index === 0) continue
      const x = Math.round(toX(clip.start)) + 0.5
      if (x < -2 || x > width + 2) continue
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, CLIP_TOP)
      ctx.lineTo(x, CANVAS_H)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // waveform (only the visible window, mapped by absolute time)
    const waveMid = (WAVE_TOP + WAVE_BOTTOM) / 2
    const waveAmp = (WAVE_BOTTOM - WAVE_TOP) / 2
    ctx.fillStyle = 'rgba(255,255,255,0.018)'
    ctx.fillRect(0, WAVE_TOP, width, WAVE_BOTTOM - WAVE_TOP)
    if (waveform && waveform.peaks.length > 1) {
      const waveSpan = Math.max(0.001, waveform.end - waveform.start)
      const count = waveform.peaks.length
      for (let x = 0; x < width; x += 1) {
        const t0 = toT(x)
        const t1 = toT(x + 1)
        if (t1 < waveform.start || t0 > waveform.end) continue
        const i0 = Math.max(0, Math.floor(((t0 - waveform.start) / waveSpan) * count))
        const i1 = Math.min(count, Math.max(i0 + 1, Math.ceil(((t1 - waveform.start) / waveSpan) * count)))
        let peak = 0
        for (let i = i0; i < i1; i += 1) if (waveform.peaks[i] > peak) peak = waveform.peaks[i]
        const h = Math.max(0.8, peak * waveAmp)
        ctx.fillStyle = peak > 0.6 ? PALETTE.waveBright : PALETTE.wave
        ctx.fillRect(x, waveMid - h, 1, h * 2)
      }
    }

    // keyframes
    if (keyframes.length) {
      const from = lowerBound(keyframes, view.start - 1)
      const to = lowerBound(keyframes, view.end + 1)
      ctx.strokeStyle = PALETTE.key
      ctx.beginPath()
      for (let i = from; i < to; i += 1) {
        const x = Math.round(toX(keyframes[i])) + 0.5
        ctx.moveTo(x, CANVAS_H - 9)
        ctx.lineTo(x, CANVAS_H - 3)
      }
      ctx.stroke()
    }

    // fragments
    for (const [index, segment] of segments.entries()) {
      const x1 = toX(segment.start)
      const x2 = toX(segment.end)
      if (x2 < -4 || x1 > width + 4) continue
      const left = Math.max(-1, x1)
      const right = Math.min(width + 1, x2)
      const w = Math.max(0.5, right - left)
      const selected = segment.id === selectedId

      ctx.fillStyle = segment.enabled ? (selected ? PALETTE.keepSel : PALETTE.keep) : PALETTE.cut
      ctx.fillRect(left, SEG_TOP, w, SEG_H)
      if (!segment.enabled && hatchRef.current) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, SEG_TOP, w, SEG_H)
        ctx.clip()
        ctx.fillStyle = hatchRef.current
        ctx.fillRect(left, SEG_TOP, w, SEG_H)
        ctx.restore()
      }

      ctx.strokeStyle = segment.enabled ? PALETTE.keepBorder : PALETTE.cutBorder
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeRect(left + 0.5, SEG_TOP + 0.5, Math.max(0.5, w - 1), SEG_H - 1)
      ctx.lineWidth = 1

      if (w > 58) {
        const label = segment.label || (segment.enabled ? `Part ${index + 1}` : 'cut out')
        ctx.save()
        ctx.beginPath()
        ctx.rect(left + 5, SEG_TOP, w - 10, SEG_H)
        ctx.clip()
        ctx.font = '10px "Inter", system-ui, sans-serif'
        ctx.fillStyle = segment.enabled ? (selected ? '#ffe3ba' : '#e3aa62') : '#b97a6d'
        ctx.fillText(label, left + 6, SEG_TOP + 12)
        ctx.fillStyle = segment.enabled ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.24)'
        ctx.font = '9px ui-monospace, monospace'
        ctx.fillText(shortTimecode(segment.end - segment.start), left + 6, SEG_TOP + 24)
        ctx.restore()
      }
    }

    // markers (every internal fragment boundary)
    for (let index = 0; index < segments.length - 1; index += 1) {
      const x = Math.round(toX(segments[index].end)) + 0.5
      if (x < -6 || x > width + 6) continue
      const active = selectedMarker === index
      ctx.strokeStyle = active ? PALETTE.markerSel : PALETTE.marker
      ctx.lineWidth = active ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, SEG_TOP - 5)
      ctx.lineTo(x, SEG_TOP + SEG_H + 3)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = active ? PALETTE.markerSel : PALETTE.marker
      ctx.beginPath()
      ctx.moveTo(x - 4, SEG_TOP - 5)
      ctx.lineTo(x + 4, SEG_TOP - 5)
      ctx.lineTo(x, SEG_TOP + 2)
      ctx.closePath()
      ctx.fill()
    }

    // pending range
    if (range && range.end - range.start > 0.001) {
      const x1 = toX(range.start)
      const x2 = toX(range.end)
      ctx.fillStyle = PALETTE.range
      ctx.fillRect(x1, RULER_H, x2 - x1, CANVAS_H - RULER_H)
      ctx.strokeStyle = '#5eb0ff'
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(x1 + 0.5, RULER_H)
      ctx.lineTo(x1 + 0.5, CANVAS_H)
      ctx.moveTo(x2 - 0.5, RULER_H)
      ctx.lineTo(x2 - 0.5, CANVAS_H)
      ctx.stroke()
      ctx.setLineDash([])
      if (x2 - x1 > 42) {
        ctx.fillStyle = '#9ccdff'
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(`${(range.end - range.start).toFixed(2)}s`, x1 + 6, RULER_H + 11)
      }
    }

    // playhead
    const px = Math.round(toX(playhead)) + 0.5
    if (px >= -2 && px <= width + 2) {
      ctx.strokeStyle = PALETTE.playhead
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, CANVAS_H)
      ctx.stroke()
      ctx.fillStyle = PALETTE.playhead
      ctx.beginPath()
      ctx.moveTo(px - 4, 0)
      ctx.lineTo(px + 4, 0)
      ctx.lineTo(px, 7)
      ctx.closePath()
      ctx.fill()
    }
  }, [width, view.start, view.end, span, segments, clips, accent, keyframes, waveform, playhead, selectedId, selectedMarker, range, duration, toX, toT])

  // ---- interaction -------------------------------------------------------
  const snapTime = useCallback(
    (time: number, minimum: number, maximum: number) => {
      let value = Math.max(minimum, Math.min(maximum, time))
      if (!snap) return value
      const tolerance = (9 / Math.max(1, width)) * span
      let best = value
      let bestDistance = tolerance
      const consider = (candidate: number) => {
        if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) return
        const distance = Math.abs(candidate - value)
        if (distance < bestDistance) {
          bestDistance = distance
          best = candidate
        }
      }
      consider(playhead)
      for (const segment of segments) {
        consider(segment.start)
        consider(segment.end)
      }
      const key = nearestValue(keyframes, value)
      if (key !== null) consider(key)
      return best
    },
    [snap, width, span, playhead, segments, keyframes],
  )

  const markerAt = useCallback(
    (x: number, y: number) => {
      if (y < SEG_TOP - 10 || y > SEG_TOP + SEG_H + 6) return null
      let best: number | null = null
      let distance = 7
      for (let index = 0; index < segments.length - 1; index += 1) {
        const gap = Math.abs(toX(segments[index].end) - x)
        if (gap < distance) {
          distance = gap
          best = index
        }
      }
      return best
    },
    [segments, toX],
  )

  const fragmentAt = useCallback(
    (x: number, y: number) => {
      if (y < SEG_TOP || y > SEG_TOP + SEG_H) return null
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]
        if (x >= toX(segment.start) - 1 && x <= toX(segment.end) + 1) return segment
      }
      return null
    },
    [segments, toX],
  )

  /** The recording whose band is under the pointer, if any. */
  const clipAtPoint = useCallback(
    (x: number, y: number) => {
      if (y < CLIP_TOP || y > CLIP_TOP + CLIP_H) return null
      return clips.find((clip) => x >= toX(clip.start) - 1 && x <= toX(clip.end) + 1) ?? null
    },
    [clips, toX],
  )

  /** Where a dropped clip would land: the recording under the pointer. */
  const clipIndexAt = useCallback(
    (x: number) => {
      if (!clips.length) return 0
      const found = clips.findIndex((clip) => x < toX(clip.end))
      return found < 0 ? clips.length - 1 : found
    },
    [clips, toX],
  )

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const { x, y } = localPoint(event)
    const time = Math.max(0, Math.min(duration || toT(width), toT(x)))
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic or already released pointer */
    }

    if (y <= RULER_H) {
      drag.current = { kind: 'scrub', hold: true }
      onScrubStart?.()
      onSeek(time)
      return
    }

    const band = clipAtPoint(x, y)
    if (band) {
      // The clip band is the recording order, so dragging it reorders the
      // project; the cut list is carried across by recording on the drop.
      drag.current = { kind: 'clip', path: band.path, index: band.index, toIndex: band.index }
      setClipDrag({ path: band.path, toIndex: band.index })
      return
    }

    const marker = markerAt(x, y)
    if (marker !== null) {
      drag.current = { kind: 'marker', index: marker }
      onSelectMarker(marker)
      onSelect(null)
      return
    }

    const fragment = fragmentAt(x, y)
    if (fragment) {
      onSelect(fragment.id)
      onSelectMarker(null)
      // Pressing on a fragment seeks, so dragging keeps seeking; the range
      // marquee stays on the empty lane below, where it cannot fight the cuts.
      drag.current = { kind: 'scrub', hold: false }
      onSeek(time)
      return
    }

    onSelect(null)
    onSelectMarker(null)
    drag.current = { kind: 'marquee', anchor: time }
    onRange({ start: time, end: time })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(event)
    const time = Math.max(0, Math.min(duration || toT(width), toT(x)))

    if (!drag.current) {
      const marker = markerAt(x, y)
      const fragment = marker === null ? fragmentAt(x, y) : null
      const band = marker === null && fragment === null ? clipAtPoint(x, y) : null
      setHover({ marker, fragment: fragment?.id ?? null, band: band?.path ?? null })
      return
    }

    const state = drag.current
    if (state.kind === 'clip') {
      const target = clipIndexAt(x)
      if (target !== state.toIndex) {
        state.toIndex = target
        setClipDrag({ path: state.path, toIndex: target })
      }
      return
    }
    if (state.kind === 'scrub') {
      if (!state.hold) {
        onSeek(time)
        return
      }
      scrubPending.current = time
      if (scrubFrame.current) return
      scrubFrame.current = window.requestAnimationFrame(() => {
        scrubFrame.current = 0
        const next = scrubPending.current
        scrubPending.current = null
        if (next !== null) onSeek(next)
      })
      return
    }
    if (state.kind === 'marquee') {
      onRange({ start: Math.min(state.anchor, time), end: Math.max(state.anchor, time) })
      return
    }
    if (state.kind === 'marker') {
      const left = segments[state.index]
      const right = segments[state.index + 1]
      if (!left || !right) return
      const minimum = 1 / Math.max(1, fps)
      const next = snapTime(time, left.start + minimum, right.end - minimum)
      onBoundary(state.index, Math.round(next / minimum) * minimum)
    }
  }

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = drag.current
    drag.current = null
    if (state?.kind === 'clip') {
      setClipDrag(null)
      if (state.toIndex !== state.index) onReorderClips(state.path, state.toIndex)
    }
    if (scrubFrame.current) {
      window.cancelAnimationFrame(scrubFrame.current)
      scrubFrame.current = 0
    }
    scrubPending.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    // A held ruler drag only moved the playhead; the picture lands here, at the
    // position the pointer was let go.
    if (state?.kind === 'scrub' && state.hold) {
      const { x } = localPoint(event)
      onScrubEnd?.()
      onSeek(Math.max(0, Math.min(duration || toT(width), toT(x))))
    }
    if (state?.kind === 'marker') onBoundaryCommit()
    if (state?.kind === 'marquee') {
      const { x } = localPoint(event)
      if (Math.abs(toT(x) - state.anchor) < span * 0.003) onRange(null)
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const anchorTime = view.start + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span
      const room = Math.max(0, (duration || span) - span)
      // Scrolling moves through the project, the way the scrollbar does. Zoom is
      // on Ctrl (or on a wheel when there is nowhere left to scroll).
      if (!event.ctrlKey && !event.metaKey && room > 1e-6) {
        const shift = ((event.deltaY + event.deltaX) / 400) * span
        if (shift) {
          const start = Math.max(0, Math.min(room, view.start + shift))
          if (Math.abs(start - view.start) > 1e-6) onView({ start, end: start + span })
          return
        }
      }
      const factor = event.deltaY > 0 || event.deltaX > 0 ? 1.3 : 0.77
      const nextSpan = Math.min(duration || span * 4, Math.max(0.2, span * factor))
      const ratio = (anchorTime - view.start) / span
      let start = anchorTime - nextSpan * ratio
      start = Math.max(0, Math.min(Math.max(0, (duration || nextSpan) - nextSpan), start))
      onView({ start, end: start + nextSpan })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [view.start, span, duration, onView])

  const cursor = hover.marker !== null ? 'ew-resize' : hover.band ? 'grab' : hover.fragment ? 'pointer' : 'crosshair'
  const dropClip = clipDrag ? clips.find((clip) => clip.index === clipDrag.toIndex) : null
  const dropX = Math.max(0, Math.min(width, dropClip ? toX(dropClip.start) : width))
  const cells = filmstrip.length
  // Each thumbnail sits where its frame actually is, which keeps the strip in
  // step when several recordings feed the same visible window.
  const share = 100 / Math.max(1, cells)

  return (
    <div className="timeline" ref={wrapRef}>
      {clipDrag && <div className="clip-drop" style={{ left: `${dropX}px` }} aria-hidden />}
      <div className="timeline-strip" style={{ height: STRIP_H }}>
        {filmstrip.map((frame, index) => (
          <img
            key={`${frame.time}-${index}`}
            src={frame.dataUrl}
            alt=""
            draggable={false}
            style={{
              left: `${((frame.time - view.start) / Math.max(0.001, span)) * 100}%`,
              width: `${share}%`,
            }}
          />
        ))}
        {cells === 0 && <div className="timeline-strip-empty" />}
      </div>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerLeave={() => setHover({ marker: null, fragment: null, band: null })}
      />
    </div>
  )
}
