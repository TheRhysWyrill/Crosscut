import { useState } from 'react'
import { api } from '../api'
import type { AppSettings, JobInput, MediaInfo } from '../types'
import { baseName, shortTimecode } from '../format'
import { pickDirectory, pickMedia } from '../desktop'

interface SyncPanelProps {
  info: MediaInfo | null
  settings: AppSettings
  onQueue: (jobs: JobInput[], startNow: boolean) => Promise<void>
  onError: (message: string) => void
}

type MuxMode = 'copy' | 'stretch' | 'trim'

interface Comparison {
  video: { path: string; duration: number }
  audio: { path: string; duration: number; codec: string; channels: number }
  driftSeconds: number
  driftMs: number
  ppm: number
  suggestedRatio: number
  suggestion: string
}

export default function SyncPanel({ info, settings, onQueue, onError }: SyncPanelProps) {
  const [video, setVideo] = useState(info?.path ?? '')
  const [audio, setAudio] = useState('')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [mode, setMode] = useState<MuxMode>('copy')
  const [offset, setOffset] = useState(0)
  const [ratio, setRatio] = useState(1)
  const [keepOriginal, setKeepOriginal] = useState(false)
  const [container, setContainer] = useState('mkv')
  const [name, setName] = useState(info ? `${baseName(info.path)} synced` : 'merged')
  const [outDir, setOutDir] = useState(settings.outDir)
  const [busy, setBusy] = useState(false)

  const compare = async () => {
    if (!video || !audio) {
      onError('Pick both a video and an audio file')
      return
    }
    setBusy(true)
    try {
      const result = await api.compareSync(video, audio)
      setComparison(result)
      setRatio(Number(result.suggestedRatio.toFixed(8)))
      if (Math.abs(result.driftSeconds) > 0.05) setMode('stretch')
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const queue = async () => {
    if (!video || !audio) {
      onError('Pick both a video and an audio file')
      return
    }
    setBusy(true)
    try {
      const job: JobInput = {
        type: 'mux',
        label: `${baseName(video)} · merge audio`,
        params: {
          video,
          audio,
          sync: mode,
          offset,
          ratio,
          keepOriginalAudio: keepOriginal,
          container,
          name,
          outDir,
          audioBitrate: 320,
        },
      }
      await onQueue([job], true)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel sync-panel">
      <section className="block">
        <h3>Sources</h3>
        <p className="hint">
          Merge a video from one export with audio from anywhere else. The video is always stream-copied, so only the audio is
          ever re-encoded.
        </p>

        <label className="field">
          <span>Video</span>
          <div className="row">
            <input className="text-input" value={video} onChange={(event) => setVideo(event.target.value)} placeholder="Video file" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const [picked] = await pickMedia(false, 'Select the video')
                if (picked) setVideo(picked)
              }}
            >
              Browse
            </button>
          </div>
        </label>

        <label className="field">
          <span>Audio</span>
          <div className="row">
            <input className="text-input" value={audio} onChange={(event) => setAudio(event.target.value)} placeholder="Audio file" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const [picked] = await pickMedia(false, 'Select the audio')
                if (picked) {
                  setAudio(picked)
                  setName(`${baseName(video || picked)} synced`)
                }
              }}
            >
              Browse
            </button>
          </div>
        </label>

        <div className="row">
          <button type="button" className="btn btn-sm" onClick={compare} disabled={busy}>
            {busy ? 'Checking…' : 'Check drift'}
          </button>
          {info && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setVideo(info.path)}>
              Use current clip as video
            </button>
          )}
        </div>

        {comparison && (
          <div className="drift-card">
            <div className="drift-grid">
              <div>
                <span className="muted small">Video</span>
                <strong>{shortTimecode(comparison.video.duration)}</strong>
              </div>
              <div>
                <span className="muted small">Audio</span>
                <strong>{shortTimecode(comparison.audio.duration)}</strong>
              </div>
              <div>
                <span className="muted small">Drift</span>
                <strong className={Math.abs(comparison.driftMs) > 50 ? 'warn-text' : 'ok-text'}>
                  {comparison.driftMs > 0 ? '+' : ''}
                  {comparison.driftMs} ms
                </strong>
              </div>
              <div>
                <span className="muted small">Rate</span>
                <strong>
                  {comparison.driftMs === 0 ? '1.000000' : comparison.suggestedRatio.toFixed(6)}×
                </strong>
              </div>
            </div>
            <p className="hint">{comparison.suggestion}</p>
          </div>
        )}
      </section>

      <section className="block">
        <h3>How to line them up</h3>
        <div className="mode-switch">
          <button type="button" className={`mode-btn ${mode === 'copy' ? 'active' : ''}`} onClick={() => setMode('copy')}>
            <span className="mode-label">Straight copy</span>
            <span className="mode-blurb">Audio is copied untouched. Best when the lengths already match.</span>
          </button>
          <button type="button" className={`mode-btn ${mode === 'stretch' ? 'active' : ''}`} onClick={() => setMode('stretch')}>
            <span className="mode-label">Stretch audio</span>
            <span className="mode-blurb">Resamples audio by a tiny ratio so long recordings stay in sync end to end.</span>
          </button>
          <button type="button" className={`mode-btn ${mode === 'trim' ? 'active' : ''}`} onClick={() => setMode('trim')}>
            <span className="mode-label">Trim to video</span>
            <span className="mode-blurb">Cuts the audio tail at the last video frame.</span>
          </button>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Audio offset (seconds)</span>
            <input
              type="number"
              step="0.001"
              className="text-input"
              value={offset}
              onChange={(event) => setOffset(Number(event.target.value) || 0)}
            />
          </label>
          {mode === 'stretch' && (
            <label className="field">
              <span>Rate ratio</span>
              <input
                type="number"
                step="0.000001"
                className="text-input"
                value={ratio}
                onChange={(event) => setRatio(Number(event.target.value) || 1)}
              />
            </label>
          )}
        </div>
        <p className="hint">
          Use the offset when audio starts early or late by a fixed amount (for example a constant lead-in). Use the rate ratio
          when the gap grows over time — that is the drift you get from separate exports on very long projects.
        </p>
      </section>

      <section className="block">
        <h3>Output</h3>
        <div className="field-row">
          <label className="field">
            <span>Container</span>
            <select className="select" value={container} onChange={(event) => setContainer(event.target.value)}>
              <option value="mkv">MKV</option>
              <option value="mp4">MP4</option>
              <option value="mov">MOV</option>
            </select>
          </label>
          <label className="field">
            <span>File name</span>
            <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Folder</span>
          <div className="row">
            <input className="text-input" value={outDir} onChange={(event) => setOutDir(event.target.value)} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const folder = await pickDirectory('Choose output folder', outDir)
                if (folder) setOutDir(folder)
              }}
            >
              Browse
            </button>
          </div>
        </label>
        {info?.audio && (
          <label className="checkbox">
            <input type="checkbox" checked={keepOriginal} onChange={(event) => setKeepOriginal(event.target.checked)} />
            <span>Also keep the video’s original audio as a second track</span>
          </label>
        )}
      </section>

      <footer className="panel-foot">
        <div className="summary">
          {comparison
            ? `Drift ${comparison.driftMs} ms · ${mode === 'stretch' ? 'stretch' : mode === 'trim' ? 'trim' : 'copy'}`
            : 'No check run yet'}
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={queue} disabled={busy}>
          {busy ? 'Working…' : 'Add merge to queue'}
        </button>
      </footer>
    </div>
  )
}
