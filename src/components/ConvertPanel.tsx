import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ExportOptions, JobInput, Preset } from '../types'
import { baseName, bytes, shortPath } from '../format'
import PresetControls, { defaultOptions } from './PresetControls'
import { pickDirectory, pickFiles } from '../desktop'

interface ConvertPanelProps {
  presets: Preset[]
  hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean }
  settings: AppSettings
  onQueue: (jobs: JobInput[], startNow: boolean) => Promise<void>
  onError: (message: string) => void
  onOpenFile: (path: string) => Promise<void>
}

interface Picked {
  path: string
  size: number
}

export default function ConvertPanel({ presets, hardware, settings, onQueue, onError, onOpenFile }: ConvertPanelProps) {
  const [files, setFiles] = useState<Picked[]>([])
  const [presetId, setPresetId] = useState('h264-mp4')
  const [options, setOptions] = useState<ExportOptions>(defaultOptions(presets[0]))
  const [outDir, setOutDir] = useState(settings.outDir)
  const [subfolder, setSubfolder] = useState(true)
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const preset = useMemo(() => presets.find((entry) => entry.id === presetId), [presets, presetId])

  useEffect(() => {
    setOutDir(settings.outDir)
  }, [settings.outDir])

  useEffect(() => {
    setOptions(defaultOptions(preset, settings.hardware || 'auto'))
  }, [presetId, preset, settings.hardware])

  const addFiles = async () => {
    try {
      const picked = await pickFiles(true, 'Add files to convert')
      if (!picked.length) return
      setFiles((previous) => {
        const existing = new Set(previous.map((entry) => entry.path))
        return [...previous, ...picked.filter((path) => !existing.has(path)).map((path) => ({ path, size: 0 }))]
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const queue = async () => {
    if (!files.length) {
      onError('Add at least one file')
      return
    }
    setBusy(true)
    try {
      const destination = subfolder ? `${outDir}\\converted` : outDir
      const jobs: JobInput[] = files.map((file) => ({
        type: 'cut',
        label: `${baseName(file.path)} · ${preset?.label ?? presetId}`,
        params: {
          source: file.path,
          segments: [],
          mode: 'encode',
          output: 'single',
          preset: presetId,
          options,
          container: preset?.ext ?? 'mp4',
          nameTemplate: '{name}',
          outDir: destination,
        },
      }))
      await onQueue(jobs, startNow)
      setFiles([])
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel convert-panel">
      <section className="block">
        <div className="block-head">
          <h3>Files</h3>
          <button type="button" className="btn btn-sm" onClick={addFiles}>
            Add files
          </button>
        </div>
        {files.length === 0 ? (
          <p className="hint">Add several recordings and convert them all with one format — no timeline needed.</p>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className="link-btn ellipsis" onClick={() => onOpenFile(file.path)} title={file.path}>
                  {shortPath(file.path, 40)}
                </button>
                {file.size > 0 && <span className="muted small">{bytes(file.size)}</span>}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setFiles((previous) => previous.filter((entry) => entry.path !== file.path))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h3>Format</h3>
        <PresetControls
          presets={presets}
          hardware={hardware}
          presetId={presetId}
          options={options}
          onPreset={setPresetId}
          onOptions={(patch) => setOptions((previous) => ({ ...previous, ...patch }))}
        />
      </section>

      <section className="block">
        <h3>Destination</h3>
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
        <label className="checkbox">
          <input type="checkbox" checked={subfolder} onChange={(event) => setSubfolder(event.target.checked)} />
          <span>Put results in a “converted” subfolder</span>
        </label>
      </section>

      <footer className="panel-foot">
        <div className="summary">
          <strong>{files.length}</strong> file{files.length === 1 ? '' : 's'} → {preset?.label ?? presetId}
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} />
          <span>Start processing immediately</span>
        </label>
        <button type="button" className="btn btn-primary btn-lg" onClick={queue} disabled={busy || files.length === 0}>
          {busy ? 'Adding…' : 'Add to queue'}
        </button>
      </footer>
    </div>
  )
}
