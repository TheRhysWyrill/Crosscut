import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Segment } from '../types'
import { shortTimecode } from '../format'
import type { TimelineView } from './Timeline'

interface TimelineScrollbarProps {
  duration: number
  fps: number
  view: TimelineView
  segments: Segment[]
  playhead: number
  onView: (view: TimelineView) => void
  onSeek: (time: number) => void
  /** The playhead is being dragged, so the preview should wait for the release. */
  onScrubStart?: () => void
  onScrubEnd?: () => void
}

/**
 * The whole project as a rail: kept fragments amber, cut fragments red, with a
 * thumb for the visible window. Pressing it jumps there; holding and dragging
 * scrubs the playhead along, so the picture only settles where it is let go.
 * It also takes focus, so the playhead can be moved without a mouse.
 */
export default function TimelineScrollbar({
  duration,
  fps,
  view,
  segments,
  playhead,
  onView,
  onSeek,
  onScrubStart,
  onScrubEnd,
}: TimelineScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const frameRef = useRef(0)
  const pendingRef = useRef<number | null>(null)

  const span = Math.max(0.0005, view.end - view.start)
  const total = Math.max(duration, span, 0.001)
  const room = Math.max(0, total - span)
  const pannable = room > 1e-6

  const thumbLeft = Math.min(100, Math.max(0, (view.start / total) * 100))
  const thumbWidth = Math.max(1.5, Math.min(100 - thumbLeft, (span / total) * 100))

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return 0
      const ratio = (clientX - rect.left) / Math.max(1, rect.width)
      return Math.max(0, Math.min(1, ratio)) * total
    },
    [total],
  )

  const panTo = useCallback(
    (start: number) => {
      const clamped = Math.max(0, Math.min(room, start))
      if (Math.abs(clamped - view.start) < 1e-6) return
      onView({ start: clamped, end: clamped + span })
    },
    [onView, room, span, view.start],
  )

  // One pointer position drives both the playhead and the visible window, so a
  // drag across the rail keeps the picture under the pointer instead of
  // leaving it behind off screen.
  const scrub = useCallback(
    (clientX: number) => {
      const time = timeAt(clientX)
      onSeek(time)
      if (pannable) panTo(time - span / 2)
    },
    [timeAt, onSeek, pannable, panTo, span],
  )

  // Pointer moves come faster than the screen redraws. Coalescing them into one
  // update per frame keeps the playhead gliding instead of queueing work.
  const schedule = useCallback(
    (clientX: number) => {
      pendingRef.current = clientX
      if (frameRef.current) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = 0
        const x = pendingRef.current
        pendingRef.current = null
        if (x !== null) scrub(x)
      })
    },
    [scrub],
  )

  const cancelPending = useCallback(() => {
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    pendingRef.current = null
  }, [])

  useEffect(() => cancelPending, [cancelPending])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointer */
    }
    draggingRef.current = true
    setDragging(true)
    onScrubStart?.()
    scrub(event.clientX)
  }

  const dragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    schedule(event.clientX)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    cancelPending()
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    // The picture catches up here, at the place the pointer was let go.
    onScrubEnd?.()
    if (commit) scrub(event.clientX)
  }

  /** Arrow keys step a frame, Shift a second, Page a screen, Home and End the ends. */
  const keySeek = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const frame = 1 / Math.max(1, fps || 25)
    const step = event.shiftKey ? 1 : frame
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = playhead - step
    else if (event.key === 'ArrowRight') next = playhead + step
    else if (event.key === 'PageUp') next = playhead - span * 0.9
    else if (event.key === 'PageDown') next = playhead + span * 0.9
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = total
    if (next === null) return
    // The window-level shortcut handler also listens for arrows, so a focused
    // rail owns the key rather than stepping the playhead twice.
    event.preventDefault()
    event.stopPropagation()
    const time = Math.max(0, Math.min(total, next))
    onSeek(time)
    if (pannable) panTo(time - span / 2)
  }

  return (
    <div className="railbar">
      <button
        type="button"
        className="rail-page"
        onClick={() => panTo(view.start - span * 0.9)}
        disabled={!pannable || view.start <= 1e-6}
        title="Back one screen (Alt+←)"
      >
        ‹
      </button>
      <div
        className="rail-track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Project position"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(total * 1000) / 1000}
        aria-valuenow={Math.round(playhead * 1000) / 1000}
        aria-valuetext={shortTimecode(playhead)}
        onKeyDown={keySeek}
        onPointerDown={startDrag}
        onPointerMove={dragMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        title="Click or drag to scrub through the project · arrow keys step, Shift for a second"
      >
        {segments.map((segment) => (
          <div
            key={segment.id}
            className={`rail-seg ${segment.enabled ? 'kept' : 'cut'}`}
            style={{
              left: `${(segment.start / total) * 100}%`,
              width: `${Math.max(0.1, ((segment.end - segment.start) / total) * 100)}%`,
            }}
          />
        ))}
        {duration > 0 && (
          <div className="rail-playhead" style={{ left: `${Math.min(100, (playhead / total) * 100)}%` }} />
        )}
        <div
          className={`rail-thumb${dragging ? ' dragging' : ''}${pannable ? '' : ' full'}`}
          style={{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }}
        />
      </div>
      <button
        type="button"
        className="rail-page"
        onClick={() => panTo(view.start + span * 0.9)}
        disabled={!pannable || view.start >= room - 1e-6}
        title="Forward one screen (Alt+→)"
      >
        ›
      </button>
    </div>
  )
}
