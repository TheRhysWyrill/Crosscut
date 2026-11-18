import type { Job, QueueSnapshot, SyncReport } from '../types'
import { bytes, humanDuration, jobTime, percent } from '../format'

interface QueuePanelProps {
  queue: QueueSnapshot
  collapsed: boolean
  onToggle: () => void
  onStart: () => void
  onPause: () => void
  onCancelAll: () => void
  onClear: () => void
  onConcurrency: (value: number) => void
  onAction: (id: string, action: 'cancel' | 'retry' | 'remove') => void
  onShowLog: (id: string) => void
  onReveal: (path: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  /** Re-probe an output and report whether its audio still matches its video. */
  onVerify: (path: string) => void
  onResumeInterrupted: () => void
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
}

const TYPE_ICON: Record<string, string> = {
  cut: '✂',
  concat: '⇥',
  mux: '⧉',
  analyze: '⌁',
  proxy: '▷',
  verify: '✓',
  tool: '⚙',
}

function detailLine(job: Job): string {
  const detail = job.detail as { speed?: string; eta?: number; segment?: number; segments?: number }
  if (job.type === 'verify' && job.status === 'done') {
    const sync = (job.result as { sync?: SyncReport } | null)?.sync
    const bits = ['no decode errors']
    if (sync?.audioDuration) bits.push(sync.ok ? 'audio in sync' : `A/V off ${Math.abs(sync.deltaMs)} ms`)
    else bits.push('no audio track')
    return bits.join(' · ')
  }
  if (job.status === 'running') {
    const bits = [job.stage || 'Working']
    if (detail.segment && detail.segments) bits.push(`${detail.segment}/${detail.segments}`)
    if (detail.speed) bits.push(detail.speed)
    if (detail.eta && detail.eta > 1) bits.push(`${humanDuration(detail.eta)} left`)
    return bits.join(' · ')
  }
  if (job.status === 'done') {
    const size = job.outputs.reduce((sum, output) => sum + (output.size || 0), 0)
    const took = jobTime(job.startedAt, job.finishedAt)
    return `${job.outputs.length} file${job.outputs.length === 1 ? '' : 's'}${size ? ` · ${bytes(size)}` : ''}${took ? ` · took ${took}` : ''}`
  }
  if (job.status === 'error') return job.error.split('\n')[0].slice(0, 120)
  return job.stage || ''
}

export default function QueuePanel({
  queue,
  collapsed,
  onToggle,
  onStart,
  onPause,
  onCancelAll,
  onClear,
  onConcurrency,
  onAction,
  onShowLog,
  onReveal,
  onMove,
  onVerify,
  onResumeInterrupted,
}: QueuePanelProps) {
  const stats = queue.stats ?? {}
  const queued = stats.queued ?? 0
  const running = stats.running ?? 0
  const finished = (stats.done ?? 0) + (stats.error ?? 0) + (stats.canceled ?? 0)
  const activeJob = queue.jobs.find((job) => job.status === 'running')

  if (collapsed) {
    return (
      <button type="button" className="queue-collapsed" onClick={onToggle}>
        <span className="queue-collapsed-title">Queue</span>
        <span className="muted">
          {running ? `running ${percent(activeJob?.progress ?? 0)}` : queued ? `${queued} waiting` : 'idle'}
          {finished ? ` · ${finished} finished` : ''}
        </span>
        <span className="queue-collapsed-chevron">▴</span>
      </button>
    )
  }

  return (
    <section className="queue">
      <header className="queue-head">
        <div className="queue-title">
          <button type="button" className="icon-btn" onClick={onToggle} title="Collapse queue">
            ▾
          </button>
          <h3>Queue</h3>
          <span className={`badge ${running ? 'badge-live' : ''}`}>
            {running ? `${running} running` : queue.running ? 'starting' : 'idle'}
          </span>
          <span className="muted small">
            {queued} waiting · {finished} finished
          </span>
        </div>

        <div className="queue-actions">
          <div className="stepper" title="Parallel jobs">
            <button type="button" className="icon-btn" onClick={() => onConcurrency(Math.max(1, queue.concurrency - 1))}>
              −
            </button>
            <span>{queue.concurrency}</span>
            <button type="button" className="icon-btn" onClick={() => onConcurrency(Math.min(8, queue.concurrency + 1))}>
              +
            </button>
          </div>
          {queue.running ? (
            <button type="button" className="btn btn-sm" onClick={onPause}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={onStart} disabled={queued === 0}>
              Start
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelAll} disabled={queued + running === 0}>
            Cancel all
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClear} disabled={finished === 0}>
            Clear finished
          </button>
        </div>
      </header>

      {(stats.interrupted ?? 0) > 0 && (
        <div className="queue-resume">
          <span>
            {stats.interrupted} job{stats.interrupted === 1 ? ' was' : 's were'} interrupted when CrossCut closed
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={onResumeInterrupted}>
            Run {stats.interrupted === 1 ? 'it' : 'them'} again
          </button>
        </div>
      )}

      {queue.jobs.length === 0 ? (
        <div className="queue-empty">
          <p>Nothing queued.</p>
          <p className="muted">Add exports from the Export panel — several cuts, several sources, all processed in order.</p>
        </div>
      ) : (
        <div className="queue-list">
          {queue.jobs.map((job) => (
            <div key={job.id} className={`queue-row status-${job.status}`}>
              <span className="queue-type" title={job.type}>
                {TYPE_ICON[job.type] ?? '•'}
              </span>
              <div className="queue-main">
                <div className="queue-row-top">
                  <span className="queue-label">{job.label}</span>
                  <span className={`status-pill status-${job.status}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
                </div>
                <div className="queue-progress">
                  <div className="queue-progress-fill" style={{ width: `${job.status === 'done' ? 100 : job.progress}%` }} />
                </div>
                <div className="queue-detail muted small">
                  {detailLine(job)}
                  {job.status === 'done' && job.outputs.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onReveal(job.outputs[job.outputs.length - 1].path)}
                      >
                        reveal
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        title="Decode the whole output and compare the video and audio durations"
                        onClick={() => onVerify(job.outputs[job.outputs.length - 1].path)}
                      >
                        verify
                      </button>
                    </>
                  )}
                  {job.status === 'done' &&
                    job.outputs.some((output) => output.sync && output.sync.ok === false) && (
                      <span className="queue-warn" title="The audio and video tracks in this file are a different length">
                        A/V drift{' '}
                        {Math.max(
                          ...job.outputs
                            .filter((output) => output.sync && output.sync.ok === false)
                            .map((output) => Math.abs(output.sync?.deltaMs ?? 0)),
                        )}{' '}
                        ms
                      </span>
                    )}
                </div>
              </div>
              <div className="queue-row-actions">
                {(job.status === 'queued' || job.status === 'interrupted') && (
                  <>
                    <button type="button" className="icon-btn" title="Move up" onClick={() => onMove(job.id, -1)}>
                      ▴
                    </button>
                    <button type="button" className="icon-btn" title="Move down" onClick={() => onMove(job.id, 1)}>
                      ▾
                    </button>
                  </>
                )}
                {job.status === 'running' || job.status === 'queued' ? (
                  <button type="button" className="icon-btn" title="Cancel" onClick={() => onAction(job.id, 'cancel')}>
                    ■
                  </button>
                ) : (
                  <button type="button" className="icon-btn" title="Run again" onClick={() => onAction(job.id, 'retry')}>
                    ↻
                  </button>
                )}
                <button type="button" className="icon-btn" title="Log" onClick={() => onShowLog(job.id)}>
                  ≡
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove"
                  onClick={() => onAction(job.id, 'remove')}
                  disabled={job.status === 'running'}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
