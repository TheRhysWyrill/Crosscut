import { useRef, useState } from 'react'
import { parseTimecode, timecode } from '../format'

interface TimecodeFieldProps {
  value: number
  fps: number
  duration: number
  onSeek: (time: number) => void
}

/**
 * The playhead readout doubles as an input: type a time and press Enter to jump
 * there. Accepts HH:MM:SS:FF, HH:MM:SS, MM:SS or plain seconds.
 */
export default function TimecodeField({ value, fps, duration, onSeek }: TimecodeFieldProps) {
  const [text, setText] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef(false)

  // Typed text only wins while the field actually has focus; otherwise the
  // readout always follows the playhead, so a draft can never freeze it.
  const focused = inputRef.current !== null && inputRef.current === document.activeElement
  const shown = focused && text !== null ? text : timecode(value, fps)

  const commit = (raw: string) => {
    const seconds = parseTimecode(raw, fps)
    onSeek(Math.max(0, Math.min(duration || seconds, seconds)))
    setText(null)
  }

  return (
    <input
      ref={inputRef}
      className="timecode-input"
      value={shown}
      disabled={!(duration > 0)}
      title="Type a timecode and press Enter to jump there (HH:MM:SS:FF, MM:SS or seconds)"
      spellCheck={false}
      aria-label="Playhead timecode"
      onFocus={(event) => {
        setText(timecode(value, fps))
        event.currentTarget.select()
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={(event) => {
        if (cancelRef.current) {
          cancelRef.current = false
          setText(null)
          return
        }
        if (text !== null) commit(event.target.value)
        else setText(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          inputRef.current?.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancelRef.current = true
          inputRef.current?.blur()
        }
      }}
    />
  )
}
