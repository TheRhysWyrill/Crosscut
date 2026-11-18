import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// Draws the CrossCut mark: two crossed film strips on a dark tile, one amber and
// one parchment, with sprocket holes and a keyline where they cross.

const ACCENT = process.env.CROSSCUT_ACCENT ?? process.env.CUTWRIGHT_ACCENT ?? '#f0a33c'
const OUT_DIR = path.resolve('build')

const TILE_TOP = [0x19, 0x1b, 0x22]
const TILE_BOTTOM = [0x0a, 0x0b, 0x0e]
const PARCHMENT = [0xf3, 0xee, 0xe4]

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16))
}

function mix(a, b, amount) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * amount))
}

const accentRgb = hexToRgb(ACCENT)
const accentEdge = mix(accentRgb, [0, 0, 0], 0.35)

function insideRounded(x, y, size, radius) {
  const left = radius
  const right = size - radius
  if (x >= left && x <= right) return y >= 0 && y <= size
  if (y >= left && y <= right) return x >= 0 && x <= size
  const cx = x < left ? left : right
  const cy = y < left ? left : right
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** Measurements of one film strip, scaled to the tile. */
function stripShape(size) {
  return {
    halfLength: size * 0.4,
    halfWidth: size * 0.1,
    holeHalfW: size * 0.017,
    holeHalfH: size * 0.02,
    holeOffset: size * 0.1 - size * 0.028,
    spacing: size * 0.06,
    outline: size * 0.016,
    // Below roughly 32px the sprockets only muddy the shape.
    holes: size >= 40,
  }
}

function toLocal(x, y, size, angle) {
  const centre = size / 2
  const dx = x - centre
  const dy = y - centre
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos }
}

function inStrip(u, v, shape) {
  if (Math.abs(u) > shape.halfLength || Math.abs(v) > shape.halfWidth) return false
  if (!shape.holes) return true
  for (const side of [-1, 1]) {
    const edge = side * shape.holeOffset
    if (Math.abs(v - edge) > shape.holeHalfH) continue
    const nearest = Math.round(u / shape.spacing) * shape.spacing
    if (Math.abs(u - nearest) <= shape.holeHalfW) return false
  }
  return true
}

function inOutline(u, v, shape) {
  const reach = shape.outline
  return Math.abs(u) <= shape.halfLength + reach && Math.abs(v) <= shape.halfWidth + reach
}

function renderRGBA(size) {
  const samples = 4
  const data = Buffer.alloc(size * size * 4)
  const radius = size * 0.23
  const shape = stripShape(size)
  const angleA = -Math.PI / 4
  const angleB = Math.PI / 4

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = px + (sx + 0.5) / samples
          const y = py + (sy + 0.5) / samples
          if (!insideRounded(x, y, size, radius)) continue
          covered += 1

          const t = y / Math.max(1, size - 1)
          let colour = mix(TILE_TOP, TILE_BOTTOM, t)

          const a = toLocal(x, y, size, angleA)
          if (inStrip(a.u, a.v, shape)) {
            // A little shading across the width so the strip reads as a surface.
            const edge = Math.min(1, Math.abs(a.v) / shape.halfWidth)
            colour = mix(accentRgb, accentEdge, edge * edge * 0.55)
          }

          const c = toLocal(x, y, size, angleB)
          if (inStrip(c.u, c.v, shape)) {
            colour = PARCHMENT
          } else if (inOutline(c.u, c.v, shape)) {
            // Keyline: the tile shows through wherever the second strip passes over the first.
            colour = mix(TILE_TOP, TILE_BOTTOM, t)
          }

          r += colour[0]
          g += colour[1]
          b += colour[2]
        }
      }

      const index = (py * size + px) * 4
      const total = samples * samples
      if (covered === 0) {
        data[index + 3] = 0
        continue
      }
      data[index] = Math.round(r / covered)
      data[index + 1] = Math.round(g / covered)
      data[index + 2] = Math.round(b / covered)
      data[index + 3] = Math.round((covered / total) * 255)
    }
  }
  return data
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, body])), 0)
  return Buffer.concat([length, typeBuffer, body, crc])
}

function encodePNG(size) {
  const pixels = renderRGBA(size)
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePNG(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const entries = []
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const ico = buildIco([16, 24, 32, 48, 64, 128, 256])
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePNG(512))
fs.writeFileSync(path.join(OUT_DIR, 'icon-32.png'), encodePNG(32))
console.log(`icon.ico ${(ico.length / 1024).toFixed(1)} KB · icon.png 512px · accent ${ACCENT}`)
