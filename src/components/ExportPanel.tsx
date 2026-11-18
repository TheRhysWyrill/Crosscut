import { useRef, useState } from 'react'
import type { ExportConfig, JobInput, MediaInfo, Preset, Segment } from '../types'
import { timecode } from '../format'
import { buildCutJobs, describeTrack } from '../batch'
import { hdrKind, isHdrInfo } from '../hdr'
import PresetControls, { defaultOptions } from './PresetControls'
import { pickDirectory } from '../desktop'

interface ExportPanelProps {
  info: MediaInfo | null
  /** The saved project's name, used as the export's {name}. */
  projectName: string
  /** Every recording on the project timeline, in playback order. */
  clips: MediaInfo[]
  segments: Segment[]
  duration: number
  config: ExportConfig
  onConfig: (patch: Partial<ExportConfig>) => void
  /** The audio stream chosen for each recording, keyed by source path. */
  tracksByClip: Record<string, number>
  presets: Preset[]
  hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean }
  onQueue: (jobs: JobInput[], startNow: boolean) => Promise<void>
  onError: (message: string) => void
}

const MODES: { id: ExportConfig['mode']; label: string; blurb: string }[] = [
  {
    id: 'lossless',
    label: 'Lossless copy',
    blurb: 'Streams are copied, never re-encoded. Instant, exact quality, cuts land on keyframes.',
  },
  {
    id: 'smart',
    label: 'Smart render',
    blurb: 'Copy everywhere it can, re-encode only the cuts that fall inside a GOP. Frame accurate, still fast.',
  },
  {
    id: 'encode',
    label: 'Re-encode',
    blurb: 'Every frame is encoded with the chosen format. Use when you need a new codec or exact cuts.',
  },
]

