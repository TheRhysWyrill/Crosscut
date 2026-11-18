import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type {
  AppSettings,
  ExportConfig,
  Job,
  JobInput,
  MediaInfo,
  Preset,
  QueueSnapshot,
  SavedProject,
  Segment,
  Tools,
} from './types'
import { baseName, bytes, humanDuration, shortPath, shortTimecode, timecode } from './format'
import { buildCutJobs } from './batch'
import { applyAccent, DEFAULT_ACCENT } from './theme'
import { desktop, IDLE_UPDATE, isDesktop, pickMedia, revealPath, type UpdateStatus } from './desktop'
import { hdrKind } from './hdr'
import {
  frameStep,
  invert,
  keptDuration,
  normalizePartition,
  removeMarker,
  setEnabled,
  splitAt,
  trimAfter,
  trimBefore,
  uid,
} from './project'
import {
  appendSegments,
  clipSpans,
  clipWindows,
  locateClip,
  remapSegments,
  timelineDuration,
} from './timeline'
import Player from './components/Player'
import TrackPicker from './components/TrackPicker'
import Timeline, { type TimelineView } from './components/Timeline'
import TimelineScrollbar from './components/TimelineScrollbar'
import ProjectPanel from './components/ProjectPanel'
import ExportPanel from './components/ExportPanel'
import ConvertPanel from './components/ConvertPanel'
import SyncPanel from './components/SyncPanel'
import AnalyzePanel from './components/AnalyzePanel'
import JoinPanel from './components/JoinPanel'
import ProjectsPanel from './components/ProjectsPanel'
import QueuePanel from './components/QueuePanel'
import SettingsModal, { type PathHints } from './components/SettingsModal'
import TimecodeField from './components/TimecodeField'
import JobLog from './components/JobLog'
import AboutModal from './components/AboutModal'
import QuitModal from './components/QuitModal'
import ShortcutsModal from './components/ShortcutsModal'

type Tab = 'project' | 'export' | 'projects' | 'convert' | 'join' | 'analyze' | 'sync'

const TABS: { id: Tab; label: string }[] = [
  { id: 'project', label: 'Cuts' },
  { id: 'projects', label: 'Projects' },
  { id: 'export', label: 'Export' },
]

// Kept out of the tab strip: these tools are used rarely enough to live in a menu.
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]

const MORE_TABS: { id: Tab; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'join', label: 'Join' },
  { id: 'analyze', label: 'Analyse' },
  { id: 'sync', label: 'Sync' },
]

const DEFAULT_EXPORT: ExportConfig = {
  mode: 'lossless',
  output: 'single',
  presetId: 'h264-mp4',
  presetLabel: 'H.264 MP4',
  presetExt: 'mp4',
  options: {
    quality: 20,
    speed: 'veryfast',
    audioBitrate: 192,
    scale: 'source',
    fps: 'source',
    hardware: 'auto',
    audio: 'auto',
    loudnorm: false,
    gifFps: 15,
  },
  container: 'auto',
  nameTemplate: '{name}',
  outDir: '',
  audioMode: 'first',
  faststart: false,
  transition: 'none',
  transitionScope: 'both',
  transitionSeconds: 0.5,
  keepExtras: false,
  sliceMode: 'none',
  sliceParts: 4,
  sliceMinutes: 120,
}

const EMPTY_QUEUE: QueueSnapshot = { running: false, concurrency: 1, active: 0, stats: {}, jobs: [] }
const OVERVIEW_SPAN = 150
const MAX_WAVE_SPAN = 1800
const KEY_WINDOW_MAX = 900

function formatSpan(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(2)} h`
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} min`
  return `${seconds.toFixed(1)} s`
}

