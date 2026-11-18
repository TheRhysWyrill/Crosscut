// Builds the unpacked app for local testing straight into the tools folder,
// with the app files at the top level instead of inside `win-unpacked`.
//
// electron-builder always nests its --dir output, so this runs the build into a
// staging path and then lifts the contents up one level.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = process.env.CROSSCUT_LOCAL_DIR || 'D:/TRW/Downloads/Tools/CrossCut'

// Only ever wipe a folder that looks like a previous CrossCut build.
if (fs.existsSync(TARGET)) {
  const entries = fs.readdirSync(TARGET)
  // Compare the executable case-insensitively: a folder built before the rename
  // still holds `Crosscut.exe`, and that is just as much a previous build.
  const looksLikeOurs =
    entries.length === 0 ||
    entries.includes('win-unpacked') ||
    entries.some((name) => name.toLowerCase() === 'crosscut.exe')
  if (!looksLikeOurs) {
    console.error(
      `[package] ${TARGET} holds files that are not a CrossCut build, so it was left alone.`,
    )
    process.exit(1)
  }
  try {
    fs.rmSync(TARGET, { recursive: true, force: true })
  } catch (err) {
    console.error(`[package] could not clear ${TARGET} (is the app running?): ${err.message}`)
    process.exit(1)
  }
}

const build = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', '--dir', `-c.directories.output=${TARGET}`],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
)
if (build.status !== 0) process.exit(build.status ?? 1)

const unpacked = path.join(TARGET, 'win-unpacked')
if (!fs.existsSync(unpacked)) {
  console.error('[package] the build did not produce win-unpacked')
  process.exit(1)
}

for (const entry of fs.readdirSync(unpacked)) {
  fs.renameSync(path.join(unpacked, entry), path.join(TARGET, entry))
}
fs.rmSync(unpacked, { recursive: true, force: true })
for (const name of ['builder-debug.yml', 'builder-effective-config.yaml']) {
  fs.rmSync(path.join(TARGET, name), { force: true })
}

console.log(`[package] app ready at ${path.join(TARGET, 'CrossCut.exe')}`)
