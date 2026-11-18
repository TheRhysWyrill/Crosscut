// Renders src/assets/donate-qr.png from donation.config.json.
// Run `npm run qr` after changing the donation link.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'donation.config.json'), 'utf8'))
const target = path.join(ROOT, 'src', 'assets', 'donate-qr.png')

fs.mkdirSync(path.dirname(target), { recursive: true })
await QRCode.toFile(target, config.url, {
  width: 480,
  margin: 1,
  errorCorrectionLevel: 'M',
  color: { dark: '#0b0c0f', light: '#ffffff' },
})
console.log(`[qr] ${config.url} -> ${path.relative(ROOT, target)}`)
