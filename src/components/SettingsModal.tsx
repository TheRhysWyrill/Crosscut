import { useEffect, useState } from 'react'
import type { AppSettings, Tools } from '../types'
import { pickDirectory } from '../desktop'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '../theme'

export interface PathHints {
  /** The folder projects are actually read from right now. */
  projectsDir: string
  defaultProjectsDir: string
  appDir: string
}

interface SettingsModalProps {
  open: boolean
  settings: AppSettings
  tools: Tools | null
  paths: PathHints
  onClose: () => void
  onSave: (patch: Partial<AppSettings>) => Promise<void>
  onRefreshTools: () => Promise<void>
  onAccentPreview: (value: string | null) => void
  onCheckFfmpegUpdate: () => Promise<{
    current: string
    latest: string
    updateAvailable: boolean
    managed: boolean
    error?: string
  }>
  onStartFfmpegUpdate: () => Promise<void>
}

export default function SettingsModal({
  open,
  settings,
  tools,
  paths,
  onClose,
  onSave,
  onRefreshTools,
  onAccentPreview,
  onCheckFfmpegUpdate,
  onStartFfmpegUpdate,
}: SettingsModalProps) {
  const [ffmpegDir, setFfmpegDir] = useState(settings.ffmpegDir)
  const [outDir, setOutDir] = useState(settings.outDir)
  const [projectsDir, setProjectsDir] = useState(settings.projectsDir || '')
  const [concurrency, setConcurrency] = useState(settings.concurrency)
  const [reopen, setReopen] = useState(settings.reopenLastProject === true)
  const [accent, setAccent] = useState(settings.accent || DEFAULT_ACCENT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ffState, setFfState] = useState<{
    state: 'idle' | 'checking' | 'checked' | 'error'
    latest: string
    updateAvailable: boolean
    message: string
  }>({ state: 'idle', latest: '', updateAvailable: false, message: '' })

  useEffect(() => {
    if (!open) return
    setFfmpegDir(settings.ffmpegDir)
    setOutDir(settings.outDir)
    setProjectsDir(settings.projectsDir || '')
    setConcurrency(settings.concurrency)
    setReopen(settings.reopenLastProject === true)
    setAccent(settings.accent || DEFAULT_ACCENT)
  }, [open, settings])

  if (!open) return null

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave({ ffmpegDir, outDir, projectsDir, concurrency, accent, reopenLastProject: reopen })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="field-group">
            <h3>FFmpeg</h3>
            <p className="muted small">
              FFmpeg does all the cutting and encoding, and a full build ships with CrossCut, so nothing needs installing. If the
              bundled copy ever goes missing, CrossCut falls back to the folder below, then PATH, then the Shutter Encoder,
              LosslessCut and Solveig folders.
            </p>
            <div className="row">
              <input className="text-input" value={ffmpegDir} onChange={(event) => setFfmpegDir(event.target.value)} placeholder="Bundled FFmpeg" />
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  const folder = await pickDirectory('Select the folder with ffmpeg.exe')
                  if (folder) setFfmpegDir(folder)
                }}
              >
                Browse
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onRefreshTools()
                  } finally {
                    setBusy(false)
                  }
                }}
                disabled={busy}
              >
                Re-scan
              </button>
            </div>
            <div className="ff-update-row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={ffState.state === 'checking'}
                onClick={async () => {
                  setFfState({ state: 'checking', latest: '', updateAvailable: false, message: 'Reading gyan.dev…' })
                  try {
                    const result = await onCheckFfmpegUpdate()
                    setFfState({
                      state: result.error ? 'error' : 'checked',
                      latest: result.latest,
                      updateAvailable: result.updateAvailable,
                      message: result.error
                        ? result.error
                        : result.updateAvailable
                          ? `FFmpeg ${result.latest} is available; you have ${result.current || 'an older build'}.`
                          : `FFmpeg ${result.current || result.latest} is the current release build.`,
                    })
                  } catch (err) {
                    setFfState({ state: 'error', latest: '', updateAvailable: false, message: err instanceof Error ? err.message : String(err) })
                  }
                }}
              >
                {ffState.state === 'checking' ? 'Checking…' : 'Check for a newer FFmpeg'}
              </button>
              {ffState.updateAvailable && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await onStartFfmpegUpdate()
                      setFfState((current) => ({
                        ...current,
                        updateAvailable: false,
                        message: 'Downloading in the background; the queue shows the progress.',
                      }))
                    } finally {
                      setBusy(false)
                    }
                  }}
                  disabled={busy}
                >
                  Update to {ffState.latest}
                </button>
              )}
              {ffState.message && (
                <span className={`small ${ffState.state === 'error' ? 'warn-text' : 'muted'}`}>{ffState.message}</span>
              )}
            </div>
            <p className="muted small">
              A refresh is unpacked into your app data folder and used from the next job onward. The copy inside the
              installer is left alone, so reinstalling never undoes it.
            </p>
            <div className={`status-box ${tools?.ok ? 'ok' : 'error'}`}>
              {tools?.ok ? (
                <>
                  <strong>FFmpeg {tools.version}</strong> · found via {tools.source}
                  <div className="mono small break">{tools.ffmpeg}</div>
                  <div className="hw-row">
                    {tools.hardware.nvenc && <span className="tag">NVENC</span>}
                    {tools.hardware.qsv && <span className="tag">QuickSync</span>}
                    {tools.hardware.amf && <span className="tag">AMF</span>}
                    {tools.hardware.av1 && <span className="tag">AV1</span>}
                  </div>
                </>
              ) : (
                <>FFmpeg was not found. Set the folder above.</>
              )}
            </div>
          </section>

          <section className="field-group">
            <h3>Exports</h3>
            <label className="field">
              <span>Default output folder</span>
              <div className="row">
                <input className="text-input" value={outDir} onChange={(event) => setOutDir(event.target.value)} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const folder = await pickDirectory('Choose the export folder', outDir)
                    if (folder) setOutDir(folder)
                  }}
                >
                  Browse
                </button>
              </div>
            </label>
            <label className="field">
              <span>Parallel jobs</span>
              <div className="row">
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="text-input short"
                  value={concurrency}
                  onChange={(event) => setConcurrency(Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
                />
                <span className="muted small">New jobs use this many CPU cores at once.</span>
              </div>
            </label>
          </section>

          <section className="field-group">
            <h3>Appearance</h3>
            <p className="muted small">Colour of the main buttons, the app mark and the timeline scrollbar.</p>
            <div className="accent-swatches">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`accent-swatch${accent.toLowerCase() === preset.value.toLowerCase() ? ' active' : ''}`}
                  style={{ background: preset.value }}
                  title={preset.name}
                  aria-label={preset.name}
                  onClick={() => {
                    setAccent(preset.value)
                    onAccentPreview(preset.value)
                  }}
                />
              ))}
              <label className="accent-custom" title="Pick any colour">
                <input
                  type="color"
                  value={accent || DEFAULT_ACCENT}
                  onChange={(event) => {
                    setAccent(event.target.value)
                    onAccentPreview(event.target.value)
                  }}
                />
                <span>Custom</span>
              </label>
            </div>
          </section>

          <section className="field-group">
            <h3>Projects</h3>
            <p className="muted small">
              Saved projects and the batch list are read from this folder. Leave it empty to use the app data folder.
            </p>
            <label className="field">
              <span>Project folder</span>
              <div className="row">
                <input
                  className="text-input"
                  value={projectsDir}
                  placeholder={paths.defaultProjectsDir || 'App data folder'}
                  onChange={(event) => setProjectsDir(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const folder = await pickDirectory('Choose the project folder', projectsDir || paths.projectsDir)
                    if (folder) setProjectsDir(folder)
                  }}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!paths.appDir}
                  title={paths.appDir ? `Store projects in ${paths.appDir}` : 'Only available in the desktop app'}
                  onClick={() => setProjectsDir(`${paths.appDir.replace(/[\\/]+$/, '')}/projects`)}
                >
                  Next to the app
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setProjectsDir('')}
                >
                  Default
                </button>
              </div>
            </label>
            <p className="muted small mono break">{paths.projectsDir}</p>
            <label className="checkbox">
              <input type="checkbox" checked={reopen} onChange={(event) => setReopen(event.target.checked)} />
              <span>Reopen the last project on launch</span>
            </label>
            <p className="muted small">
              Off by default, so CrossCut starts on an empty timeline. When on, the project you had open comes back with
              its cuts and export settings.
            </p>
          </section>

          <section className="field-group">
            <h3>Where things live</h3>
            <p className="muted small">
              Settings, queue state and preview caches are stored per user. Cutting never modifies your source files.
            </p>
          </section>
        </div>

        {error && <div className="status-box error small">{error}</div>}

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
