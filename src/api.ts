import type {
  AnalyzeResult,
  AppSettings,
  FsListing,
  Job,
  MediaInfo,
  Preset,
  QueueSnapshot,
  SavedProject,
  Segment,
  SyncReport,
  Tools,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${response.status})`
    throw new Error(message)
  }
  return data as T
}

const get = <T,>(url: string) => request<T>(url)
const post = <T,>(url: string, body?: unknown) =>
  request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  health: () =>
    get<{
      ok: boolean
      tools: Tools
      settings: AppSettings
      dataDir: string
      platform: string
      projectsDir: string
      defaultProjectsDir: string
      appDir: string
    }>('/api/health'),
  saveSettings: (patch: Partial<AppSettings>) =>
    post<{ settings: AppSettings; tools: Tools; projectsDir: string; defaultProjectsDir: string; appDir: string }>(
      '/api/settings',
      patch,
    ),
  refreshTools: () => post<{ tools: Tools }>('/api/settings/refresh-tools'),

  roots: () => get<{ roots: { label: string; path: string }[]; lastDir: string }>('/api/fs/roots'),
  listDir: (dir: string, filter: 'media' | 'all' = 'media') =>
    get<FsListing>(`/api/fs/list?path=${encodeURIComponent(dir)}&filter=${filter}`),
  reveal: (path: string) => post<{ ok: boolean }>('/api/fs/reveal', { path }),

  probe: (path: string) => post<{ info: MediaInfo }>('/api/probe', { path }),
  keyframes: (path: string, window?: { start: number; end: number }) =>
    post<{ frames: number[] }>('/api/keyframes', window ? { path, start: window.start, end: window.end } : { path }),
  waveform: (path: string, start: number, end: number, buckets = 2000, track = 0) =>
    get<{
      state: string
      progress: number
      peaks: number[] | null
      error: string
      start: number
      end: number
      maxWindow?: number
    }>(
      `/api/media/waveform?path=${encodeURIComponent(path)}&start=${start.toFixed(3)}&end=${end.toFixed(3)}&buckets=${buckets}&track=${track}`,
    ),
  overview: (path: string, buckets = 4000, track = 0) =>
    get<{ state: string; progress: number; peaks: number[] | null; error: string }>(
      `/api/media/overview?path=${encodeURIComponent(path)}&buckets=${buckets}&track=${track}`,
    ),
  audioTrack: (path: string, track: number, start = 0, length = 600) =>
    get<{ state: string; progress: number; path: string | null; error: string; start: number; end: number }>(
      `/api/media/audiotrack?path=${encodeURIComponent(path)}&track=${track}&start=${start}&length=${length}`,
    ),
  filmstrip: (path: string, start: number, end: number, count: number) =>
    get<{ frames: { time: number; dataUrl: string }[] }>(
      `/api/media/filmstrip?path=${encodeURIComponent(path)}&start=${start}&end=${end}&count=${count}`,
    ),

  presets: () =>
    get<{ presets: Preset[]; hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean } }>('/api/presets'),

  queue: () => get<QueueSnapshot>('/api/queue'),
  addJob: (job: { type: Job['type']; label: string; params: Record<string, unknown> }) =>
    post<{ job: Job }>('/api/queue/jobs', job),
  addBatch: (jobs: { type: Job['type']; label: string; params: Record<string, unknown> }[]) =>
    post<{ jobs: Job[] }>('/api/queue/batch', { jobs }),
  startQueue: () => post<QueueSnapshot>('/api/queue/start'),
  pauseQueue: () => post<QueueSnapshot>('/api/queue/pause'),
  cancelAll: () => post<QueueSnapshot>('/api/queue/cancel-all'),
  setConcurrency: (concurrency: number) => post<QueueSnapshot>('/api/queue/concurrency', { concurrency }),
  reorder: (ids: string[]) => post<QueueSnapshot>('/api/queue/reorder', { ids }),
  clearQueue: (statuses?: string[]) => post<QueueSnapshot>('/api/queue/clear', { statuses }),
  jobAction: (id: string, action: 'cancel' | 'retry' | 'remove') =>
    post<{ ok: boolean; queue: QueueSnapshot }>(`/api/queue/${id}/${action}`),
  resumeInterrupted: () => post<{ resumed: number; queue: QueueSnapshot }>('/api/queue/resume-interrupted'),

  verify: (path: string) => post<SyncReport & { path: string }>('/api/verify', { path }),
  ffmpegUpdateCheck: () =>
    get<{ current: string; latest: string; updateAvailable: boolean; managed: boolean; url: string; error?: string }>(
      '/api/ffmpeg/update-check',
    ),
  startFfmpegUpdate: () =>
    post<{ job: Job; queue: QueueSnapshot }>('/api/ffmpeg/update'),

  projects: () => get<{ projects: SavedProject[] }>('/api/projects'),
  saveProject: (project: Partial<SavedProject>) =>
    post<{ project: SavedProject }>('/api/projects', project as Record<string, unknown>),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  cutlists: () => get<Record<string, { segments: Segment[]; updatedAt: number; duration: number }>>('/api/cutlists'),
  saveCutlist: (path: string, segments: Segment[], duration: number) =>
    post<{ ok: boolean }>('/api/cutlists', { path, segments, duration }),

  compareSync: (video: string, audio: string) =>
    post<{
      video: { path: string; duration: number }
      audio: { path: string; duration: number; codec: string; channels: number }
      driftSeconds: number
      driftMs: number
      ppm: number
      suggestedRatio: number
      suggestion: string
    }>('/api/sync/compare', { video, audio }),

  analyze: (params: Record<string, unknown>) =>
    post<{ job: Job }>('/api/queue/jobs', { type: 'analyze', label: 'Analyse', params }),

  streamUrl: (path: string) => `/api/stream?path=${encodeURIComponent(path)}`,
  thumbUrl: (path: string, time: number, width = 160) =>
    `/api/media/thumb?path=${encodeURIComponent(path)}&time=${time.toFixed(3)}&w=${width}`,
}

export type { AnalyzeResult, SyncReport }