export default function App() {
  // The project is a sequence of recordings cut on one timeline.
  const [clips, setClips] = useState<MediaInfo[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedMarker, setSelectedMarker] = useState<number | null>(null)
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  const [playhead, setPlayheadState] = useState(0)
  const playheadRef = useRef(0)
  const durationRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  // True while the rail is held: the playhead follows the pointer, the picture waits.
  const [scrubbing, setScrubbing] = useState(false)
  // When the last hold ended, so the waveform read can let the preview start first.
  const scrubReleasedAt = useRef(0)
  useEffect(() => {
    if (!scrubbing) scrubReleasedAt.current = Date.now()
  }, [scrubbing])
  const [view, setView] = useState<TimelineView>({ start: 0, end: 60 })
  const [snap, setSnap] = useState(true)
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [waveWindow, setWaveWindow] = useState<{ start: number; end: number; peaks: number[] } | null>(null)
  const [waveStatus, setWaveStatus] = useState('idle')
  const [overview, setOverview] = useState<number[] | null>(null)
  const [filmstrip, setFilmstrip] = useState<{ time: number; dataUrl: string }[]>([])
  const [queue, setQueue] = useState<QueueSnapshot>(EMPTY_QUEUE)
  const [settings, setSettings] = useState<AppSettings>({
    ffmpegDir: '',
    outDir: '',
    projectsDir: '',
    concurrency: 1,
    lastDir: '',
    hardware: 'auto',
    accent: DEFAULT_ACCENT,
    queueOpen: true,
    lastProjectId: '',
    reopenLastProject: false,
    seenTour: true,
  })
  const [paths, setPaths] = useState<PathHints>({ projectsDir: '', defaultProjectsDir: '', appDir: '' })
  const [accentPreview, setAccentPreview] = useState<string | null>(null)
  const [tools, setTools] = useState<Tools | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [hardware, setHardware] = useState({ nvenc: false, qsv: false, amf: false, av1: false })
  const [tab, setTab] = useState<Tab>('project')
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return undefined
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setMoreOpen(false)
        return
      }
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [moreOpen])
  const [proxyJobId, setProxyJobId] = useState<string | null>(null)
  const [proxies, setProxies] = useState<Record<string, string>>({})
  const [logJobId, setLogJobId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [quitOpen, setQuitOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  // Only the published installer shows the support card, so a local build never does.
  const [supportPrompt, setSupportPrompt] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(IDLE_UPDATE)
  const [queueOpen, setQueueOpen] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null)
  const [exportConfig, setExportConfig] = useState<ExportConfig>(DEFAULT_EXPORT)
  // Each recording keeps its own audio track choice: a two-track capture and a
  // six-track OBS file should not have to share one stream index.
  const [trackByClip, setTrackByClip] = useState<Record<string, number>>({})
  const [previewAudioState, setPreviewAudioState] = useState('idle')
  const [previewAudioProgress, setPreviewAudioProgress] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const waveCache = useRef(new Map<string, number[]>())
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const restoredRef = useRef(false)
  const [, setHistoryTick] = useState(0)

  const clipsRef = useRef<MediaInfo[]>([])
  const segmentsRef = useRef<Segment[]>([])
  const selectedIdRef = useRef<string | null>(null)
  const selectedMarkerRef = useRef<number | null>(null)
  const pendingRef = useRef<Segment[] | null>(null)
  const openingRef = useRef<Set<string>>(new Set())
  const historyRef = useRef<{ past: Segment[][]; future: Segment[][] }>({ past: [], future: [] })
  const toastTimer = useRef<number>(0)

  const duration = useMemo(() => timelineDuration(clips), [clips])

  // The window title (taskbar and Alt-Tab) names the open project, falling back
  // to the first recording before anything has been saved under a name.
  const documentName = useMemo(() => {
    const saved = projects.find((project) => project.id === currentProjectId)
    if (saved?.name) return saved.name
    return clips.length ? baseName(clips[0].path) : ''
  }, [projects, currentProjectId, clips])
  const spans = useMemo(() => clipSpans(clips), [clips])
  const spot = useMemo(() => locateClip(clips, playhead), [clips, playhead])
  // The clip under the playhead drives the preview, the readouts and analysis.
  const active = spot?.span.info ?? null
  const activeIndex = spot?.span.index ?? 0

  /** The stream index one recording previews, analyses and exports with. */
  const trackFor = useCallback(
    (media: MediaInfo | null | undefined) => {
      const tracks = media?.audioTracks ?? []
      const chosen = media ? trackByClip[media.path] : undefined
      if (chosen !== undefined && tracks.some((entry) => entry.index === chosen)) return chosen
      return tracks[0]?.index ?? 0
    },
    [trackByClip],
  )
  const previewTrack = trackFor(active)
  const fps = active?.video?.fps || 25
  const minSpan = useMemo(() => Math.max(0.3, frameStep(fps) * 4), [fps])

  durationRef.current = duration

  // Every seek goes through one clamp, and updates a ref immediately, so a burst
  // of key presses steps by one frame each instead of all starting from the
  // value the last render saw.
  const setPlayhead = useCallback((value: number) => {
    const limit = durationRef.current > 0 ? durationRef.current : Number.POSITIVE_INFINITY
    const next = Math.max(0, Math.min(limit, Number.isFinite(value) ? value : 0))
    playheadRef.current = next
    setPlayheadState(next)
  }, [])

  /**
   * Move the playhead and bring the view with it: a jump is meant to show what
   * it lands on, so the timeline snaps to the new position even when paused.
   */
  const focusTime = useCallback(
    (value: number) => {
      setPlayhead(value)
      const target = playheadRef.current
      setView((current) => {
        const span = current.end - current.start
        const margin = span * 0.04
        if (target > current.start + margin && target < current.end - margin) return current
        const start = Math.max(0, Math.min(Math.max(0, duration - span), target - span / 2))
        if (Math.abs(start - current.start) < 1e-6) return current
        return { start, end: start + span }
      })
    },
    [setPlayhead, duration],
  )

  /** Start or end of the recording the playhead is inside, not the project. */
  const jumpToClip = useCallback(
    (edge: 'start' | 'end') => {
      const found = locateClip(clipsRef.current, playheadRef.current)
      if (!found) return
      focusTime(edge === 'start' ? found.span.start : found.span.end)
    },
    [focusTime],
  )
  const logJob: Job | null = queue.jobs.find((job) => job.id === logJobId) ?? null
  const kept = keptDuration(segments)

  useEffect(() => {
    clipsRef.current = clips
  }, [clips])

  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    selectedMarkerRef.current = selectedMarker
  }, [selectedMarker])

  const notify = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setToast({ text, kind })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 7000 : 4000)
  }, [])

  const notifyError = useCallback((text: string) => notify(text, 'error'), [notify])

  // The chosen accent drives the CSS variables everything else reads.
  useEffect(() => {
    applyAccent(accentPreview ?? settings.accent ?? DEFAULT_ACCENT)
  }, [accentPreview, settings.accent])

  // Electron mirrors document.title into the native window title, which is what
  // Windows shows in the taskbar and Alt-Tab for this frameless window.
  useEffect(() => {
    document.title = documentName ? `${documentName} — CrossCut` : 'CrossCut'
  }, [documentName])

  // The main process holds the window open and asks first. A queue that is
  // still working is the one case that always needs a question; otherwise the
  // window closes immediately unless this is a published build with a card to show.
  const runningJobs = queue.stats.running ?? 0
  const waitingJobs = queue.stats.queued ?? 0
  useEffect(
    () =>
      desktop?.onQuitRequest(() => {
        if (runningJobs + waitingJobs > 0 || supportPrompt) setQuitOpen(true)
        else desktop?.quit()
      }),
    [runningJobs, waitingJobs, supportPrompt],
  )

  // Which build is running, and whether the updater has anything to say.
  useEffect(() => {
    let live = true
    desktop?.info().then((info) => {
      if (live) setSupportPrompt(Boolean(info.support))
    })
    const stop = desktop?.onUpdateStatus((status) => setUpdateStatus(status))
    return () => {
      live = false
      stop?.()
    }
  }, [])

  // The workflow is not guessable from the buttons, so the walkthrough opens by
  // itself once per installation; ? reopens it afterwards.
  useEffect(() => {
    if (!settingsLoaded) return
    if (settings.seenTour) return
    setFirstRun(true)
    setShortcutsOpen(true)
  }, [settingsLoaded, settings.seenTour])

  // ---------------------------------------------------------------- startup
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const health = await api.health()
        if (cancelled) return
        setSettings(health.settings)
        setTools(health.tools)
        setQueueOpen(health.settings.queueOpen !== false)
        setSettingsLoaded(true)
        setPaths({
          projectsDir: health.projectsDir,
          defaultProjectsDir: health.defaultProjectsDir,
          appDir: health.appDir,
        })
        const catalog = await api.presets()
        if (cancelled) return
        setPresets(catalog.presets)
        setHardware(catalog.hardware)
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setSettingsLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [notifyError])

  useEffect(() => {
    const events = new EventSource('/api/events')
    events.addEventListener('queue', (event) => {
      try {
        setQueue(JSON.parse((event as MessageEvent).data))
      } catch {
        /* ignore */
      }
    })
    events.addEventListener('tools', (event) => {
      try {
        setTools(JSON.parse((event as MessageEvent).data))
      } catch {
        /* ignore */
      }
    })
    return () => events.close()
  }, [])

  // ------------------------------------------------------------- open files
  /** Adds recordings to the end of the project timeline. */
  const openFiles = useCallback(
    async (paths: string[]) => {
      const added: MediaInfo[] = []
      for (const path of paths) {
        if (clipsRef.current.some((clip) => clip.path === path)) {
          // Already on the timeline: jump to where it starts instead of adding it twice.
          const span = clipSpans(clipsRef.current).find((entry) => entry.info.path === path)
          if (span) setPlayhead(span.start)
          continue
        }
        if (openingRef.current.has(path)) continue
        openingRef.current.add(path)
        try {
          const { info } = await api.probe(path)
          added.push(info)
        } catch (err) {
          notifyError(`Could not open ${baseName(path)}: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          openingRef.current.delete(path)
        }
      }
      if (added.length === 0) return
      const before = clipsRef.current
      const next = [...before, ...added.filter((info) => !before.some((clip) => clip.path === info.path))]
      const empty = timelineDuration(before) === 0
      setClips(next)
      setSegments((previous) => appendSegments(previous, timelineDuration(next)))
      if (empty) {
        historyRef.current = { past: [], future: [] }
        setHistoryTick((tick) => tick + 1)
        setPlayhead(0)
        setPlaying(false)
        setSelectedId(null)
        setSelectedMarker(null)
        setRange(null)
        const total = timelineDuration(next)
        const first = Math.max(minSpan, Math.min(total || 60, total > 900 ? 300 : total || 60))
        setView({ start: 0, end: first })
      } else {
        const start = clipSpans(next).find((span) => span.info.path === added[0].path)
        if (start) setPlayhead(start.start)
      }
      setTab('project')
    },
    [minSpan, notifyError],
  )

  const browseMedia = useCallback(async () => {
    try {
      const paths = await pickMedia(true, 'Open video or audio')
      if (paths.length) await openFiles(paths)
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
    }
  }, [openFiles, notifyError])

  /** Removing a clip carries the cut list across to the shortened timeline. */
  const removeClip = useCallback(
    (path: string) => {
      const before = clipsRef.current
      const after = before.filter((clip) => clip.path !== path)
      const removed = clipSpans(before).find((span) => span.info.path === path)
      setSegments((previous) => remapSegments(previous, before, after))
      setClips(after)
      if (removed && playhead >= removed.start) {
        setPlayhead(Math.max(0, Math.min(timelineDuration(after), removed.start)))
      }
      if (!after.length) {
        setSegments([])
        historyRef.current = { past: [], future: [] }
        setHistoryTick((tick) => tick + 1)
      }
      notify(`Removed ${baseName(path)} from the timeline`)
    },
    [notify, playhead],
  )

  /**
   * Reordering keeps every fragment attached to its recording, and each clip's
   * audio choice travels with it because it is keyed by path.
   */
  const reorderClips = useCallback((path: string, toIndex: number) => {
    const before = clipsRef.current
    const from = before.findIndex((clip) => clip.path === path)
    if (from < 0) return
    const target = Math.max(0, Math.min(before.length - 1, toIndex))
    if (target === from) return
    const after = [...before]
    const [moved] = after.splice(from, 1)
    after.splice(target, 0, moved)
    setSegments((previous) => remapSegments(previous, before, after))
    setClips(after)
  }, [])

  const moveClip = useCallback(
    (path: string, direction: -1 | 1) => {
      const index = clipsRef.current.findIndex((clip) => clip.path === path)
      if (index < 0) return
      reorderClips(path, index + direction)
    },
    [reorderClips],
  )

  // Development convenience: `?open=<path>` opens a file on start, which makes
  // the UI testable without driving a native file dialog.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const requested = new URLSearchParams(window.location.search).get('open')
    if (requested) openFiles(requested.split('|').filter(Boolean))
  }, [openFiles])

  // -------------------------------------------------- project / timeline
  // A project is never empty: with clips on the timeline there is always a cut
  // list covering all of it, so new material starts out kept.
  useEffect(() => {
    if (!(duration > 0)) {
      setSegments([])
      setKeyframes([])
      setWaveWindow(null)
      setFilmstrip([])
      setWaveStatus('idle')
      setOverview(null)
      return
    }
    setSegments((previous) => {
      if (!previous.length) return normalizePartition([], duration)
      const last = previous[previous.length - 1]
      if (Math.abs(last.end - duration) < 1e-3) return previous
      return normalizePartition(previous, duration)
    })
  }, [duration])

  // The whole-file waveform is only offered for a single recording; with several
  // clips the visible window is decoded per clip instead.
  useEffect(() => {
    if (clips.length !== 1) {
      setOverview(null)
      return
    }
    let cancelled = false
    api
      .overview(clips[0].path, 4000, trackFor(clips[0]))
      .then((result) => {
        if (!cancelled) setOverview(result.state === 'ready' ? result.peaks : null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [clips, previewTrack])

  // Keyframes are read for the visible stretch only, from every recording it
  // touches, then shifted onto project time. Scanning whole files takes minutes.
  useEffect(() => {
    if (!clips.length) {
      setKeyframes([])
      return
    }
    const span = view.end - view.start
    if (!(span > 0) || span > KEY_WINDOW_MAX) {
      setKeyframes([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const frames: number[] = []
      for (const window of clipWindows(clips, Math.max(0, view.start - span * 0.04), view.end + span * 0.04)) {
        try {
          const result = await api.keyframes(window.span.info.path, {
            start: window.localStart,
            end: window.localEnd,
          })
          if (cancelled) return
          for (const frame of result.frames) frames.push(window.span.start + frame)
        } catch {
          /* one unreadable clip must not hide the rest */
        }
      }
      if (!cancelled) setKeyframes(frames.sort((a, b) => a - b))
    }, 240)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [clips, view.start, view.end])

  // Finished windows stay in memory so panning back is instant, and whatever
  // FFmpeg has already decoded is drawn while the rest of the window is read.
  useEffect(() => {
    waveCache.current.clear()
  }, [clips])

  // Windowed waveform: only the visible part is decoded, one request per clip
  // it touches, then the peaks are stitched back onto project time.
  useEffect(() => {
    if (!clips.length) return
    // The rail pans the timeline as it is dragged, so a read for every window
    // that slides past would queue FFmpeg work in front of the picture and the
    // sound the jump needs. Only the window the pointer settles on is read.
    if (scrubbing) return
    const from = view.start
    const to = view.end
    const span = to - from
    if (overview && clips.length === 1 && span > OVERVIEW_SPAN) {
      setWaveWindow({ start: 0, end: duration || to, peaks: overview })
      setWaveStatus('ready')
      return
    }
    if (span > MAX_WAVE_SPAN) {
      setWaveWindow(null)
      setWaveStatus('coarse')
      return
    }

    let cancelled = false
    let poll = 0
    let warm = 0
    const cache = waveCache.current
    const keyFor = (file: string, start: number, end: number, buckets: number, track: number) =>
      `${file}|${start.toFixed(3)}|${end.toFixed(3)}|${buckets}|${track}`
    const remember = (key: string, peaks: number[]) => {
      cache.set(key, peaks)
      if (cache.size > 80) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
      }
    }

    // Reading the windows either side while the view sits still is what makes
    // nudging along the timeline feel instant.
    const warmNeighbours = async () => {
      const limit = duration || to
      const step = Math.max(1, span * 0.9)
      const edges: [number, number][] = [
        [Math.max(0, from - step), Math.max(0, from - step) + span],
        [to, to + span],
      ]
      for (const [start, end] of edges) {
        if (cancelled || end > limit + 1e-3) continue
        for (const window of clipWindows(clips, start, end)) {
          if (cancelled) return
          const share = (window.localEnd - window.localStart) / Math.max(0.001, end - start)
          const buckets = Math.max(48, Math.min(2000, Math.round(share * 2000)))
          const track = trackFor(window.span.info)
          const key = keyFor(window.span.info.path, window.localStart, window.localEnd, buckets, track)
          if (cache.has(key)) continue
          try {
            const state = await api.waveform(window.span.info.path, window.localStart, window.localEnd, buckets, track)
            if (cancelled) return
            const usable = state.peaks?.slice(0, buckets) ?? []
            if (state.state === 'ready' && usable.length === buckets) remember(key, usable)
          } catch {
            /* prefetch is best effort */
          }
        }
      }
    }

    const run = async () => {
      const windows = clipWindows(clips, from, to)
      const peaks: number[] = []
      let running = false
      let failed = false
      for (const window of windows) {
        const share = (window.localEnd - window.localStart) / Math.max(0.001, span)
        const buckets = Math.max(48, Math.min(2000, Math.round(share * 2000)))
        const track = trackFor(window.span.info)
        const key = keyFor(window.span.info.path, window.localStart, window.localEnd, buckets, track)
        const cached = cache.get(key)
        if (cached) {
          peaks.push(...cached)
          continue
        }
        try {
          const state = await api.waveform(window.span.info.path, window.localStart, window.localEnd, buckets, track)
          if (cancelled) return
          if (state.state === 'running') running = true
          if (state.peaks && state.peaks.length) {
            // A window that is still decoding hands over its peaks so far; the
            // rest is padded flat and filled in on the next poll.
            const usable = state.peaks.slice(0, buckets)
            peaks.push(...usable, ...new Array<number>(Math.max(0, buckets - usable.length)).fill(0))
            if (state.state === 'ready' && usable.length === buckets) remember(key, usable)
          } else {
            peaks.push(...new Array<number>(buckets).fill(0))
          }
        } catch {
          failed = true
          peaks.push(...new Array<number>(buckets).fill(0))
        }
      }
      if (cancelled) return
      setWaveStatus(running ? 'running' : failed ? 'error' : 'ready')
      setWaveWindow({ start: from, end: to, peaks })
      if (running) {
        poll = window.setTimeout(run, 350)
        return
      }
      warm = window.setTimeout(warmNeighbours, 600)
    }

    // A jump is judged by the picture and the sound, which start straight away;
    // the peaks are allowed to arrive behind them, so their read waits a moment
    // after the pointer comes up instead of competing for the disk.
    const settle = Math.max(0, 600 - (Date.now() - scrubReleasedAt.current))
    const debounce = window.setTimeout(run, 120 + settle)
    return () => {
      cancelled = true
      window.clearTimeout(debounce)
      window.clearTimeout(poll)
      window.clearTimeout(warm)
    }
  }, [clips, view.start, view.end, overview, duration, trackFor, scrubbing])

  // Thumbnails for the visible window, taken from every clip it covers.
  useEffect(() => {
    if (!clips.length) return
    let cancelled = false
    const from = view.start
    const to = view.end
    const timer = window.setTimeout(async () => {
      const frames: { time: number; dataUrl: string }[] = []
      for (const window of clipWindows(clips, from, to)) {
        const share = (window.localEnd - window.localStart) / Math.max(0.001, to - from)
        const count = Math.max(1, Math.round(12 * share))
        try {
          const result = await api.filmstrip(
            window.span.info.path,
            Math.round(window.localStart * 10) / 10,
            Math.round(window.localEnd * 10) / 10,
            count,
          )
          if (cancelled) return
          for (const frame of result.frames) frames.push({ time: window.span.start + frame.time, dataUrl: frame.dataUrl })
        } catch {
          /* skip a clip that will not produce thumbnails */
        }
      }
      if (!cancelled) setFilmstrip(frames)
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [clips, view.start, view.end])

  useEffect(() => {
    if (!playing) return
    const span = view.end - view.start
    if (playhead >= view.start && playhead <= view.end - span * 0.04) return
    const start = Math.max(0, Math.min(Math.max(0, duration - span), playhead - span * 0.08))
    setView({ start, end: start + span })
  }, [playhead, playing, view.start, view.end, duration])

  // A single recording still gets its cut list remembered by path; a project of
  // several clips is saved as a project instead, since it has no single file.
  useEffect(() => {
    if (clips.length !== 1) return
    const timer = window.setTimeout(() => {
      api.saveCutlist(clips[0].path, segments, duration).catch(() => undefined)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [segments, clips, duration])

  useEffect(() => {
    if (!proxyJobId) return
    const job = queue.jobs.find((entry) => entry.id === proxyJobId)
    const source = (job?.params as { source?: string } | undefined)?.source
    if (job?.status === 'done' && job.outputs[0] && source) {
      setProxies((previous) => ({ ...previous, [source]: job.outputs[0].path }))
      setProxyJobId(null)
    }
  }, [queue, proxyJobId])

  useEffect(() => {
    if (!duration) return
    setView((current) => {
      const span = Math.max(minSpan, Math.min(duration, current.end - current.start))
      const start = Math.max(0, Math.min(Math.max(0, duration - span), current.start))
      if (Math.abs(span - (current.end - current.start)) < 1e-6 && Math.abs(start - current.start) < 1e-6) return current
      return { start, end: start + span }
    })
  }, [duration, minSpan])

  // ------------------------------------------------------- fragment editing
  const pushHistory = useCallback((snapshot: Segment[]) => {
    const store = historyRef.current
    store.past = [...store.past.slice(-80), snapshot]
    store.future = []
    setHistoryTick((tick) => tick + 1)
  }, [])

  const apply = useCallback(
    (next: Segment[], transient = false) => {
      if (!(duration > 0)) return
      if (transient) {
        if (!pendingRef.current) pendingRef.current = segmentsRef.current
        setSegments(next)
        return
      }
      const before = pendingRef.current ?? segmentsRef.current
      pendingRef.current = null
      if (before && before !== next) pushHistory(before)
      setSegments(next)
    },
    [duration, pushHistory],
  )

  const boundaryCommit = useCallback(() => {
    const before = pendingRef.current
    pendingRef.current = null
    if (before) pushHistory(before)
  }, [pushHistory])

  const undo = useCallback(() => {
    const store = historyRef.current
    if (!store.past.length) return
    const previous = store.past[store.past.length - 1]
    store.past = store.past.slice(0, -1)
    store.future = [segmentsRef.current, ...store.future]
    setSegments(previous)
    setHistoryTick((tick) => tick + 1)
  }, [])

  const redo = useCallback(() => {
    const store = historyRef.current
    if (!store.future.length) return
    const next = store.future[0]
    store.future = store.future.slice(1)
    store.past = [...store.past, segmentsRef.current]
    setSegments(next)
    setHistoryTick((tick) => tick + 1)
  }, [])

  const canUndo = historyRef.current.past.length > 0
  const canRedo = historyRef.current.future.length > 0

  const doSplit = useCallback(() => {
    const list = segmentsRef.current
    const { segments: next, markerIndex } = splitAt(list, playhead, frameStep(fps))
    if (markerIndex < 0) {
      notify('Put the playhead inside a fragment first')
      return
    }
    apply(next)
    setSelectedMarker(markerIndex)
    setSelectedId(next[markerIndex].id)
  }, [apply, playhead, fps, notify])

  const doCutOut = useCallback(() => {
    const list = segmentsRef.current
    const index = list.findIndex((segment) => segment.id === selectedIdRef.current)
    if (index < 0) {
      notify('Select a fragment on the timeline first')
      return
    }
    apply(setEnabled(list, list[index].id, false))
    const preferred = list[Math.min(index + 1, list.length - 1)]
    setSelectedId(preferred?.id ?? null)
    setSelectedMarker(null)
  }, [apply, notify])

  const doKeep = useCallback(() => {
    const list = segmentsRef.current
    const target = list.find((segment) => segment.id === selectedIdRef.current)
    if (!target) {
      notify('Select a fragment on the timeline first')
      return
    }
    apply(setEnabled(list, target.id, true))
  }, [apply, notify])

  const doCutPrevious = useCallback(() => {
    const list = segmentsRef.current
    const index = list.findIndex((segment) => segment.id === selectedIdRef.current)
    if (index <= 0) {
      notify('Select a fragment that has one before it')
      return
    }
    apply(setEnabled(list, list[index - 1].id, false))
  }, [apply, notify])

  const doInvert = useCallback(() => {
    apply(invert(segmentsRef.current))
  }, [apply])

  const doClearMarkers = useCallback(() => {
    if (!duration) return
    apply([{ id: uid(), start: 0, end: duration, label: '', enabled: true }])
    setSelectedMarker(null)
    setSelectedId(null)
  }, [apply, duration])

  const doDeleteMarker = useCallback(() => {
    const list = segmentsRef.current
    const marker = selectedMarkerRef.current
    if (marker !== null) {
      apply(removeMarker(list, marker))
      setSelectedMarker(null)
      return
    }
    const index = list.findIndex((segment) => segment.id === selectedIdRef.current)
    if (index > 0) apply(removeMarker(list, index - 1))
  }, [apply])

  const doTrimBefore = useCallback(() => {
    const list = segmentsRef.current
    const { segments: split, markerIndex } = splitAt(list, playhead, frameStep(fps))
    apply(trimBefore(markerIndex >= 0 ? split : list, playhead))
    setSelectedMarker(null)
  }, [apply, playhead, fps])

  const doTrimAfter = useCallback(() => {
    const list = segmentsRef.current
    const { segments: split, markerIndex } = splitAt(list, playhead, frameStep(fps))
    apply(trimAfter(markerIndex >= 0 ? split : list, playhead))
    setSelectedMarker(null)
  }, [apply, playhead, fps])

  const doCutRange = useCallback(() => {
    if (!range) return
    const step = frameStep(fps)
    let list = segmentsRef.current
    list = splitAt(list, range.start, step).segments
    list = splitAt(list, range.end, step).segments
    apply(list.map((segment) => (segment.start >= range.start - 1e-3 && segment.end <= range.end + 1e-3 ? { ...segment, enabled: false } : segment)))
    setRange(null)
    setSelectedMarker(null)
  }, [apply, range, fps])

  const doDivide = useCallback(
    (parts: number) => {
      if (!duration) return
      const count = Math.max(2, Math.min(200, Math.round(parts)))
      const next: Segment[] = []
      for (let index = 0; index < count; index += 1) {
        const start = (duration * index) / count
        const end = index === count - 1 ? duration : (duration * (index + 1)) / count
        next.push({ id: uid(), start, end, label: `Part ${index + 1}`, enabled: true })
      }
      apply(next)
      setSelectedMarker(null)
      notify(`Divided into ${count} equal fragments`)
    },
    [apply, duration, notify],
  )

  const doReset = useCallback(() => {
    if (!duration) return
    apply([{ id: uid(), start: 0, end: duration, label: '', enabled: true }])
    setSelectedMarker(null)
    setSelectedId(null)
  }, [apply, duration])

  const moveBoundary = useCallback(
    (index: number, time: number, transient = true) => {
      const list = segmentsRef.current
      if (index < 0 || index >= list.length - 1) return
      const step = frameStep(fps)
      const left = list[index]
      const right = list[index + 1]
      const value = Math.max(left.start + step, Math.min(right.end - step, time))
      const next = list.map((segment, position) => {
        if (position === index) return { ...segment, end: value }
        if (position === index + 1) return { ...segment, start: value }
        return segment
      })
      apply(next, transient)
    },
    [apply, fps],
  )

  // ------------------------------------------------------------------ zoom
  const setSpan = useCallback(
    (newSpan: number, anchor: number) => {
      if (!(duration > 0)) return
      const clamped = Math.max(minSpan, Math.min(duration, newSpan))
      const ratio = (anchor - view.start) / Math.max(1e-6, view.end - view.start)
      const start = Math.max(0, Math.min(Math.max(0, duration - clamped), anchor - clamped * ratio))
      setView({ start, end: start + clamped })
    },
    [duration, minSpan, view.start, view.end],
  )

  // Fixed zoom levels, SolveigMM style: from the whole clip down to frames.
  const zoomLevels = useMemo(() => {
    const build = (id: string, label: string, seconds: number) => ({
      id,
      label,
      span: Math.max(minSpan, Math.min(duration || seconds, seconds)),
    })
    const levels = [
      { id: 'fit', label: 'Reset zoom', span: Math.max(minSpan, duration || 60) },
      build('60', '1 minute', 60),
      build('30', '30 seconds', 30),
      build('15', '15 seconds', 15),
      build('5', '5 seconds', 5),
      build('1', '1 second', 1),
      { id: 'frame', label: 'Frame mode', span: Math.max(minSpan, frameStep(fps) * 12) },
    ]
    // A short clip makes several levels identical, so keep the first of each span.
    return levels.filter(
      (entry, index) => levels.findIndex((other) => Math.abs(other.span - entry.span) < 1e-6) === index,
    )
  }, [duration, minSpan, fps])

  const currentZoom = zoomLevels.find((entry) => Math.abs(entry.span - (view.end - view.start)) <= Math.max(0.0005, entry.span * 0.005))
  // The slider is the stepless view of the same ladder: the wheel can land
  // between levels, so snap the handle to the closest one.
  const zoomIndex = useMemo(() => {
    const live = view.end - view.start
    return zoomLevels.reduce(
      (best, entry, index) =>
        Math.abs(entry.span - live) < Math.abs(zoomLevels[best].span - live) ? index : best,
      0,
    )
  }, [zoomLevels, view.start, view.end])

  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const zoomMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!zoomMenuOpen) return undefined
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setZoomMenuOpen(false)
        return
      }
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(event.target as Node)) {
        setZoomMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [zoomMenuOpen])

  const applyZoom = useCallback((entry: { span: number }) => setSpan(entry.span, playhead), [setSpan, playhead])

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const index = currentZoom ? zoomLevels.findIndex((entry) => entry.id === currentZoom.id) : -1
      if (index >= 0) {
        const next = zoomLevels[Math.min(zoomLevels.length - 1, Math.max(0, index + direction))]
        setSpan(next.span, playhead)
        return
      }
      // A custom span (from the wheel) steps to the next preset in that direction.
      const live = view.end - view.start
      const narrower = zoomLevels.find((entry) => entry.span < live - 1e-6)
      const wider = [...zoomLevels].reverse().find((entry) => entry.span > live + 1e-6)
      const target = direction === 1 ? narrower ?? zoomLevels[zoomLevels.length - 1] : wider ?? zoomLevels[0]
      setSpan(target.span, playhead)
    },
    [currentZoom, zoomLevels, setSpan, playhead, view.start, view.end],
  )

  const fitView = useCallback(() => {
    setView({ start: 0, end: Math.max(minSpan, duration || 60) })
  }, [duration, minSpan])

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      const step = frameStep(fps)
      const mod = event.ctrlKey || event.metaKey

      // ? is Shift+/ on most layouts, so match either form.
      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        event.preventDefault()
        setFirstRun(false)
        setShortcutsOpen(true)
        return
      }

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        const first = clipsRef.current[0]
        if (first) {
          saveCurrentProject(baseName(first.path)).catch((err) =>
            notifyError(err instanceof Error ? err.message : String(err)),
          )
        }
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        doClearMarkers()
        return
      }
      if (mod) return

      // , and . step one frame, or one second with Shift. Matched on the physical
      // key because Shift turns them into < and > on most layouts.
      const commaKey = event.code === 'Comma' || event.key === ',' || event.key === '<'
      const periodKey = event.code === 'Period' || event.key === '.' || event.key === '>'
      if (commaKey || periodKey) {
        event.preventDefault()
        const delta = event.shiftKey ? 1 : step
        const base = playheadRef.current
        setPlayhead(commaKey ? base - delta : base + delta)
        return
      }

      switch (event.key) {
        case ' ':
          event.preventDefault()
          setPlaying((value) => !value)
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (event.altKey) {
            const offset = (view.end - view.start) * 0.1
            const start = Math.max(0, view.start - offset)
            setView({ start, end: start + (view.end - view.start) })
          } else {
            setPlayhead(playheadRef.current - (event.shiftKey ? 1 : step))
          }
          break
        case 'ArrowRight':
          event.preventDefault()
          if (event.altKey) {
            const span = view.end - view.start
            const start = Math.min(Math.max(0, duration - span), view.start + span * 0.1)
            setView({ start, end: start + span })
          } else {
            setPlayhead(playheadRef.current + (event.shiftKey ? 1 : step))
          }
          break
        case 'm':
        case 'M':
        case 'l':
        case 'L':
          event.preventDefault()
          doSplit()
          break
        case 'd':
        case 'D':
          doCutOut()
          break
        case 's':
        case 'S':
          doKeep()
          break
        case 'f':
        case 'F':
          doCutPrevious()
          break
        case 'i':
        case 'I':
          doInvert()
          break
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          doDeleteMarker()
          break
        case 'Home':
          event.preventDefault()
          if (event.altKey) jumpToClip('start')
          else setPlayhead(0)
          break
        case 'End':
          event.preventDefault()
          if (event.altKey) jumpToClip('end')
          else setPlayhead(duration)
          break
        case '+':
        case '=':
        case '+':
          event.preventDefault()
          stepZoom(1)
          break
        case '-':
        case '_':
          event.preventDefault()
          stepZoom(-1)
          break
        case '0':
          event.preventDefault()
          fitView()
          break
        case 'Escape':
          setRange(null)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    playhead,
    duration,
    fps,
    view.start,
    view.end,
    doSplit,
    doCutOut,
    doKeep,
    doCutPrevious,
    doInvert,
    doClearMarkers,
    doDeleteMarker,
    undo,
    redo,
    stepZoom,
    fitView,
    jumpToClip,
    setPlayhead,
  ])

  // ------------------------------------------------------------ drag & drop
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes('Files')) {
        event.preventDefault()
        setDropActive(true)
      }
    }
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDropActive(false)
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      setDropActive(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files.map((file) => desktop?.pathForFile(file) ?? '').filter(Boolean)
      if (paths.length) openFiles(paths)
      else notify('Use Open media to add files', 'error')
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [openFiles, notify])

  // ----------------------------------------------------------------- queue
  const addJobs = useCallback(
    async (jobs: JobInput[], startNow: boolean) => {
      const created = await api.addBatch(jobs)
      if (startNow) await api.startQueue()
      setQueue(await api.queue())
      setQueueOpen(true)
      notify(`${created.jobs.length} job${created.jobs.length === 1 ? '' : 's'} added to the queue`)
    },
    [notify],
  )

  // ---------------------------------------------------------- saved projects
  const updateConfig = useCallback((patch: Partial<ExportConfig>) => {
    setExportConfig((current) => ({ ...current, ...patch }))
  }, [])

  useEffect(() => {
    if (settings.outDir) setExportConfig((current) => (current.outDir ? current : { ...current, outDir: settings.outDir }))
  }, [settings.outDir])

  useEffect(() => {
    api
      .projects()
      .then((result) => setProjects(result.projects))
      .catch(() => undefined)
      .finally(() => setProjectsLoaded(true))
  }, [])

  const saveCurrentProject = useCallback(
    async (name: string, id?: string) => {
      const list = clipsRef.current
      if (!list.length) throw new Error('Open a clip before saving a project')
      const { project } = await api.saveProject({
        id,
        name,
        source: list[0].path,
        duration,
        clips: clipSpans(list).map((span) => ({ path: span.info.path, offset: span.start, duration: span.info.duration })),
        segments: segmentsRef.current,
        audioTracks: list[0].audioTracks,
        tracks: trackByClip,
        export: exportConfig,
      })
      setProjects((previous) => [project, ...previous.filter((entry) => entry.id !== project.id)])
      setCurrentProjectId(project.id)
      api.saveSettings({ lastProjectId: project.id }).catch(() => undefined)
      notify(`Saved project “${project.name}”`)
    },
    [exportConfig, notify, trackByClip],
  )

  const removeProject = useCallback(
    async (id: string) => {
      await api.deleteProject(id)
      setProjects((previous) => previous.filter((entry) => entry.id !== id))
      if (currentProjectId === id) {
        setCurrentProjectId(null)
        api.saveSettings({ lastProjectId: '' }).catch(() => undefined)
      }
    },
    [currentProjectId],
  )

  /** Replaces the timeline with a project's clips, in their saved order. */
  const loadTimeline = useCallback(
    async (paths: string[], list: Segment[]) => {
      const infos: MediaInfo[] = []
      for (const path of paths) {
        const { info } = await api.probe(path)
        infos.push(info)
      }
      if (!infos.length) throw new Error('This project has no clips')
      const total = timelineDuration(infos)
      setClips(infos)
      setSegments(normalizePartition(list, total))
      historyRef.current = { past: [], future: [] }
      setHistoryTick((tick) => tick + 1)
      setPlayhead(0)
      setPlaying(false)
      setSelectedId(null)
      setSelectedMarker(null)
      setRange(null)
      const span = Math.max(minSpan, Math.min(total || 60, total > 900 ? 300 : total || 60))
      setView({ start: 0, end: span })
    },
    [minSpan],
  )

  const loadProject = useCallback(
    async (project: SavedProject, options?: { silent?: boolean }) => {
      const list = project.clips?.length
        ? project.clips
        : [{ path: project.source, offset: 0, duration: project.duration }]
      await loadTimeline(list.map((clip) => clip.path), project.segments)
      setExportConfig({ ...DEFAULT_EXPORT, ...project.export })
      setTrackByClip(project.tracks ?? {})
      setCurrentProjectId(project.id)
      setTab('project')
      if (!options?.silent) {
        api.saveSettings({ lastProjectId: project.id }).catch(() => undefined)
        notify(`Loaded project “${project.name}”`)
      }
    },
    [loadTimeline, notify],
  )

  // Reopen the project that was open when the app last closed, cut list and all,
  // once both the saved settings and the project list have arrived. Reopening is
  // opt-in, so by default the app starts with an empty timeline.
  useEffect(() => {
    if (restoredRef.current || !settingsLoaded || !projectsLoaded) return
    restoredRef.current = true
    if (!settings.reopenLastProject) return
    const target = projects.find((project) => project.id === settings.lastProjectId)
    if (!target) return
    loadProject(target, { silent: true }).catch((err) =>
      notifyError(`Could not reopen “${target.name}”: ${err instanceof Error ? err.message : String(err)}`),
    )
  }, [settingsLoaded, projectsLoaded, projects, settings.lastProjectId, settings.reopenLastProject, loadProject, notifyError])

  const queueProjects = useCallback(
    async (chosen: SavedProject[], startNow: boolean) => {
      const jobs = chosen.flatMap((project) => {
        const list = project.clips?.length
          ? project.clips
          : [{ path: project.source, offset: 0, duration: project.duration }]
        return buildCutJobs(
          {
            clips: list,
            duration: project.duration,
            audioTracks: project.audioTracks ?? [],
            tracks: project.tracks ?? {},
            name: project.name,
          },
          project.segments,
          { ...DEFAULT_EXPORT, ...project.export },
        )
      })
      if (!jobs.length) return
      await addJobs(jobs, startNow)
    },
    [addJobs],
  )

  const queueAction = useCallback(
    async (id: string, action: 'cancel' | 'retry' | 'remove') => {
      try {
        const result = await api.jobAction(id, action)
        setQueue(result.queue)
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err))
      }
    },
    [notifyError],
  )

  /**
   * Decode a finished export end to end so a broken file is caught here. The
   * queue job reports decoder errors and its progress, because reading every
   * frame of a long export takes real time.
   */
  const verifyOutputFile = useCallback(
    async (path: string) => {
      try {
        const name = baseName(path)
        await api.addJob({ type: 'verify', label: `Verify · ${name}`, params: { path } })
        setQueue(await api.startQueue())
        setQueueOpen(true)
        notify(`Checking ${name} for decode errors — this reads the whole file`)
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err))
      }
    },
    [notify, notifyError],
  )

  const buildProxy = useCallback(async () => {
    if (!active) return
    try {
      const created = await api.addJob({
        type: 'proxy',
        label: `Preview · ${baseName(active.path)}`,
        params: { source: active.path },
      })
      setProxyJobId(created.job.id)
      await api.startQueue()
      notify('Building a preview copy — it plays as soon as it is ready')
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
    }
  }, [active, notify, notifyError])

  // Stable so the player does not refetch the preview track on every render.
  const handleAudioStatus = useCallback((state: string, progress: number) => {
    setPreviewAudioState(state)
    setPreviewAudioProgress(progress)
  }, [])

  const buildWaveformOverview = useCallback(async () => {
    if (!active) return
    try {
      await api.addJob({
        type: 'waveform',
        label: `Waveform · ${baseName(active.path)}`,
        params: { source: active.path, buckets: 4000, track: trackFor(active) },
      })
      await api.startQueue()
      notify('Reading the full waveform in the background')
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
    }
  }, [active, notify, notifyError, trackFor])

  const waveJobDone = queue.jobs.filter((job) => job.type === 'waveform' && job.status === 'done').length
  useEffect(() => {
    if (clips.length !== 1 || !waveJobDone) return
    api
      .overview(clips[0].path, 4000, trackFor(clips[0]))
      .then((result) => setOverview(result.state === 'ready' ? result.peaks : null))
      .catch(() => undefined)
  }, [waveJobDone, clips, trackFor])

  const proxyJob = proxyJobId ? queue.jobs.find((job) => job.id === proxyJobId) ?? null : null
  const analyzeJob = useMemo(() => {
    const matches = queue.jobs.filter(
      (job) => job.type === 'analyze' && (job.params as { source?: string }).source === active?.path,
    )
    return matches.length ? matches[matches.length - 1] : null
  }, [queue.jobs, active?.path])

  // Remember the queue panel's folded/unfolded state across sessions.
  const toggleQueue = () => {
    setQueueOpen((value) => {
      const next = !value
      api.saveSettings({ queueOpen: next }).catch(() => undefined)
      return next
    })
  }

  const totalFragments = segments.filter((segment) => segment.enabled).length
  const running = queue.stats.running ?? 0
  const span = view.end - view.start

  return (
    <div className={`app ${dropActive ? 'dragging' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <button
            type="button"
            className="brand-btn"
            onClick={() => setAboutOpen(true)}
            title="About CrossCut"
            aria-label="About CrossCut"
          >
            <span className="brand-mark">✕</span>
            <div className="brand-text">
              <span className="brand-title">
                <strong>CrossCut</strong>
                {documentName && (
                  <span className="brand-project ellipsis" title={documentName}>
                    {documentName}
                  </span>
                )}
              </span>
              <span className="brand-sub">lossless video editor</span>
            </div>
          </button>
        </div>

        <div className="topbar-actions">
          <button type="button" className="btn btn-primary" onClick={browseMedia}>
            Open media
          </button>
          <button
            type="button"
            className={`tool-badge ${tools?.ok ? 'ok' : 'error'}`}
            onClick={() => setSettingsOpen(true)}
            title={tools?.ok ? `${tools.ffmpeg} (${tools.source})` : 'FFmpeg not found'}
          >
            <span className="dot" />
            {tools?.ok ? `FFmpeg ${tools.version.split('-')[0]}` : 'FFmpeg missing'}
          </button>
          {running > 0 && (
            <button type="button" className="tool-badge live" onClick={() => setQueueOpen(true)}>
              <span className="dot" /> {running} job{running === 1 ? '' : 's'} running
            </button>
          )}
          <button
            type="button"
            className="icon-btn big"
            onClick={() => {
              setFirstRun(false)
              setShortcutsOpen(true)
            }}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          <button type="button" className="icon-btn big" onClick={() => setSettingsOpen(true)} title="Settings">
            ⚙
          </button>
          <WindowControls />
        </div>
      </header>

      <div className="workspace">
        <aside className="rail">
          <div className="rail-head">
            <h2>Clips</h2>
            <button type="button" className="icon-btn" onClick={browseMedia} title="Add clip">
              +
            </button>
          </div>
          <ul className="rail-list">
            {spans.map((span) => (
              <li key={span.info.path} className={span.index === activeIndex ? 'active' : ''}>
                <button
                  type="button"
                  className="rail-item"
                  onClick={() => setPlayhead(span.start)}
                  title={`${span.info.path}\nPart ${span.index + 1} · ${shortTimecode(span.start)} → ${shortTimecode(span.end)}`}
                >
                  <span className="rail-name ellipsis">
                    <span className="rail-part">{span.index + 1}</span>
                    {span.info.name}
                  </span>
                  <span className="rail-meta">
                    {shortTimecode(span.start)} → {shortTimecode(span.end)}
                    {span.info.video ? ` · ${span.info.video.width}×${span.info.video.height}` : ''}
                    {hdrKind(span.info.video) ? ` · ${hdrKind(span.info.video)}` : ''}
                  </span>
                </button>
                {span.info.audioTracks.length > 1 && (
                  <div className="rail-audio">
                    <TrackPicker
                      compact
                      tracks={span.info.audioTracks}
                      value={trackFor(span.info)}
                      onChange={(index) => setTrackByClip((current) => ({ ...current, [span.info.path]: index }))}
                    />
                  </div>
                )}
                <div className="rail-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Move earlier on the timeline"
                    disabled={span.index === 0}
                    onClick={() => moveClip(span.info.path, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Move later on the timeline"
                    disabled={span.index === spans.length - 1}
                    onClick={() => moveClip(span.info.path, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn rail-remove"
                    title="Remove from the timeline"
                    onClick={() => removeClip(span.info.path)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {clips.length === 0 && (
            <div className="rail-empty">
              <p>Drop recordings here</p>
              <p className="muted small">Each one is added to the end of the timeline. Nothing is copied or moved.</p>
            </div>
          )}
          <div className="rail-foot muted small">
            {totalFragments} kept fragment{totalFragments === 1 ? '' : 's'} across {clips.length} clip
            {clips.length === 1 ? '' : 's'} · {shortTimecode(duration)}
          </div>
        </aside>

        <main className="stage">
          <Player
            clips={spans.map((span) => ({
              path: span.info.path,
              start: span.start,
              duration: span.end - span.start,
            }))}
            info={active}
            playhead={playhead}
            playing={playing}
            proxies={proxies}
            track={previewTrack}
            volume={volume}
            muted={muted}
            rate={rate}
            holdSeek={scrubbing}
            onAudioStatus={handleAudioStatus}
            onTime={setPlayhead}
            onPlayingChange={setPlaying}
            onBuildProxy={buildProxy}
            proxyBusy={proxyJob?.status === 'running'}
          />

          <div className="transport">
            <div className="transport-buttons">
              <button type="button" className="icon-btn" onClick={() => setPlayhead(0)} title="Start of the project (Home)">
                ⏮
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => jumpToClip('start')}
                disabled={!(duration > 0)}
                title="Start of this recording (Alt+Home)"
              >
                ⇤
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPlayhead(playheadRef.current - step(fps))}
                title="Previous frame (, · Shift for 1 second)"
              >
                ◀
              </button>
              <button
                type="button"
                className={`play-btn ${playing ? 'playing' : ''}`}
                onClick={() => setPlaying(!playing)}
                title="Play / pause (Space)"
              >
                {playing ? '❙❙' : '▶'}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPlayhead(playheadRef.current + step(fps))}
                title="Next frame (. · Shift for 1 second)"
              >
                ▶
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => jumpToClip('end')}
                disabled={!(duration > 0)}
                title="End of this recording (Alt+End)"
              >
                ⇥
              </button>
              <button type="button" className="icon-btn" onClick={() => setPlayhead(duration)} title="End of the project (End)">
                ⏭
              </button>
              <span className="divider" />
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setSelectedId(null)
                  setSelectedMarker(null)
                }}
                title="Clear selection"
              >
                ⬚
              </button>
            </div>

            <div className="timecode-readout">
              <TimecodeField value={playhead} fps={fps} duration={duration} onSeek={focusTime} />
              <span className="muted mono">/ {timecode(duration, fps)}</span>
            </div>

            <div className="transport-audio">
              {(active?.audioTracks ?? []).length > 1 && (
                <div className="transport-ctl" title="Audio track this recording previews with">
                  <TrackPicker
                    tracks={active?.audioTracks ?? []}
                    value={previewTrack}
                    onChange={(index) => {
                      if (!active) return
                      setTrackByClip((current) => ({ ...current, [active.path]: index }))
                    }}
                  />
                  {previewAudioState === 'running' && (
                    <span className="muted small">preparing {previewAudioProgress}%</span>
                  )}
                  {previewAudioState === 'error' && <span className="muted small">track unavailable</span>}
                </div>
              )}
              <div className="transport-ctl">
                <button
                  type="button"
                  className="icon-btn"
                  title={muted ? 'Unmute' : 'Mute'}
                  onClick={() => setMuted((value) => !value)}
                >
                  {muted || volume === 0 ? '🔇' : '🔊'}
                </button>
                <input
                  type="range"
                  className="transport-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  aria-label="Volume"
                  aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setVolume(next)
                    setMuted(next === 0)
                  }}
                />
              </div>
              <div className="transport-ctl" title="Playback speed">
                <select
                  className="select transport-rate"
                  value={rate}
                  aria-label="Playback speed"
                  onChange={(event) => setRate(Number(event.target.value))}
                >
                  {PLAYBACK_RATES.map((value) => (
                    <option key={value} value={value}>
                      {value.toFixed(2)}×
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="transport-right">
              {range && (
                <span className="range-pill mono">
                  in {timecode(range.start, fps)} · out {timecode(range.end, fps)}
                  <button type="button" className="icon-btn" onClick={() => setRange(null)} title="Clear range">
                    ✕
                  </button>
                </span>
              )}
              <span className="muted small">keeps {timecode(kept, fps)}</span>
              {active?.video && (
                <span className="muted small">
                  {active.video.codec.toUpperCase()} · {active.video.fps.toFixed(2)} fps
                </span>
              )}
            </div>
          </div>

          {active ? (
            <>
              <Timeline
                duration={duration}
                fps={fps}
                accent={accentPreview ?? settings.accent ?? DEFAULT_ACCENT}
                clips={spans.map((span) => ({
                  path: span.info.path,
                  start: span.start,
                  end: span.end,
                  name: span.info.name,
                  index: span.index,
                }))}
                view={view}
                onView={setView}
                segments={segments}
                selectedId={selectedId}
                selectedMarker={selectedMarker}
                range={range}
                waveform={waveWindow}
                filmstrip={filmstrip}
                playhead={playhead}
                snap={snap}
                keyframes={keyframes}
                onSeek={setPlayhead}
                onScrubStart={() => setScrubbing(true)}
                onScrubEnd={() => setScrubbing(false)}
                onSelect={(id) => {
                  setSelectedId(id)
                  if (id) setSelectedMarker(null)
                }}
                onSelectMarker={setSelectedMarker}
                onBoundary={(index, time) => moveBoundary(index, time, true)}
                onBoundaryCommit={boundaryCommit}
                onRange={setRange}
                onReorderClips={reorderClips}
              />
              <TimelineScrollbar
                duration={duration}
                fps={fps}
                view={view}
                segments={segments}
                playhead={playhead}
                onView={setView}
                onSeek={setPlayhead}
                onScrubStart={() => setScrubbing(true)}
                onScrubEnd={() => setScrubbing(false)}
              />
              <div className="zoombar">
                <div className="zoom-controls">
                  <button type="button" className="zoom-btn" onClick={() => stepZoom(1)} title="Zoom in (+)">
                    +
                  </button>
                  <button type="button" className="zoom-btn" onClick={() => stepZoom(-1)} title="Zoom out (−)">
                    −
                  </button>
                  <div className="zoom-slider">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, zoomLevels.length - 1)}
                      step={1}
                      value={zoomIndex}
                      onChange={(event) => {
                        const pick = zoomLevels[Number(event.target.value)]
                        if (pick) applyZoom(pick)
                      }}
                      aria-label="Timeline zoom"
                      aria-valuetext={formatSpan(span)}
                      title={`Timeline zoom — ${formatSpan(span)} visible (0 fits the clip)`}
                    />
                  </div>
                  <div className="zoom-more" ref={zoomMenuRef}>
                    <button
                      type="button"
                      className="zoom-btn"
                      aria-haspopup="menu"
                      aria-expanded={zoomMenuOpen}
                      title="Zoom levels"
                      onClick={() => setZoomMenuOpen((value) => !value)}
                    >
                      ⋮
                    </button>
                    {zoomMenuOpen && (
                      <div className="zoom-menu" role="menu">
                        {zoomLevels.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            role="menuitem"
                            className={currentZoom?.id === entry.id ? 'active' : ''}
                            onClick={() => {
                              applyZoom(entry)
                              setZoomMenuOpen(false)
                            }}
                          >
                            {entry.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <span className="zoombar-label mono" title="Visible range">
                  {formatSpan(span)}
                </span>
                <span className="zoombar-label mono muted" title="Visible start">
                  {shortTimecode(view.start)}
                </span>
                {waveStatus === 'running' && <span className="muted small">reading audio…</span>}
                {waveStatus === 'coarse' && !overview && (
                  <button type="button" className="link-btn" onClick={buildWaveformOverview} title="Decode the whole file once in the background">
                    build full waveform
                  </button>
                )}
                {overview && span > OVERVIEW_SPAN && <span className="muted small">overview</span>}
                <label className="chip-toggle-row" title="Snap dragged markers to keyframes and the playhead">
                  <input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} />
                  <span>snap</span>
                </label>
              </div>
            </>
          ) : (
            <div className="timeline-placeholder muted">Open a recording to see the timeline</div>
          )}
        </main>

        <aside className="inspector">
          <nav className="tabs">
            {TABS.map((entry) => (
              <button key={entry.id} type="button" className={tab === entry.id ? 'active' : ''} onClick={() => setTab(entry.id)}>
                {entry.label}
              </button>
            ))}
            <div className="tab-more" ref={moreRef}>
              <button
                type="button"
                className={MORE_TABS.some((entry) => entry.id === tab) ? 'active' : ''}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                title="More tools"
                onClick={() => setMoreOpen((value) => !value)}
              >
                More <span className="tab-caret">▾</span>
              </button>
              {moreOpen && (
                <div className="tab-menu" role="menu">
                  {MORE_TABS.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      className={tab === entry.id ? 'active' : ''}
                      onClick={() => {
                        setTab(entry.id)
                        setMoreOpen(false)
                      }}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>

          <div className="inspector-body">
            {tab === 'project' && (
              <ProjectPanel
                segments={segments}
                duration={duration}
                fps={fps}
                selectedId={selectedId}
                selectedMarker={selectedMarker}
                range={range}
                canUndo={canUndo}
                canRedo={canRedo}
                onSplit={doSplit}
                onCutOut={doCutOut}
                onKeep={doKeep}
                onCutPrevious={doCutPrevious}
                onInvert={doInvert}
                onClearMarkers={doClearMarkers}
                onDeleteMarker={doDeleteMarker}
                onTrimBefore={doTrimBefore}
                onTrimAfter={doTrimAfter}
                onCutRange={doCutRange}
                onDivide={doDivide}
                onReset={doReset}
                onUndo={undo}
                onRedo={redo}
                onToggle={(id) => {
                  const list = segmentsRef.current
                  const target = list.find((segment) => segment.id === id)
                  if (target) apply(setEnabled(list, id, !target.enabled))
                }}
                onRename={(id, label) => apply(segmentsRef.current.map((segment) => (segment.id === id ? { ...segment, label } : segment)), true)}
                audioTracks={clips[0]?.audioTracks ?? []}
                onAudio={(id, value) =>
                  apply(segmentsRef.current.map((segment) => (segment.id === id ? { ...segment, audio: value } : segment)))
                }
                onBoundary={(index, time) => {
                  moveBoundary(index, time, true)
                  boundaryCommit()
                }}
                onSelect={setSelectedId}
                onSelectMarker={setSelectedMarker}
                onSeek={setPlayhead}
              />
            )}

            {tab === 'export' && (
              <ExportPanel
                info={active}
                projectName={projects.find((project) => project.id === currentProjectId)?.name ?? ''}
                clips={clips}
                segments={segments}
                duration={duration}
                config={exportConfig}
                onConfig={updateConfig}
                tracksByClip={trackByClip}
                presets={presets}
                hardware={hardware}
                onQueue={addJobs}
                onError={notifyError}
              />
            )}

            {tab === 'projects' && (
              <ProjectsPanel
                projects={projects}
                clips={clips}
                segments={segments}
                config={exportConfig}
                currentProjectId={currentProjectId}
                onSave={saveCurrentProject}
                onLoad={loadProject}
                onDelete={removeProject}
                onQueue={queueProjects}
                onError={notifyError}
              />
            )}

            {tab === 'convert' && (
              <ConvertPanel
                presets={presets}
                hardware={hardware}
                settings={settings}
                onQueue={addJobs}
                onError={notifyError}
                onOpenFile={async (path) => {
                  await openFiles([path])
                  setTab('project')
                }}
              />
            )}

            {tab === 'join' && (
              <JoinPanel presets={presets} hardware={hardware} settings={settings} onQueue={addJobs} onError={notifyError} />
            )}

            {tab === 'analyze' && (
              <AnalyzePanel
                info={active}
                job={analyzeJob}
                onRun={async (params) => {
                  await api.addJob({ type: 'analyze', label: `Analyse · ${params.kind}`, params })
                  await api.startQueue()
                }}
                onApplySegments={(next) => {
                  const list = next.map((segment, index) => ({
                    id: uid(),
                    start: segment.start,
                    end: segment.end,
                    label: segment.label || `Part ${index + 1}`,
                    enabled: true,
                  }))
                  apply(normalizePartition(list, duration))
                  setSelectedMarker(null)
                  setTab('project')
                  notify(`${next.length} fragments created`)
                }}
                onShowLog={setLogJobId}
                onError={notifyError}
              />
            )}

            {tab === 'sync' && <SyncPanel info={active} settings={settings} onQueue={addJobs} onError={notifyError} />}
          </div>
        </aside>
      </div>

      <QueuePanel
        queue={queue}
        collapsed={!queueOpen}
        onToggle={() => toggleQueue()}
        onStart={async () => setQueue(await api.startQueue())}
        onPause={async () => setQueue(await api.pauseQueue())}
        onCancelAll={async () => setQueue(await api.cancelAll())}
        onClear={async () => setQueue(await api.clearQueue())}
        onConcurrency={async (value) => setQueue(await api.setConcurrency(value))}
        onAction={queueAction}
        onShowLog={setLogJobId}
        onReveal={revealPath}
        onVerify={verifyOutputFile}
        onResumeInterrupted={async () => {
          const result = await api.resumeInterrupted()
          setQueue(result.queue)
          notify(
            result.resumed
              ? `Requeued ${result.resumed} interrupted job${result.resumed === 1 ? '' : 's'}`
              : 'Nothing was interrupted',
          )
        }}
        onMove={async (id, direction) => {
          const ids = queue.jobs.map((job) => job.id)
          const index = ids.indexOf(id)
          const swap = index + direction
          if (index < 0 || swap < 0 || swap >= ids.length) return
          ;[ids[index], ids[swap]] = [ids[swap], ids[index]]
          setQueue(await api.reorder(ids))
        }}
      />

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {dropActive && (
        <div className="drop-overlay">
          <div>
            <strong>Drop to add clips</strong>
            <span>Drop files anywhere in this window</span>
          </div>
        </div>
      )}

      <AboutModal
        open={aboutOpen}
        tools={tools}
        update={updateStatus}
        onCheckUpdates={() => {
          desktop?.checkForUpdates().then(setUpdateStatus)
        }}
        onInstallUpdate={() => {
          desktop?.installUpdate()
        }}
        onClose={() => setAboutOpen(false)}
      />

      <ShortcutsModal
        open={shortcutsOpen}
        firstRun={firstRun}
        onClose={() => {
          setShortcutsOpen(false)
          setFirstRun(false)
          if (!settings.seenTour) {
            setSettings((current) => ({ ...current, seenTour: true }))
            api.saveSettings({ seenTour: true }).catch(() => undefined)
          }
        }}
        onDismissForever={() => {
          setShortcutsOpen(false)
          setFirstRun(false)
          setSettings((current) => ({ ...current, seenTour: true }))
          api.saveSettings({ seenTour: true }).catch(() => undefined)
        }}
      />

      <QuitModal
        open={quitOpen}
        running={runningJobs}
        queued={waitingJobs}
        support={supportPrompt}
        onCancel={() => setQuitOpen(false)}
        onQuit={() => {
          setQuitOpen(false)
          desktop?.quit()
        }}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        tools={tools}
        paths={paths}
        onClose={() => {
          setSettingsOpen(false)
          setAccentPreview(null)
        }}
        onAccentPreview={setAccentPreview}
        onSave={async (patch) => {
          // Only a project folder move invalidates the open project; any other
          // setting must keep it, because its name drives the export name.
          const projectsMoved = patch.projectsDir !== undefined && patch.projectsDir !== settings.projectsDir
          const result = await api.saveSettings(patch)
          setSettings(result.settings)
          setTools(result.tools)
          setPaths({
            projectsDir: result.projectsDir,
            defaultProjectsDir: result.defaultProjectsDir,
            appDir: result.appDir,
          })
          // The project folder may have moved, so re-read the list.
          api
            .projects()
            .then((list) => setProjects(list.projects))
            .catch(() => undefined)
          if (projectsMoved) setCurrentProjectId(null)
          notify('Settings saved')
        }}
        onRefreshTools={async () => {
          const result = await api.refreshTools()
          setTools(result.tools)
          notify(result.tools.ok ? 'FFmpeg found' : 'FFmpeg still not found', result.tools.ok ? 'info' : 'error')
        }}
        onCheckFfmpegUpdate={() => api.ffmpegUpdateCheck()}
        onStartFfmpegUpdate={async () => {
          const result = await api.startFfmpegUpdate()
          setQueue(result.queue)
          setQueueOpen(true)
        }}
      />

      <JobLog job={logJob} onClose={() => setLogJobId(null)} />

      {!isDesktop && (
        <div className="browser-note">
          {proxyJob?.status === 'running' ? `Preview ${Math.round(proxyJob.progress)}%` : 'Browser preview mode'} ·{' '}
          {humanDuration(duration)} · {active ? bytes(active.size) : ''} · {active ? shortPath(active.path, 30) : ''}
        </div>
      )}
    </div>
  )
}

function step(fps: number): number {
  return frameStep(fps)
}

/** Minimise / restore / close, for the frameless desktop window. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const bridge = desktop?.window

  useEffect(() => {
    if (!bridge) return
    let live = true
    bridge.isMaximized().then((value) => {
      if (live) setMaximized(value)
    })
    const stop = bridge.onMaximizedChange(setMaximized)
    return () => {
      live = false
      stop()
    }
  }, [bridge])

  if (!bridge) return null

  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-btn"
        title="Minimise"
        aria-label="Minimise"
        onClick={() => bridge.minimize()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5h6" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? 'Restore' : 'Maximise'}
        aria-label={maximized ? 'Restore' : 'Maximise'}
        onClick={() => bridge.toggleMaximize().then(setMaximized)}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 3h5v5H3z" />
            <path d="M3 3V2h5v5H7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5h5v5h-5z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-btn win-close"
        title="Close"
        aria-label="Close"
        onClick={() => bridge.close()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
        </svg>
      </button>
    </div>
  )
}
