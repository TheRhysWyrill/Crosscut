import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { DATA_DIR, readJson, writeJson } from './config.mjs'
import { killTree } from './proc.mjs'
import { runJob } from './tasks.mjs'

const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export class JobQueue extends EventEmitter {
  constructor() {
    super()
    this.jobs = []
    this.active = new Set()
    this.running = false
    this.concurrency = 1
    this.notifyTimer = null
    this.saveTimer = null
    this.load()
  }

  load() {
    const stored = readJson(QUEUE_FILE, { jobs: [] })
    this.jobs = (stored.jobs ?? []).map((job) => ({
      ...job,
      status: job.status === 'running' ? 'interrupted' : job.status,
      child: undefined,
      _cancel: false,
    }))
  }

  persist() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const serialisable = this.jobs
        .filter((job) => job.status !== 'done' || job.outputs?.length)
        .slice(-200)
        .map(({  _cancel, child, ...rest }) => rest)
      writeJson(QUEUE_FILE, { jobs: serialisable })
    }, 400)
  }

  notify(immediate = false) {
    this.persist()
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.emit('update', this.snapshot())
      return
    }
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.emit('update', this.snapshot())
    }, 120)
  }

  snapshot() {
    return {
      running: this.running,
      concurrency: this.concurrency,
      active: this.active.size,
      stats: this.stats(),
      jobs: this.jobs.map((job) => this.publicJob(job)),
    }
  }

  stats() {
    const counts = { queued: 0, running: 0, done: 0, error: 0, canceled: 0, interrupted: 0 }
    for (const job of this.jobs) counts[job.status] = (counts[job.status] ?? 0) + 1
    return counts
  }

  publicJob(job) {
    return {
      id: job.id,
      type: job.type,
      label: job.label,
      status: job.status,
      progress: job.progress ?? 0,
      detail: job.detail ?? {},
      stage: job.stage ?? '',
      params: job.params,
      outputs: job.outputs ?? [],
      error: job.error ?? '',
      log: job.log ?? [],
      result: job.result ?? null,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? 0,
      finishedAt: job.finishedAt ?? 0,
    }
  }

  add({ type, label, params }) {
    const job = {
      id: crypto.randomUUID(),
      type,
      label: label || type,
      params,
      status: 'queued',
      progress: 0,
      detail: {},
      stage: '',
      outputs: [],
      result: null,
      error: '',
      log: [],
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      _cancel: false,
    }
    this.jobs.push(job)
    this.notify(true)
    if (this.running) this.pump()
    return this.publicJob(job)
  }

  start() {
    this.running = true
    this.notify(true)
    this.pump()
  }

  pause() {
    this.running = false
    this.notify(true)
  }

  async execute(job) {
    job.status = 'running'
    job.startedAt = Date.now()
    job.progress = 0
    job.error = ''
    job.log = []
    this.notify(true)

    let lastLogNotify = 0
    const ctx = {
      progress: (percent, detail) => {
        job.progress = clampPercent(percent)
        if (detail) job.detail = { ...job.detail, ...detail }
        this.notify()
      },
      stage: (stage) => {
        job.stage = stage
        this.notify()
      },
      log: (line) => {
        job.log.push(line)
        if (job.log.length > 600) job.log.shift()
        const now = Date.now()
        if (now - lastLogNotify > 800) {
          lastLogNotify = now
          this.notify()
        }
      },
      onChild: (child) => {
        job.child = child
      },
      isCanceled: () => job._cancel,
      settings: null,
    }

    try {
      const result = (await runJob(job, ctx)) ?? {}
      if (job._cancel) {
        job.status = 'canceled'
      } else {
        job.status = 'done'
        job.progress = 100
        job.outputs = result.outputs ?? []
        job.result = result.result ?? null
      }
    } catch (err) {
      if (job._cancel) {
        job.status = 'canceled'
      } else {
        job.status = 'error'
        job.error = err?.message ?? String(err)
        ctx.log(`ERROR: ${job.error}`)
      }
    } finally {
      delete job.child
      job.finishedAt = Date.now()
      this.notify(true)
    }
  }

  pump() {
    if (!this.running) return
    while (this.active.size < this.concurrency) {
      const next = this.jobs.find((job) => job.status === 'queued')
      if (!next) break
      this.active.add(next.id)
      this.execute(next).finally(() => {
        this.active.delete(next.id)
        this.pump()
      })
    }
    if (this.active.size === 0 && this.running) {
      const pending = this.jobs.some((job) => job.status === 'queued')
      if (!pending) {
        this.running = false
        this.notify(true)
      }
    }
  }

  cancel(id) {
    const job = this.jobs.find((entry) => entry.id === id)
    if (!job) return false
    job._cancel = true
    if (job.status === 'queued' || job.status === 'interrupted') {
      job.status = 'canceled'
      job.finishedAt = Date.now()
      this.notify(true)
      return true
    }
    if (job.child) killTree(job.child)
    this.notify(true)
    return true
  }

  cancelAll() {
    for (const job of this.jobs) {
      if (job.status === 'queued' || job.status === 'running') this.cancel(job.id)
    }
    this.running = false
    this.notify(true)
  }

  /** Requeue everything a previous session left half-done. */
  resumeInterrupted() {
    let resumed = 0
    for (const job of this.jobs) {
      if (job.status !== 'interrupted') continue
      job.status = 'queued'
      job.progress = 0
      job.error = ''
      job._cancel = false
      job.log = []
      job.detail = {}
      job.result = null
      job.finishedAt = 0
      job.startedAt = 0
      resumed += 1
    }
    if (resumed) {
      this.notify(true)
      this.start()
    }
    return resumed
  }

  retry(id) {
    const job = this.jobs.find((entry) => entry.id === id)
    if (!job) return false
    job.status = 'queued'
    job.progress = 0
    job.error = ''
    job._cancel = false
    job.log = []
    job.detail = {}
    job.result = null
    job.finishedAt = 0
    job.startedAt = 0
    this.notify(true)
    if (this.running) this.pump()
    return true
  }

  remove(id) {
    const index = this.jobs.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    const [job] = this.jobs.splice(index, 1)
    if (job?.child) killTree(job.child)
    this.notify(true)
    return true
  }

  clear(statuses = ['done', 'canceled', 'error', 'interrupted']) {
    this.jobs = this.jobs.filter((job) => !statuses.includes(job.status))
    this.notify(true)
  }

  reorder(ids) {
    const map = new Map(this.jobs.map((job) => [job.id, job]))
    const reordered = ids.map((id) => map.get(id)).filter(Boolean)
    for (const job of this.jobs) if (!ids.includes(job.id)) reordered.push(job)
    this.jobs = reordered
    this.notify(true)
  }

  setConcurrency(value) {
    const next = Math.max(1, Math.min(8, Number(value) || 1))
    this.concurrency = next
    this.notify(true)
    if (this.running) this.pump()
    return next
  }
}
