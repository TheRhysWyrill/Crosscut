import { useEffect, useRef, useState } from 'react'
import { describeTrack } from '../batch'
import type { AudioTrack } from '../types'

interface TrackPickerProps {
  tracks: AudioTrack[]
  value: number
  onChange: (index: number) => void
  /** Smaller button for the clip rail. */
  compact?: boolean
}

/** The track list without the leading "track 2 · ", which the number badge shows. */
function detail(track: AudioTrack, position: number): string {
  return describeTrack(track, position).replace(/^track \d+ · /, '')
}

/**
 * One recording's audio track, behind a microphone button. A select showing
 * every track is too wide for the clip rail, where it was cut down to a single
 * letter, so the choice opens as a menu instead.
 */
export default function TrackPicker({ tracks, value, onChange, compact = false }: TrackPickerProps) {
  const [open, setOpen] = useState(false)
  const [spot, setSpot] = useState<{ left: number; top: number; width: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const position = Math.max(0, tracks.findIndex((track) => track.index === value))
  const current = tracks[position]

  // Fixed coordinates, because the rail scrolls and would clip a menu anchored
  // inside it. It opens downwards, or upwards when it is near the bottom edge.
  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 252
    const height = Math.min(260, tracks.length * 34 + 12)
    const below = window.innerHeight - rect.bottom
    setSpot({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
      top: below > height + 16 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
      width,
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Captured first so Escape closes the menu instead of a dialog behind it.
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  if (!tracks.length) return null
  const label = `Audio track ${position + 1} of ${tracks.length} — ${detail(current, position)}`

  return (
    <div className={compact ? 'track-picker compact' : 'track-picker'}>
      <button
        ref={buttonRef}
        type="button"
        className="track-btn"
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          if (open) setOpen(false)
          else show()
        }}
      >
        <span className="track-btn-icon" aria-hidden>
          🎙
        </span>
        <span className="track-btn-num" aria-hidden>
          {position + 1}
        </span>
      </button>
      {open && spot && (
        <div
          ref={menuRef}
          className="track-menu"
          role="listbox"
          aria-label="Audio track"
          style={{ left: spot.left, top: spot.top, width: spot.width }}
        >
          {tracks.map((track, index) => (
            <button
              key={track.index}
              type="button"
              role="option"
              aria-selected={track.index === value}
              className={track.index === value ? 'track-option active' : 'track-option'}
              onClick={() => {
                onChange(track.index)
                setOpen(false)
              }}
            >
              <span className="track-option-num">{index + 1}</span>
              <span className="track-option-text">{detail(track, index)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
