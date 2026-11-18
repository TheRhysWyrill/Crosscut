import type { ExportOptions, Preset } from '../types'

interface PresetControlsProps {
  presets: Preset[]
  hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean }
  presetId: string
  options: ExportOptions
  onPreset: (id: string) => void
  onOptions: (patch: Partial<ExportOptions>) => void
}

export function defaultOptions(preset: Preset | undefined, hardware = 'auto'): ExportOptions {
  return {
    quality: preset?.defaultQuality ?? 20,
    speed: preset?.defaultSpeed ?? 'medium',
    audioBitrate: preset?.defaultAudioBitrate ?? 192,
    scale: 'source',
    fps: 'source',
    hardware,
    audio: 'auto',
    loudnorm: false,
    gifFps: 15,
  }
}

const SPEEDS = ['ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'veryslow']
const PROFILE_NAMES: Record<number, string> = {
  0: 'Proxy',
  1: 'LT',
  2: '422',
  3: '422 HQ',
  4: '4444',
  5: '4444 XQ',
}

export default function PresetControls({
  presets,
  hardware,
  presetId,
  options,
  onPreset,
  onOptions,
}: PresetControlsProps) {
  const preset = presets.find((entry) => entry.id === presetId)
  const groups = Array.from(new Set(presets.map((entry) => entry.group)))
  const isLosslessish = preset?.family === 'copy'
  const useSpeed = ['x264', 'x265', 'av1', 'vp9'].includes(preset?.family ?? '')
  const isAudio = Boolean(preset?.audioOnly)
  const qualityKind = preset?.qualityKind ?? 'crf'

  return (
    <div className="preset-controls">
      <label className="field">
        <span>Format</span>
        <select className="select" value={presetId} onChange={(event) => onPreset(event.target.value)}>
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {presets
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {preset?.note && <span className="hint">{preset.note}</span>}
      </label>

      {!isAudio && (
        <div className="field-row">
          <label className="field">
            <span>Resolution</span>
            <select className="select" value={options.scale} onChange={(event) => onOptions({ scale: event.target.value })}>
              <option value="source">Source</option>
              <option value="2160">2160p</option>
              <option value="1440">1440p</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
            </select>
          </label>
          <label className="field">
            <span>Frame rate</span>
            <select className="select" value={options.fps} onChange={(event) => onOptions({ fps: event.target.value })}>
              <option value="source">Source</option>
              <option value="60">60</option>
              <option value="30">30</option>
              <option value="25">25</option>
              <option value="24">24</option>
            </select>
          </label>
        </div>
      )}

      {qualityKind === 'crf' && !isLosslessish && (
        <label className="field">
          <span>
            Quality <span className="mono muted">CRF {options.quality}</span>
          </span>
          <input
            type="range"
            min={0}
            max={51}
            value={options.quality}
            onChange={(event) => onOptions({ quality: Number(event.target.value) })}
          />
          <span className="hint">Lower is better and bigger. 18–24 is a good range.</span>
        </label>
      )}

      {qualityKind === 'prores' && (
        <label className="field">
          <span>ProRes profile</span>
          <select
            className="select"
            value={String(options.quality)}
            onChange={(event) => onOptions({ quality: Number(event.target.value) })}
          >
            {[0, 1, 2, 3, 4].map((profile) => (
              <option key={profile} value={profile}>
                {PROFILE_NAMES[profile]}
              </option>
            ))}
          </select>
        </label>
      )}

      {qualityKind === 'size' && (
        <label className="field">
          <span>
            Width <span className="mono muted">{options.quality}px</span>
          </span>
          <input
            type="range"
            min={160}
            max={1280}
            step={20}
            value={options.quality}
            onChange={(event) => onOptions({ quality: Number(event.target.value) })}
          />
        </label>
      )}

      {useSpeed && (
        <label className="field">
          <span>Encoder speed</span>
          <select className="select" value={options.speed} onChange={(event) => onOptions({ speed: event.target.value })}>
            {SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}
              </option>
            ))}
          </select>
        </label>
      )}

      {!isAudio && !isLosslessish && (hardware.nvenc || hardware.qsv || hardware.amf) && (
        <label className="field">
          <span>Encoder</span>
          <select className="select" value={options.hardware} onChange={(event) => onOptions({ hardware: event.target.value })}>
            <option value="auto">Automatic</option>
            <option value="none">Software (best quality)</option>
            {hardware.nvenc && <option value="nvenc">NVIDIA NVENC</option>}
            {hardware.qsv && <option value="qsv">Intel QuickSync</option>}
            {hardware.amf && <option value="amf">AMD AMF</option>}
          </select>
        </label>
      )}

      {!isAudio && (
        <div className="field-row">
          {!isLosslessish && (
            <label className="field">
              <span>Audio bitrate</span>
              <select
                className="select"
                value={options.audioBitrate}
                onChange={(event) => onOptions({ audioBitrate: Number(event.target.value) })}
              >
                {[96, 128, 160, 192, 256, 320, 512].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} kbps
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Audio stream</span>
            <select
              className="select"
              value={options.audio}
              onChange={(event) => onOptions({ audio: event.target.value as ExportOptions['audio'] })}
            >
              <option value="auto">Keep as is</option>
              <option value="copy">Stream copy</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>
      )}

      {!isAudio && !isLosslessish && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={options.loudnorm}
            onChange={(event) => onOptions({ loudnorm: event.target.checked })}
          />
          <span>Normalise loudness to -16 LUFS</span>
        </label>
      )}
    </div>
  )
}
