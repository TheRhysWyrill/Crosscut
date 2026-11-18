function pad(value: number): string {
  return String(Math.max(0, value)).padStart(2, '0')
}

/** HH:MM:SS:FF — the SolveigMM style timecode, where the last field is frames. */
export function timecode(seconds: number, fps = 25): string {
  const safe = Math.max(0, Number(seconds) || 0)
  const rate = Math.max(1, Math.round(Number(fps) || 25))
  const totalFrames = Math.round(safe * rate)
  const frames = totalFrames % rate
  const total = Math.floor(totalFrames / rate)
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frames)}`
}

/** HH:MM:SS without frames, for labels where frames would just be noise. */
export function shortTimecode(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0)
  const whole = Math.floor(safe)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function fileTimecode(seconds: number, fps = 25): string {
  return timecode(seconds, fps).replace(/:/g, '-')
}

/**
 * Accepts HH:MM:SS:FF, HH:MM:SS, MM:SS, plain seconds, or a decimal number.
 * A four part value always reads the last field as frames.
 */
export function parseTimecode(value: string, fps = 25): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const rate = Math.max(1, Math.round(Number(fps) || 25))
  if (/^\d+([.,]\d+)?$/.test(trimmed)) return Number(trimmed.replace(',', '.'))
  const parts = trimmed.split(':').map((part) => Number(part.trim().replace(',', '.')))
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0
  if (parts.length >= 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / rate
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** How long a queue job ran, for its finished row: "23m 05s". */
export function jobTime(startedAt: number, finishedAt: number): string {
  if (!startedAt || !finishedAt || finishedAt < startedAt) return ''
  return humanDuration((finishedAt - startedAt) / 1000)
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

export function percent(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`
}

export function baseName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  return name.replace(/\.[^.]+$/, '')
}

export function shortPath(filePath: string, max = 46): string {
  if (filePath.length <= max) return filePath
  const parts = filePath.split(/[\\/]/)
  if (parts.length < 3) return `…${filePath.slice(-max)}`
  return `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`
}
