import { useMemo, useState } from 'react'
import type { AnalyzeResult, Job, MediaInfo } from '../types'
import { shortTimecode } from '../format'

interface AnalyzePanelProps {
  info: MediaInfo | null
  job: Job | null
  onRun: (params: Record<string, unknown>) => Promise<void>
  onApplySegments: (segments: { start: number; end: number; label: string }[]) => void
  onShowLog: (id: string) => void
  onError: (message: string) => void
}

type Kind = 'silence' | 'black' | 'scene'

const KINDS: { id: Kind; label: string; blurb: string }[] = [
  { id: 'silence', label: 'Silence', blurb: 'Find quiet stretches — good for trimming dead air and cutting breaks.' },
  { id: 'black', label: 'Black frames', blurb: 'Find black spans, usually ad breaks or scene separators.' },
  { id: 'scene', label: 'Scene changes', blurb: 'Find hard cuts so you can split a long recording into chapters.' },
]

function complement(spans: { start: number; end: number }[], duration: number) {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const kept: { start: number; end: number; label: string }[] = []
  let cursor = 0
  let index = 1
  for (const span of sorted) {
    if (span.start - cursor > 0.2) kept.push({ start: cursor, end: span.start, label: `Keep ${index}` })
    cursor = Math.max(cursor, span.end)
    index += 1
  }
  if (duration - cursor > 0.2) kept.push({ start: cursor, end: duration, label: `Keep ${index}` })
  return kept
}

