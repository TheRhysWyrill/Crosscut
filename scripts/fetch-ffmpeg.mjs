// Downloads the FFmpeg/ffprobe pair that ships inside CrossCut.
//
// `npm run ffmpeg` refreshes it: the gyan.dev "release essentials" build is a
// full GPLv3 static build (libx264, libx265, xfade, loudnorm and everything
// else the app uses), rebuilt as upstream releases land. Run it before `dist`
// to ship a newer FFmpeg; the app never needs a system FFmpeg.
//
//   node scripts/fetch-ffmpeg.mjs           # download if missing
//   node scripts/fetch-ffmpeg.mjs --force   # always download the latest
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'vendor', 'ffmpeg', 'win32-x64')
const BUILD_URL =
  process.env.FFMPEG_BUILD_URL || 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
// gyan.dev refuses some datacenter addresses, which is how a CI download fails
// while the same URL works on a desktop. The identical archive is mirrored on
// GitHub, so fall back to it instead of failing the build.
const MIRROR_URL =
  process.env.FFMPEG_MIRROR_URL ||
  'https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip'
const SOURCE_URL = 'https://www.gyan.dev/ffmpeg/builds/#sources'
const force = process.argv.includes('--force')

const BINARIES = ['ffmpeg.exe', 'ffprobe.exe']

function ready() {
  return BINARIES.every((name) => fs.existsSync(path.join(DEST, name)))
}

if (process.platform !== 'win32' && !process.env.FFMPEG_BUILD_URL) {
  console.log('[ffmpeg] the bundled build is Windows-only; nothing to do on', process.platform)
  process.exit(0)
}

if (ready() && !force) {
  const version = readVersion()
  console.log(`[ffmpeg] already bundled${version ? ` (${version})` : ''} — use --force to refresh`)
  process.exit(0)
}

function readVersion() {
  try {
    const res = spawnSync(path.join(DEST, 'ffmpeg.exe'), ['-hide_banner', '-version'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const first = (res.stdout || '').split(/\r?\n/)[0] || ''
    return first.replace(/^ffmpeg version\s*/i, '').split(' Copyright')[0].trim()
  } catch {
    return ''
  }
}

async function download(url, target) {
  console.log(`[ffmpeg] downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  let seen = 0
  let nextReport = 0
  const out = fs.createWriteStream(target)
  for await (const chunk of response.body) {
    seen += chunk.length
    if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
    const percent = total ? Math.floor((seen / total) * 100) : 0
    if (percent >= nextReport) {
      nextReport = percent + 10
      process.stdout.write(`\r[ffmpeg] ${total ? `${percent}%` : `${Math.round(seen / 1048576)} MB`}   `)
    }
  }
  await new Promise((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })
  process.stdout.write('\n')
}

function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true })
  if (process.platform === 'win32') {
    // Windows ships bsdtar, which reads zip archives. PowerShell 7's
    // Expand-Archive throws "Cannot find an overload for ExtractToDirectory"
    // on some .NET versions, so try tar first and keep it only as a fallback.
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(systemTar)) {
      const res = spawnSync(systemTar, ['-xf', zip, '-C', into], { stdio: 'inherit' })
      if (res.status === 0) return
      console.log('[ffmpeg] tar could not extract the archive; trying Expand-Archive')
    }
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${into}' -Force`],
      { stdio: 'inherit' },
    )
    if (res.status !== 0) throw new Error('Expand-Archive failed')
    return
  }
  const res = spawnSync('unzip', ['-q', '-o', zip, '-d', into], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('unzip failed — install unzip or extract manually')
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscut-ffmpeg-'))
const zip = path.join(scratch, 'ffmpeg.zip')
const unpacked = path.join(scratch, 'unpacked')

try {
  let archive = zip
  try {
    await download(BUILD_URL, zip)
  } catch (err) {
    if (process.env.FFMPEG_MIRROR_URL === 'none') throw err
    console.log(`[ffmpeg] ${err.message}; trying the GitHub mirror`)
    archive = path.join(scratch, 'ffmpeg-mirror.zip')
    await download(MIRROR_URL, archive)
  }
  unzip(archive, unpacked)

  const buildDir = fs
    .readdirSync(unpacked, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(unpacked, entry.name))
    .find((dir) => fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe')))
  if (!buildDir) throw new Error('ffmpeg.exe was not in the downloaded archive')

  fs.mkdirSync(DEST, { recursive: true })
  for (const name of BINARIES) {
    fs.copyFileSync(path.join(buildDir, 'bin', name), path.join(DEST, name))
  }

  // The GPL text has to travel with the binaries.
  for (const name of ['LICENSE', 'LICENSE.txt', 'COPYING.GPLv3']) {
    const from = path.join(buildDir, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DEST, 'LICENSE.txt'))
  }

  const version = readVersion()
  fs.writeFileSync(
    path.join(DEST, 'NOTICE.txt'),
    [
      'Bundled FFmpeg for CrossCut',
      '',
      `Build:      ${BUILD_URL}`,
      `Downloaded: ${new Date().toISOString().slice(0, 10)}`,
      `Version:    ${version || 'unknown'}`,
      '',
      'This build contains FFmpeg and ffprobe, licensed under the GNU General',
      'Public License version 3 (see LICENSE.txt). It is a static GPL build that',
      'includes libx264 and libx265.',
      '',
      'Corresponding source code:',
      `  ${SOURCE_URL}`,
      '  https://git.ffmpeg.org/ffmpeg.git',
      '  https://code.videolan.org/videolan/x264',
      '  https://bitbucket.org/multicoreware/x265_git',
      '',
      'FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.',
      '',
    ].join('\n'),
  )
  console.log(`[ffmpeg] bundled ${version || 'FFmpeg'} into ${path.relative(ROOT, DEST)}`)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
