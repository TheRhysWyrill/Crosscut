import { useState } from 'react'
import type { AudioTrack, Segment } from '../types'
import { describeTrack } from '../batch'
import { parseTimecode, shortTimecode, timecode } from '../format'
import { keptDuration, markerTimes } from '../project'

interface ProjectPanelProps {
  segments: Segment[]
  duration: number
  fps: number
  selectedId: string | null
  selectedMarker: number | null
  range: { start: number; end: number } | null
  canUndo: boolean
  canRedo: boolean
  onSplit: () => void
  onCutOut: () => void
  onKeep: () => void
  onCutPrevious: () => void
  onInvert: () => void
  onClearMarkers: () => void
  onDeleteMarker: () => void
  onTrimBefore: () => void
  onTrimAfter: () => void
  onCutRange: () => void
  onDivide: (parts: number) => void
  onReset: () => void
  onUndo: () => void
  onRedo: () => void
  onToggle: (id: string) => void
  onRename: (id: string, label: string) => void
  /** Audio tracks available to this project, for per-fragment overrides. */
  audioTracks: AudioTrack[]
  onAudio: (id: string, value: string) => void
  onBoundary: (index: number, time: number) => void
  onSelect: (id: string | null) => void
  onSelectMarker: (index: number | null) => void
  onSeek: (time: number) => void
}