export default function AnalyzePanel({ info, job, onRun, onApplySegments, onShowLog, onError }: AnalyzePanelProps) {
  const [kind, setKind] = useState<Kind>('silence')
  const [noiseDb, setNoiseDb] = useState(-35)
  const [minDuration, setMinDuration] = useState(1.5)
  const [threshold, setThreshold] = useState(0.35)
  const [busy, setBusy] = useState(false)

  const running = job?.status === 'running' || job?.status === 'queued'
  const result = (job?.status === 'done' ? (job.result as unknown as AnalyzeResult | null) : null) ?? null
  const activeKind = KINDS.find((entry) => entry.id === kind) ?? KINDS[0]

  const counts = useMemo(() => {
    if (!result) return null
    if (result.silences) return { silence: result.silences.length, speech: result.speech?.length ?? 0 }
    if (result.black) return { black: result.black.length }
    if (result.scenes) return { scenes: result.scenes.length }
    return null
  }, [result])

  const run = async () => {
    if (!info) {
      onError('Open a clip first')
      return
    }
    setBusy(true)
    try {
      await onRun({
        source: info.path,
        kind,
        noiseDb,
        minDuration,
        threshold,
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!info) {
    return (
      <div className="panel-empty">
        <p>Open a clip to analyse it.</p>
      </div>
    )
  }

  return (
    <div className="panel analyze-panel">
      <section className="block">
        <h3>Detect</h3>
        <div className="mode-switch">
          {KINDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`mode-btn ${kind === entry.id ? 'active' : ''}`}
              onClick={() => setKind(entry.id)}
            >
              <span className="mode-label">{entry.label}</span>
              <span className="mode-blurb">{entry.blurb}</span>
            </button>
          ))}
        </div>

        {kind === 'silence' && (
          <div className="field-row">
            <label className="field">
              <span>Noise floor</span>
              <select className="select" value={noiseDb} onChange={(event) => setNoiseDb(Number(event.target.value))}>
                {[-25, -30, -35, -40, -45, -50].map((value) => (
                  <option key={value} value={value}>
                    {value} dB
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Minimum length</span>
              <select className="select" value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))}>
                {[0.5, 1, 1.5, 2, 3, 5, 10, 30, 60].map((value) => (
                  <option key={value} value={value}>
                    {value}s
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {kind === 'black' && (
          <label className="field">
            <span>Minimum length</span>
            <select className="select" value={minDuration} onChange={(event) => setMinDuration(Number(event.target.value))}>
              {[0.2, 0.5, 1, 2, 5].map((value) => (
                <option key={value} value={value}>
                  {value}s
                </option>
              ))}
            </select>
          </label>
        )}

        {kind === 'scene' && (
          <label className="field">
            <span>
              Sensitivity <span className="mono muted">{threshold.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={0.8}
              step={0.05}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
            <span className="hint">Lower finds more cuts.</span>
          </label>
        )}

        <button type="button" className="btn btn-primary" onClick={run} disabled={busy || running}>
          {running ? `Analysing… ${Math.round(job?.progress ?? 0)}%` : busy ? 'Starting…' : `Analyse ${activeKind.label.toLowerCase()}`}
        </button>
        {job?.status === 'error' && <p className="error-text">{job.error}</p>}
      </section>

      {result && counts && (
        <section className="block">
          <div className="block-head">
            <h3>Results</h3>
            <button type="button" className="btn btn-xs btn-ghost" onClick={() => onShowLog(job!.id)}>
              Log
            </button>
          </div>

          <div className="stat-row">
            {result.silences && (
              <>
                <div className="stat">
                  <strong>{result.silences.length}</strong>
                  <span>silences</span>
                </div>
                <div className="stat">
                  <strong>{result.speech?.length ?? 0}</strong>
                  <span>speech blocks</span>
                </div>
              </>
            )}
            {result.black && (
              <div className="stat">
                <strong>{result.black.length}</strong>
                <span>black spans</span>
              </div>
            )}
            {result.scenes && (
              <div className="stat">
                <strong>{result.scenes.length}</strong>
                <span>scene cuts</span>
              </div>
            )}
          </div>

          {result.silences && result.speech && result.speech.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-block"
                onClick={() =>
                  onApplySegments(result.speech!.map((block, index) => ({ start: block.start, end: block.end, label: `Keep ${index + 1}` })))
                }
              >
                Keep speech only (drop every silence)
              </button>
              <button
                type="button"
                className="btn btn-block"
                onClick={() => {
                  const first = result.speech![0].start
                  const last = result.speech![result.speech!.length - 1].end
                  onApplySegments([{ start: first, end: last, label: 'Trimmed' }])
                }}
              >
                Trim head and tail only
              </button>
              <button
                type="button"
                className="btn btn-block btn-ghost"
                onClick={() =>
                  onApplySegments(result.silences!.map((span, index) => ({ start: span.start, end: span.end, label: `Silence ${index + 1}` })))
                }
              >
                Mark silences as cuts instead
              </button>
              <p className="hint">
                First speech starts at {shortTimecode(result.speech![0].start)}, last ends at{' '}
                {shortTimecode(result.speech![result.speech!.length - 1].end)}. Segments replace the current cut list.
              </p>
            </>
          )}

          {result.black && result.black.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-block"
                onClick={() => onApplySegments(complement(result.black!, result.duration))}
              >
                Remove black spans
              </button>
              <button
                type="button"
                className="btn btn-block btn-ghost"
                onClick={() =>
                  onApplySegments(result.black!.map((span, index) => ({ start: span.start, end: span.end, label: `Black ${index + 1}` })))
                }
              >
                Mark black spans as cuts
              </button>
            </>
          )}

          {result.scenes && result.scenes.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-block"
                onClick={() => {
                  const points = [0, ...result.scenes!, result.duration]
                  const segments = []
                  for (let index = 0; index < points.length - 1; index += 1) {
                    segments.push({
                      start: points[index],
                      end: points[index + 1],
                      label: `Chapter ${index + 1}`,
                    })
                  }
                  onApplySegments(segments)
                }}
              >
                Split into {result.scenes.length + 1} chapters
              </button>
              <p className="hint">Chapters become separate cuts you can export in one batch.</p>
            </>
          )}
        </section>
      )}
    </div>
  )
}
