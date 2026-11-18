import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 250)
}

function pipe(child, label, color) {
  const prefix = `\u001b[${color}m[${label}]\u001b[0m `
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(prefix + line + '\n')
    })
  }
}

const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5454', '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(vite)
pipe(vite, 'web', '35')

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

const ready = await waitFor('http://127.0.0.1:5454')
if (!ready) {
  console.error('[dev] Vite did not start in time')
  shutdown(1)
}

const electronBin = path.join(
  root,
  'node_modules',
  'electron',
  process.platform === 'win32' ? 'dist/electron.exe' : 'dist/Electron.app/Contents/MacOS/Electron',
)

const electron = spawn(electronBin, [root], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5454', CUTWRIGHT_DEVTOOLS: process.env.CUTWRIGHT_DEVTOOLS ?? '0' },
})
children.push(electron)
pipe(electron, 'app', '36')

electron.on('exit', () => shutdown(0))
vite.on('exit', (code) => {
  if (!shuttingDown && code) shutdown(code)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