export default function ExportPanel({
  info,
  projectName,
  clips,
  segments,
  duration,
  config,
  onConfig,
  tracksByClip,
  presets,
  hardware,
  onQueue,
  onError,
}: ExportPanelProps) {
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const presetFile = useRef<HTMLInputElement>(null)

  const enabled = segments.filter((segment) => segment.enabled)
  const total = enabled.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
  const fps = info?.video?.fps || 25
  const modeInfo = MODES.find((entry) => entry.id === config.mode) ?? MODES[0]
  const tracks = info?.audioTracks ?? []
  const audioRuns = config.audioMode === 'both' && tracks.length > 1 ? tracks.length : 1
  const hdrClips = clips.filter((clip) => isHdrInfo(clip))
  // Transitions and re-encodes rebuild picture, which is when colour tags matter.
  const reencodes = config.mode !== 'lossless' || (config.output === 'single' && config.transition !== 'none')

  const queue = async () => {
    if (!clips.length) {
      onError('Open a clip first')
      return
    }
    setBusy(true)
    try {
      let cursor = 0
      const list = clips.map((clip) => {
        const entry = { path: clip.path, offset: cursor, duration: clip.duration }
        cursor += clip.duration
        return entry
      })
      const jobs: JobInput[] = buildCutJobs(
        { clips: list, duration, audioTracks: clips[0].audioTracks ?? [], tracks: tracksByClip, name: projectName },
        segments,
        config,
      )
      await onQueue(jobs, startNow)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!info) {
    return (
      <div className="panel-empty">
        <p>Open a clip to set up an export.</p>
      </div>
    )
  }

  return (
    <div className="panel export-panel">
      <section className="block">
        <h3>Cut mode</h3>
        <div className="mode-switch">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`mode-btn ${config.mode === entry.id ? 'active' : ''}`}
              onClick={() => onConfig({ mode: entry.id })}
            >
              <span className="mode-label">{entry.label}</span>
              <span className="mode-blurb">{entry.blurb}</span>
            </button>
          ))}
        </div>
        {hdrClips.length > 0 && reencodes && (
          <p className="hdr-warning">
            <strong>
              {hdrClips.length === 1 ? 'One recording is HDR' : `${hdrClips.length} recordings are HDR`}
            </strong>{' '}
            {hdrClips
              .map((clip) => `${clip.name.replace(/\.[^.]+$/, '')} (${hdrKind(clip.video)})`)
              .join(', ')}
            . This export re-encodes picture. CrossCut carries the source colour tags across but does not tone-map, so the
            result stays HDR: right on an HDR display, washed out on an SDR one. Lossless copy leaves the original frames
            untouched.
          </p>
        )}
        {config.mode === 'lossless' && (
          <p className="hint">
            Lossless cuts only land exactly on keyframes. Use <strong>Snap to keyframes</strong> in the Cuts panel to see where
            those are, or pick Smart render for frame-accurate cuts.
          </p>
        )}
      </section>

      <section className="block">
        <h3>Output</h3>
        <div className="segmented">
          <button
            type="button"
            className={config.output === 'separate' ? 'active' : ''}
            onClick={() => onConfig({ output: 'separate' })}
          >
            Separate files
          </button>
          <button
            type="button"
            className={config.output === 'single' ? 'active' : ''}
            onClick={() => onConfig({ output: 'single' })}
          >
            One merged file
          </button>
        </div>
        <p className="hint">
          {config.output === 'single'
            ? 'Every cut is written and joined into one file in a single stream-copy pass — no second workflow, and audio cannot drift between parts.'
            : 'Every cut becomes its own file. A cut that spans two recordings is still cut and joined in one pass.'}
        </p>
        <label className="checkbox" title="Move the MP4 index to the front so a browser can start playing before the file is downloaded">
          <input
            type="checkbox"
            checked={config.faststart}
            onChange={(event) => onConfig({ faststart: event.target.checked })}
          />
          <span>Faststart — index at the front for instant web playback</span>
        </label>
        <p className="hint">
          Leave this off for long recordings: it rewrites the whole MP4 once more after the export, which roughly doubles
          the time. YouTube does not need it.
        </p>
      </section>

      <section className="block">
        <h3>Cut transitions</h3>
        <div className="row">
          <select
            className="select"
            value={config.transition}
            disabled={config.output !== 'single'}
            onChange={(event) => onConfig({ transition: event.target.value as ExportConfig['transition'] })}
          >
            <option value="none">Hard cut</option>
            <option value="dip">Fade to black</option>
            <option value="wipe">Soft wipe</option>
            <option value="blur">Blur dissolve</option>
          </select>
          <select
            className="select"
            value={config.transitionScope}
            disabled={config.output !== 'single' || config.transition === 'none'}
            title="Where the transition happens"
            onChange={(event) => onConfig({ transitionScope: event.target.value as ExportConfig['transitionScope'] })}
          >
            <option value="both">Every cut + start &amp; end</option>
            <option value="joins">Every cut only</option>
            <option value="ends">Start &amp; end only</option>
          </select>
          <select
            className="select"
            value={config.transitionSeconds}
            disabled={config.output !== 'single' || config.transition === 'none'}
            onChange={(event) => onConfig({ transitionSeconds: Number(event.target.value) })}
          >
            {[0.25, 0.5, 0.75, 1].map((value) => (
              <option key={value} value={value}>
                {value}s
              </option>
            ))}
          </select>
        </div>
        <p className="hint">
          {config.output !== 'single'
            ? 'Transitions apply to a merged export — separate files have no join to soften.'
            : config.transition === 'none'
              ? 'Each cut lands on the join exactly. Lossless cuts still snap to the nearest keyframe.'
              : `${config.transition === 'blur' || config.transition === 'wipe' ? `A ${config.transition === 'blur' ? 'blur dissolve' : 'soft wipe'} overlaps the two sides, so the result gets shorter by ${config.transitionSeconds}s at every cut it touches. ` : 'A fade to black does not change the length. '}The opening and closing frames always fade through black. Only the split second at each point is re-encoded, so a long export stays near its current speed.`}
        </p>
      </section>

      {tracks.length > 0 && (
        <section className="block">
          <h3>Audio</h3>
          <select
            className="select"
            value={config.audioMode}
            onChange={(event) => onConfig({ audioMode: event.target.value })}
          >
            <option value="first">Track 1 — {describeTrack(tracks[0], 0)}</option>
            {tracks.slice(1).map((track, position) => (
              <option key={track.index} value={`track:${track.index}`}>
                Track {position + 2} — {describeTrack(track, position + 1)}
              </option>
            ))}
            {(clips.length > 1 || config.audioMode === 'clip') && (
              <option value="clip">Each recording's own track</option>
            )}
            {tracks.length > 1 && <option value="all">All {tracks.length} tracks in one file</option>}
            {tracks.length > 1 && <option value="both">Every track as its own file ({tracks.length} runs)</option>}
          </select>
          <p className="hint">
            {config.audioMode === 'clip'
              ? 'Every recording exports the track picked beside it in the Clips list, so a two-track capture and a six-track OBS file can each keep the right one.'
              : audioRuns > 1
                ? `The project is queued ${audioRuns} times, once per track, with the track name added to each file.`
                : 'Only the selected audio track is written to the output. Other tracks are dropped.'}
          </p>
        </section>
      )}

      {config.mode === 'encode' ? (
        <section className="block">
          <h3>Format</h3>
          <PresetControls
            presets={presets}
            hardware={hardware}
            presetId={config.presetId}
            options={config.options}
            onPreset={(id) => {
              const next = presets.find((entry) => entry.id === id)
              onConfig({
                presetId: id,
                presetLabel: next?.label ?? id,
                presetExt: next?.ext ?? 'mp4',
                options: defaultOptions(next, config.options.hardware),
              })
            }}
            onOptions={(patch) => onConfig({ options: { ...config.options, ...patch } })}
          />
        </section>
      ) : (
        <section className="block">
          <h3>Container</h3>
          <select className="select" value={config.container} onChange={(event) => onConfig({ container: event.target.value })}>
            <option value="auto">Same as source</option>
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
            <option value="mov">MOV</option>
            <option value="ts">MPEG-TS</option>
          </select>
          <p className="hint">
            Stream copy can only target a container that accepts the original codecs. When several recordings are joined,
            this picks MP4 whenever the codecs allow it (H.264/HEVC + AAC) and only falls back to MKV when they do not.
          </p>
          <label className="checkbox" title="Carry subtitle tracks and add chapter marks for the kept fragments">
            <input
              type="checkbox"
              checked={config.keepExtras}
              onChange={(event) => onConfig({ keepExtras: event.target.checked })}
            />
            <span>Keep subtitles, add chapters</span>
          </label>
          <p className="hint">
            {config.keepExtras
              ? 'Subtitle tracks are copied as-is and every kept fragment becomes a chapter named after it. Matroska only: other containers cannot hold subtitles without converting them, so the export falls back to picture and audio only.'
              : 'Subtitle tracks and chapter marks are dropped. Nothing else changes either way.'}
          </p>
        </section>
      )}

      <section className="block">
        <h3>Slicing</h3>
        <select
          className="select"
          value={config.sliceMode}
          onChange={(event) => onConfig({ sliceMode: event.target.value as ExportConfig['sliceMode'] })}
        >
          <option value="none">No slicing — one export per cut</option>
          <option value="parts">Divide the result into equal parts</option>
          <option value="duration">Divide every N minutes</option>
        </select>
        {config.sliceMode === 'parts' && (
          <label className="field">
            <span>Number of parts</span>
            <input
              className="text-input short"
              type="number"
              min={2}
              max={200}
              value={config.sliceParts}
              onChange={(event) =>
                onConfig({ sliceParts: Math.max(2, Math.min(200, Number(event.target.value) || 2)) })
              }
            />
          </label>
        )}
        {config.sliceMode === 'duration' && (
          <label className="field">
            <span>Minutes per part</span>
            <input
              className="text-input short"
              type="number"
              min={1}
              max={720}
              value={config.sliceMinutes}
              onChange={(event) =>
                onConfig({ sliceMinutes: Math.max(1, Math.min(720, Number(event.target.value) || 1)) })
              }
            />
          </label>
        )}
        {config.sliceMode !== 'none' && (
          <p className="hint">
            Each part becomes its own queued job and its own file, named “{'{name}'} - part 01”. Parts follow the kept
            timeline, so cut fragments stay cut.
          </p>
        )}
      </section>

      <section className="block">
        <h3>Naming &amp; destination</h3>
        <label className="field">
          <span>File name pattern</span>
          <input
            className="text-input"
            value={config.nameTemplate}
            onChange={(event) => onConfig({ nameTemplate: event.target.value })}
          />
          <span className="hint">
            Tokens: <code>{'{name}'}</code> <code>{'{label}'}</code> <code>{'{index}'}</code> <code>{'{start}'}</code>{' '}
            <code>{'{end}'}</code>
          </span>
          <span className="hint">
            {projectName
              ? `A merged file is named “${projectName}”.`
              : 'A merged file is named after the first recording.'}{' '}
            An index is added only when exporting separate files or slicing the result.
          </span>
        </label>
        <label className="field">
          <span>Folder</span>
          <div className="row">
            <input className="text-input" value={config.outDir} onChange={(event) => onConfig({ outDir: event.target.value })} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const folder = await pickDirectory('Choose the export folder', config.outDir)
                if (folder) onConfig({ outDir: folder })
              }}
            >
              Browse
            </button>
          </div>
        </label>
      </section>

      <footer className="panel-foot">
        <div className="summary">
          <strong>{enabled.length}</strong> cut{enabled.length === 1 ? '' : 's'} · {timecode(total, fps)} ·{' '}
          {config.sliceMode !== 'none'
            ? `${config.sliceMode === 'parts' ? config.sliceParts : 'timed'} parts`
            : config.output === 'single'
              ? '1 file'
              : `${enabled.length} files`}
          {audioRuns > 1 ? ` × ${audioRuns} audio` : ''}
          {clips.length > 1 ? ` · ${clips.length} recordings joined` : ''}
        </div>
        <div className="summary-blurb">{modeInfo.blurb}</div>
        <label className="checkbox">
          <input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} />
          <span>Start processing immediately</span>
        </label>
        <div className="preset-file-row">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="Write these export settings to a file you can share or reuse"
            onClick={() => {
              const preset = {
                app: 'crosscut',
                kind: 'export-preset',
                version: 1,
                savedAt: new Date().toISOString(),
                name: config.presetLabel || 'Export preset',
                config,
              }
              const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = `${(config.presetLabel || 'crosscut').replace(/[^\w.-]+/g, '-')}.crosscut-preset.json`
              link.click()
              URL.revokeObjectURL(url)
            }}
          >
            Save preset
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => presetFile.current?.click()}>
            Load preset
          </button>
          <input
            ref={presetFile}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              try {
                const parsed = JSON.parse(await file.text())
                if (parsed?.app !== 'crosscut' || parsed?.kind !== 'export-preset' || !parsed.config) {
                  throw new Error('That is not a CrossCut preset file')
                }
                const next = { ...config, ...parsed.config }
                // Folder, name pattern and the clip count belong to this machine, not the preset.
                onConfig({
                  ...next,
                  outDir: config.outDir,
                  nameTemplate: config.nameTemplate,
                })
              } catch (err) {
                onError(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={queue} disabled={busy}>
          {busy ? 'Adding…' : 'Add to queue'}
        </button>
      </footer>
    </div>
  )
}
