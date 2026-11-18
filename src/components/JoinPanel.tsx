import { useEffect, useState } from 'react'
import type { AppSettings, ExportOptions, JobInput, Preset } from '../types'
import { baseName, shortPath } from '../format'
import PresetControls, { defaultOptions } from './PresetControls'
import { pickDirectory, pickFiles } from '../desktop'

interface JoinPanelProps {
  presets: Preset[]
  hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean }
  settings: AppSettings
  onQueue: (jobs: JobInput[], startNow: boolean) => Promise<void>
  onError: (message: string) => void
}

export default function JoinPanel({ presets, hardware, settings, onQueue, onError }: JoinPanelProps) {
  const [files, setFiles] = useState<string[]>([])
  const [strategy, setStrategy] = useState<'auto' | 'copy' | 'encode'>('auto')
  const [presetId, setPresetId] = useState('h264-mp4')
  const [options, setOptions] = useState<ExportOptions>(defaultOptions(presets[0]))
  const [name, setName] = useState('joined')
  const [outDir, setOutDir] = useState(settings.outDir)
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)

  const preset = presets.find((entry) => entry.id === presetId)

  useEffect(() => {
    setOutDir(settings.outDir)
  }, [settings.outDir])

  useEffect(() => {
    setOptions(defaultOptions(preset, settings.hardware || 'auto'))
  }, [presetId, preset, settings.hardware])

  const addFiles = async () => {
    try {
      const picked = await pickFiles(true, 'Add files to join')
      if (!picked.length) return
      setFiles((previous) => [...previous, ...picked.filter((path) => !previous.includes(path))])
      if (files.length === 0 && picked.length === 1) setName(baseName(picked[0]))
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const move = (index: number, direction: -1 | 1) => {
    const next = [...files]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setFiles(next)
  }

  const queue = async () => {
    if (files.length < 2) {
      onError('Add at least two files to join')
      return
    }
    setBusy(true)
    try {
      await onQueue(
        [
          {
            type: 'concat',
            label: `Join · ${files.length} files`,
            params: {
              files,
              strategy,
              preset: presetId,
              options,
              name,
              outDir,
            },
          },
        ],
        startNow,
      )
      setFiles([])
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel join-panel">
      <section className="block">
        <div className="block-head">
          <h3>Files to join</h3>
          <button type="button" className="btn btn-sm" onClick={addFiles}>
            Add files
          </button>
        </div>
        <p className="hint">
          Order is top to bottom. Copy mode needs matching codecs and sizes; if they differ, use Encode mode and the frames are
          scaled to the first file.
        </p>
        {files.length === 0 ? (
          <p className="muted small">Nothing added yet.</p>
        ) : (
          <ul className="join-list">
            {files.map((file, index) => (
              <li key={file}>
                <span className="join-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="ellipsis" title={file}>
                  {shortPath(file, 34)}
                </span>
                <button type="button" className="icon-btn" onClick={() => move(index, -1)} disabled={index === 0} title="Move up">
                  ▴
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => move(index, 1)}
                  disabled={index === files.length - 1}
                  title="Move down"
                >
                  ▾
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setFiles((previous) => previous.filter((entry) => entry !== file))}
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block">
        <h3>How to join</h3>
        <div className="segmented">
          <button type="button" className={strategy === 'auto' ? 'active' : ''} onClick={() => setStrategy('auto')}>
            Auto
          </button>
          <button type="button" className={strategy === 'copy' ? 'active' : ''} onClick={() => setStrategy('copy')}>
            Copy
          </button>
          <button type="button" className={strategy === 'encode' ? 'active' : ''} onClick={() => setStrategy('encode')}>
            Re-encode
          </button>
        </div>
        <p className="hint">
          Auto copies when the files match and re-encodes when they do not. Copy is instant and lossless.
        </p>
      </section>

      {strategy !== 'copy' && (
        <section className="block">
          <h3>Format for re-encoding</h3>
          <PresetControls
            presets={presets}
            hardware={hardware}
            presetId={presetId}
            options={options}
            onPreset={setPresetId}
            onOptions={(patch) => setOptions((previous) => ({ ...previous, ...patch }))}
          />
        </section>
      )}

      <section className="block">
        <h3>Output</h3>
        <label className="field">
          <span>File name</span>
          <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
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
        {strategy !== 'copy' && preset && <p className="hint">Output extension: .{preset.ext}</p>}
      </section>

      <footer className="panel-foot">
        <div className="summary">
          <strong>{files.length}</strong> file{files.length === 1 ? '' : 's'} joined into one
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} />
          <span>Start processing immediately</span>
        </label>
        <button type="button" className="btn btn-primary btn-lg" onClick={queue} disabled={busy || files.length < 2}>
          {busy ? 'Adding…' : 'Add join to queue'}
        </button>
      </footer>
    </div>
  )
}