function MarkerInput({
  value,
  fps,
  disabled,
  title,
  onCommit,
}: {
  value: number
  fps: number
  disabled: boolean
  title: string
  onCommit: (seconds: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      className="tc-input"
      value={text ?? timecode(value, fps)}
      disabled={disabled}
      title={title}
      placeholder="0:00:00:00"
      onClick={(event) => event.stopPropagation()}
      onFocus={() => setText(timecode(value, fps))}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== null) onCommit(parseTimecode(text, fps))
        setText(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape') {
          setText(null)
          ;(event.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export default function ProjectPanel({
  segments,
  duration,
  fps,
  selectedId,
  selectedMarker,
  range,
  canUndo,
  canRedo,
  onSplit,
  onCutOut,
  onKeep,
  onCutPrevious,
  onInvert,
  onClearMarkers,
  onDeleteMarker,
  onTrimBefore,
  onTrimAfter,
  onCutRange,
  onDivide,
  onReset,
  onUndo,
  onRedo,
  onToggle,
  onRename,
  audioTracks,
  onAudio,
  onBoundary,
  onSelect,
  onSelectMarker,
  onSeek,
}: ProjectPanelProps) {
  const [parts, setParts] = useState(4)
  const markers = markerTimes(segments)
  const kept = keptDuration(segments)
  const selected = segments.find((segment) => segment.id === selectedId) ?? null
  const selectedIndex = segments.findIndex((segment) => segment.id === selectedId)

  return (
    <div className="panel project-panel">
      <section className="block">
        <div className="project-head">
          <div>
            <h3>Cuts</h3>
            <p className="muted small">
              {segments.length} fragment{segments.length === 1 ? '' : 's'} · {markers.length} marker
              {markers.length === 1 ? '' : 's'} · keeps {timecode(kept, fps)} of {timecode(duration, fps)}
            </p>
          </div>
          <div className="project-history">
            <button type="button" className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
              ↶
            </button>
            <button type="button" className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
              ↷
            </button>
          </div>
        </div>

        <div className="project-primary">
          <button type="button" className="btn btn-primary btn-sm" onClick={onSplit} title="Add a marker at the playhead (M)">
            Add marker <kbd>M</kbd>
          </button>
          <button type="button" className="btn btn-sm" onClick={onCutOut} disabled={!selected} title="Cut out the selected fragment (D)">
            Cut out <kbd>D</kbd>
          </button>
          <button type="button" className="btn btn-sm" onClick={onKeep} disabled={!selected} title="Keep the selected fragment (S)">
            Keep <kbd>S</kbd>
          </button>
        </div>

        <div className="project-tools">
          <button type="button" className="btn btn-ghost btn-xs" onClick={onCutPrevious} disabled={selectedIndex <= 0} title="Cut out the previous fragment (F)">
            Cut previous
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onInvert} title="Keep what is cut, cut what is kept (I)">
            Invert <kbd>I</kbd>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={onDeleteMarker}
            disabled={selectedMarker === null}
            title="Delete the selected marker, joining the two fragments (Delete)"
          >
            Delete marker
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onClearMarkers} disabled={!markers.length} title="Remove every marker (Ctrl+C)">
            Clear markers
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onReset} title="Back to one fragment covering the whole clip">
            Reset
          </button>
        </div>
      </section>

      <section className="block">
        <h3>Trim</h3>
        <div className="project-tools">
          <button type="button" className="btn btn-ghost btn-xs" onClick={onTrimBefore} title="Cut everything before the playhead">
            Trim start
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onTrimAfter} title="Cut everything after the playhead">
            Trim end
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={onCutRange} disabled={!range} title="Cut out the highlighted range">
            Cut range
          </button>
        </div>
        <div className="row">
          <span className="muted small">Divide into</span>
          <input
            className="text-input short"
            type="number"
            min={2}
            max={200}
            value={parts}
            onChange={(event) => setParts(Math.max(2, Math.min(200, Number(event.target.value) || 2)))}
          />
          <button type="button" className="btn btn-xs" onClick={() => onDivide(parts)} title="Place markers so the clip becomes N equal fragments">
            equal parts
          </button>
        </div>
        <p className="hint">Dividing places markers; export “Separate files” to write those parts out.</p>
      </section>

      <section className="block">
        <h3>Fragments</h3>
        {segments.length === 0 ? (
          <p className="hint">Open a clip to start.</p>
        ) : (
          <ul className="fragment-list">
            {segments.map((segment, index) => {
              const isFirst = index === 0
              const isLast = index === segments.length - 1
              return (
                <li
                  key={segment.id}
                  className={`fragment-row ${segment.enabled ? 'kept' : 'cut'} ${segment.id === selectedId ? 'selected' : ''}`}
                  onClick={() => {
                    onSelect(segment.id)
                    onSelectMarker(null)
                    onSeek(segment.start)
                  }}
                >
                  <span className="fragment-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="fragment-main">
                    <div className="fragment-top">
                      <span className={`fragment-badge ${segment.enabled ? 'kept' : 'cut'}`}>
                        {segment.enabled ? 'kept' : 'cut out'}
                      </span>
                      <input
                        className="cut-label"
                        value={segment.label}
                        placeholder={segment.enabled ? `Part ${index + 1}` : 'fragment'}
                        onChange={(event) => onRename(segment.id, event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <span className="cut-duration">{shortTimecode(segment.end - segment.start)}</span>
                    </div>
                    <div className="fragment-times">
                      <MarkerInput
                        value={segment.start}
                        fps={fps}
                        disabled={isFirst}
                        title={isFirst ? 'The clip starts here' : 'Moves this marker'}
                        onCommit={(seconds) => onBoundary(index - 1, seconds)}
                      />
                      <span className="arrow">→</span>
                      <MarkerInput
                        value={segment.end}
                        fps={fps}
                        disabled={isLast}
                        title={isLast ? 'The clip ends here' : 'Moves this marker'}
                        onCommit={(seconds) => onBoundary(index, seconds)}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title={segment.enabled ? 'Cut this fragment out' : 'Keep this fragment'}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggle(segment.id)
                        }}
                      >
                        {segment.enabled ? '✕' : '✓'}
                      </button>
                    </div>
                    {audioTracks.length > 1 && segment.enabled && (
                      <div className="fragment-audio">
                        <select
                          className="select select-xs"
                          value={segment.audio ?? ''}
                          title="Audio track for this fragment only"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            event.stopPropagation()
                            onAudio(segment.id, event.target.value)
                          }}
                        >
                          <option value="">Audio: same as the export</option>
                          {audioTracks.map((track, position) => (
                            <option key={track.index} value={`track:${track.index}`}>
                              Audio: {describeTrack(track, position)}
                            </option>
                          ))}
                        </select>
                        {segment.audio && (
                          <span className="muted small">this fragment re-encodes to switch track</span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
