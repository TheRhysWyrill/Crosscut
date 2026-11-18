// The release folder should hold the installer and nothing else: the unpacked
// app is a local testing build, and `npm run package` puts that in
// D:\TRW\Downloads\Tools\CrossCut instead of inside the repository.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(ROOT, 'release')

for (const name of ['win-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml']) {
  const target = path.join(release, name)
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`[prune] removed release/${name}`)
  }
}
