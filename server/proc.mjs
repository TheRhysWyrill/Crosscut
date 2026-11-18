import { spawn } from 'node:child_process'

/**
 * Spawn a process and stream its stdout/stderr line by line.
 * Returns the child plus a promise for completion.
 */
export function spawnLines(command, args, { onLine, onStdoutLine, cwd, env } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
  })

  const tail = []
  let stdoutBuffer = ''
  let stderrBuffer = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) onStdoutLine?.(line)
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      tail.push(line)
      if (tail.length > 400) tail.shift()
      onLine?.(line)
    }
  })

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      tail.push(String(err.message))
      resolve({ code: -1, error: err.message, tail })
    })
    child.on('close', (code, signal) => {
      if (stderrBuffer.trim()) tail.push(stderrBuffer.trim())
      resolve({ code: code ?? (signal ? -1 : 0), signal, tail })
    })
  })

  return { child, done }
}

export function killTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref()
    } catch {
      /* ignore */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Run ffmpeg with machine-readable progress on stdout.
 * Progress lines look like: frame=12 / out_time_us=40000 / speed=1.2x / progress=continue
 */
export function runFfmpeg({
  ffmpeg,
  args,
  totalSec = 0,
  onProgress,
  onLog,
  onChild,
}) {
  const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args]
  const started = Date.now()
  let outTime = 0
  let frame = 0
  let speed = ''
  let fps = 0

  const { child, done } = spawnLines(ffmpeg, full, {
    onStdoutLine(line) {
      const eq = line.indexOf('=')
      if (eq < 0) return
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1)
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micro = Number(value)
        if (Number.isFinite(micro)) outTime = Math.max(outTime, micro / 1_000_000)
      } else if (key === 'out_time') {
        const parts = value.split(':').map(Number)
        if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
          outTime = Math.max(outTime, parts[0] * 3600 + parts[1] * 60 + parts[2])
        }
      } else if (key === 'frame') {
        frame = Number(value) || frame
      } else if (key === 'fps') {
        fps = Number(value) || fps
      } else if (key === 'speed') {
        speed = value.trim()
      } else if (key === 'progress') {
        const elapsed = (Date.now() - started) / 1000
        const percent = totalSec > 0 ? Math.min(100, (outTime / totalSec) * 100) : 0
        onProgress?.({
          percent,
          seconds: outTime,
          totalSec,
          frame,
          fps,
          speed,
          elapsed,
          eta:
            totalSec > 0 && outTime > 0
              ? Math.max(0, ((totalSec - outTime) / outTime) * elapsed)
              : 0,
        })
      }
    },
    onLine(line) {
      const trimmed = line.trim()
      if (trimmed) onLog?.(trimmed)
    },
  })

  onChild?.(child)
  return { child, done }
}

export function runCapture(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 64 * 1024 * 1024) {
        stdout = stdout.slice(0, 64 * 1024 * 1024)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}
