export const DEFAULT_ACCENT = '#f0a33c'

export const ACCENT_PRESETS = [
  { name: 'Amber', value: '#f0a33c' },
  { name: 'Blue', value: '#5aa9f0' },
  { name: 'Teal', value: '#3fc4b8' },
  { name: 'Green', value: '#57c07a' },
  { name: 'Purple', value: '#a58bff' },
  { name: 'Pink', value: '#f07ab0' },
  { name: 'Red', value: '#ef6b6b' },
  { name: 'Slate', value: '#93a4bd' },
]

function parseHex(value: string): [number, number, number] | null {
  const clean = value.trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16)) as [number, number, number]
}

function mix(rgb: [number, number, number], target: [number, number, number], amount: number): [number, number, number] {
  return rgb.map((value, index) => Math.round(value + (target[index] - value) * amount)) as [number, number, number]
}

const css = (rgb: [number, number, number]) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`

/** Pushes the chosen accent, and shades derived from it, into the CSS variables. */
export function applyAccent(value: string | undefined): void {
  const rgb = parseHex(value ?? '') ?? parseHex(DEFAULT_ACCENT)!
  const strong = mix(rgb, [0, 0, 0], 0.18)
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  const root = document.documentElement
  root.style.setProperty('--accent', css(rgb))
  root.style.setProperty('--accent-strong', css(strong))
  root.style.setProperty('--accent-ink', luminance > 0.55 ? '#141008' : '#f5f7fb')
  root.style.setProperty('--accent-soft', `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.14)`)
}
