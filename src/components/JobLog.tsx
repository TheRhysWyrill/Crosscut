import { useEffect, useRef } from 'react'
import type { Job } from '../types'
import { bytes, jobTime, shortTimecode } from '../format'
import { revealPath } from '../desktop'

interface JobLogProps {
  job: Job | null
  onClose: () => void
}

export default function JobLog({ job, onClose }: JobLogProps) {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [job?.log.length, job?.id])

  if (!job) return null

  const sync = job.outputs.find((output) => output.sync)?.sync

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{job.label}</h2>
            <p className="muted small">
              {job.type} · {job.status}
              {job.status === 'running'
                ? ` · ${job.progress.toFixed(0)}%`
                : jobTime(job.startedAt, job.finishedAt)
                  ? ` · took ${jobTime(job.startedAt, job.finishedAt)}`
                  : ''}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {job.outputs.length > 0 && (
            <section className="field-group">
              <h3>Output</h3>
              <ul className="output-list">
                {job.outputs.map((output) => (
                  <li key={output.path}>
                    <div className="output-path mono">{output.path}</div>
                    <div className="muted small">
                      {bytes(output.size)}
                      {output.duration ? ` · ${shortTimecode(output.duration)}` : ''}
                    </div>
                    <button type="button" className="btn btn-xs" onClick={() => revealPath(output.path)}>
                      Show in folder
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sync && (
            <section className="field-group">
              <h3>Sync check</h3>
              <div className={`sync-readout ${sync.ok ? 'ok' : 'warn'}`}>
                <div>
                  <span className="muted small">Video</span>
                  <strong>{sync.videoDuration.toFixed(3)}s</strong>
                </div>
                <div>
                  <span className="muted small">Audio</span>
                  <strong>{sync.audioDuration.toFixed(3)}s</strong>
                </div>
                <div>
                  <span className="muted small">Drift</span>
                  <strong>{sync.deltaMs} ms</strong>
                </div>
              </div>
              <p className="muted small">
                {sync.ok
                  ? 'Audio and video line up within 150 ms.'
                  : 'Audio and video lengths differ. Use the Sync tab to repair the file without re-encoding video.'}
              </p>
            </section>
          )}

          {job.error && <pre className="error-box">{job.error}</pre>}

          <section className="field-group">
            <h3>FFmpeg log</h3>
            <div className="log" ref={logRef}>
              {job.log.length === 0 ? <span className="muted">No output yet.</span> : job.log.map((line, index) => <div key={index}>{line}</div>)}
            </div>
          </section>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
