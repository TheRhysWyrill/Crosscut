export interface VideoStream {
  index: number
  codec: string
  codecLong: string
  profile: string
  width: number
  height: number
  pixFmt: string
  fps: number
  rFps: number
  bitrate: number
  frames: number
  colorSpace: string
  colorTransfer: string
  colorPrimaries: string
  colorRange: string
  fieldOrder: string
  timeBase: string
  duration: number
  rotation: number
}

export interface AudioStream {
  index: number
  codec: string
  codecLong: string
  sampleRate: number
  channels: number
  channelLayout: string
  bitrate: number
  duration: number
  language: string
  streams: number
}

export interface AudioTrack {
  index: number
  codec: string
  channels: number
  language: string
  title: string
}

export interface MediaInfo {
  path: string
  name: string
  dir: string
  size: number
  duration: number
  startTime: number
  bitrate: number
  formatName: string
  formatLong: string
  video: VideoStream | null
  audio: AudioStream | null
  subtitleCount: number
  chapters: { start: number; end: number; title: string }[]
  streamCount: number
  audioTracks: AudioTrack[]
  isAudioOnly: boolean
  isImage: boolean
}

export interface Segment {
  id: string
  start: number
  end: number
  label: string
  enabled: boolean
  /** Per-fragment audio override: '' follows the export setting, else `track:<index>`. */
  audio?: string
}

export interface SyncReport {
  duration: number
  videoDuration: number
  audioDuration: number
  deltaMs: number
  ok: boolean
  size: number
}

export interface Preset {
  id: string
  label: string
  group: string
  family: string
  ext: string
  note?: string
  audioOnly?: boolean
  qualityKind?: 'crf' | 'prores' | 'size' | 'none'
  defaultQuality?: number
  defaultSpeed?: string
  defaultAudioBitrate?: number
  preferHardware?: boolean
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled' | 'interrupted'

export interface Job {
  id: string
  type: 'cut' | 'concat' | 'mux' | 'analyze' | 'proxy' | 'waveform' | 'verify' | 'tool'
  label: string
  status: JobStatus
  progress: number
  detail: Record<string, unknown>
  stage: string
  params: Record<string, unknown>
  outputs: { path: string; size: number; duration: number; sync?: SyncReport }[]
  error: string
  log: string[]
  result: Record<string, unknown> | null
  createdAt: number
  startedAt: number
  finishedAt: number
}

export interface QueueSnapshot {
  running: boolean
  concurrency: number
  active: number
  stats: Record<string, number>
  jobs: Job[]
}

export interface Tools {
  ok: boolean
  ffmpeg: string
  ffprobe: string
  source: string
  version: string
  checkedAt: number
  hardware: { nvenc: boolean; qsv: boolean; amf: boolean; av1: boolean }
  encoders: Record<string, boolean>
}

export interface AppSettings {
  ffmpegDir: string
  outDir: string
  /** Empty means the default folder under the app data directory. */
  projectsDir: string
  concurrency: number
  lastDir: string
  hardware: string
  accent: string
  /** Whether the queue panel is expanded. */
  queueOpen: boolean
  /** The project that was open last, so it can be reopened at launch. */
  lastProjectId: string
  /** Load the last open project automatically at launch. Off by default. */
  reopenLastProject: boolean
  /** The walkthrough has been seen once. */
  seenTour: boolean
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
  size: number
  mtime: number
  media: boolean
}

export interface FsListing {
  dir: string
  parent: string | null
  entries: FsEntry[]
  allCount: number
}

export interface ExportOptions {
  quality: number
  speed: string
  audioBitrate: number
  scale: string
  fps: string
  hardware: string
  audio: 'auto' | 'copy' | 'none' | 'transcode'
  loudnorm: boolean
  gifFps: number
}

export type CutMode = 'lossless' | 'smart' | 'encode'
export type SliceMode = 'none' | 'parts' | 'duration'

/** Everything an export needs, so a project can be saved and re-run later. */
export interface ExportConfig {
  mode: CutMode
  output: 'single' | 'separate'
  presetId: string
  presetLabel: string
  presetExt: string
  options: ExportOptions
  container: string
  nameTemplate: string
  outDir: string
  /** 'first' | 'all' | 'both' | `track:<stream index>` */
  audioMode: string
  /** Rewrites the MP4 once to move its index to the front. Off by default. */
  faststart: boolean
  /** What happens at each join inside a merged export. */
  transition: 'none' | 'dip' | 'blur' | 'wipe'
  /** Where transitions land: every join, only the opening/closing frames, or both. */
  transitionScope: 'joins' | 'ends' | 'both'
  /** Length of that transition, in seconds. */
  transitionSeconds: number
  /** Copy subtitles and chapters into an MKV alongside the picture. */
  keepExtras: boolean
  sliceMode: SliceMode
  sliceParts: number
  sliceMinutes: number
}

export interface ProjectClip {
  path: string
  offset: number
  duration: number
}

export interface SavedProject {
  id: string
  name: string
  source: string
  duration: number
  clips: ProjectClip[]
  segments: Segment[]
  audioTracks: AudioTrack[]
  /** Chosen audio stream per recording, keyed by source path. */
  tracks?: Record<string, number>
  export: ExportConfig
  createdAt: number
  updatedAt: number
}

export interface JobInput {
  type: Job['type']
  label: string
  params: Record<string, unknown>
}

export interface AnalyzeResult {
  kind: string
  duration: number
  silences?: { start: number; end: number }[]
  speech?: { start: number; end: number }[]
  black?: { start: number; end: number }[]
  scenes?: number[]
  suggestions?: { kind: string; start?: number; end?: number; time?: number; label: string }[]
}
