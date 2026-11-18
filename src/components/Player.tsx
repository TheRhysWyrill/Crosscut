import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { MediaInfo } from '../types'

/** Length of one extracted stretch of an audio track, in seconds. */
const AUDIO_WINDOW = 600

export interface PlayerClip {
  path: string
  start: number
  duration: number
}

interface PlayerProps {
  clips: PlayerClip[]
  info: MediaInfo | null
  /** Time on the project timeline, not inside a single recording. */
  playhead: number
  playing: boolean
  proxies: Record<string, string>
  /** Stream index of the audio track being previewed. */
  track: number
  /** 0..1, and whether the preview is muted. */
  volume: number
  muted: boolean
  /** Playback speed multiplier. */
  rate: number
  /** True while the rail is dragged: the playhead moves, the picture stays. */
  holdSeek: boolean
  onAudioStatus: (state: string, progress: number) => void
  onTime: (time: number) => void
  onPlayingChange: (playing: boolean) => void
  onBuildProxy: () => void
  proxyBusy: boolean
}

export default function Player({
  clips,
  info,
  playhead,
  playing,
  proxies,
  track,
  volume,
  muted,
  rate,
  holdSeek,
  onAudioStatus,
  onTime,
  onPlayingChange,
  onBuildProxy,
  proxyBusy,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  const [alt, setAlt] = useState<{ state: string; path: string | null; start: number }>({
    state: 'idle',
    path: null,
    start: 0,
  })
  // True only once the pulled-out track is really producing sound, so a track
  // that is still loading never leaves the preview silent.
  const [altReady, setAltReady] = useState(false)
  const lastReport = useRef(0)
  const seekGuard = useRef(0)

  // Which recording the playhead is inside, and how far into it.
  const current = useMemo(() => {
    if (!clips.length) return null
    const time = Math.max(0, playhead)
    const span = clips.find((clip) => time >= clip.start && time < clip.start + clip.duration - 1e-4)
    if (span) return { clip: span, local: time - span.start }
    const last = clips[clips.length - 1]
    return { clip: last, local: last.duration }
  }, [clips, playhead])

  const clip = current?.clip ?? null
  const clipPath = clip?.path ?? null
  // Primitive, so the track effect below is not restarted on every playhead tick.
  const clipDuration = clip?.duration ?? 0
  const local = current?.local ?? 0
  const src = clip ? api.streamUrl(proxies[clip.path] || clip.path) : null
  // Kept in a ref so the loadedmetadata retry can seek to the latest position.
  const localRef = useRef(local)
  localRef.current = local

  const tracks = info?.audioTracks ?? []
  const trackPosition = tracks.findIndex((entry) => entry.index === track)
  // Track one is what the video element already plays; anything else has to be
  // pulled out of the file first.
  const alternate = tracks.length > 1 && trackPosition > 0 ? track : null
  const altSrc = alt.path ? api.streamUrl(alt.path) : null
  // Only ten minutes of the chosen track are written at a time, so switching is
  // quick on a long recording instead of waiting for the whole track to copy.
  const windowStart = Math.floor(local / AUDIO_WINDOW) * AUDIO_WINDOW
  // Clip, track and window of the file already read or being read, so landing
  // inside a window that is already playing never starts a second read.
  const altKey = useRef('')

  useEffect(() => {
    setAltReady(false)
  }, [altSrc])

  useEffect(() => {
    setFailed(false)
  }, [src])

  // A track the browser cannot switch to inside the file is written to its own
  // AAC file and played alongside the muted picture. Cached for the next time.
  useEffect(() => {
    if (!clipPath || alternate === null) {
      altKey.current = ''
      setAlt({ state: 'idle', path: null, start: 0 })
      onAudioStatus('idle', 0)
      return
    }
    // A drag along the rail passes over a lot of project, and every window it
    // crossed does not need its own file: the stretch already playing carries
    // on untouched, and the window the pointer lands on is read once, after it
    // lands. Until that window is ready the picture keeps its own audio, rather
    // than sitting muted behind a track that is still being written.
    if (holdSeek) return
    const key = `${clipPath}|${alternate}|${windowStart}`
    if (altKey.current === key) return
    altKey.current = key
    setAlt({ state: 'loading', path: null, start: windowStart })
    setAltReady(false)
    onAudioStatus('loading', 0)
    // Only a newer landing stops this read; a re-render does not, or the sound
    // would be left half-read with nothing coming to fetch it again.
    const current = () => altKey.current === key
    const watch = async () => {
      for (;;) {
        const state = await api.audioTrack(clipPath, alternate, windowStart, AUDIO_WINDOW)
        if (!current()) return
        setAlt({ state: state.state, path: state.path, start: windowStart })
        onAudioStatus(state.state, Math.round(state.progress))
        if (state.state !== 'running') return
        await new Promise((resolve) => window.setTimeout(resolve, 150))
        if (!current()) return
      }
    }
    void watch().catch(() => {
      if (!current()) return
      // Let a later landing try this window again instead of writing it off.
      altKey.current = ''
      setAlt({ state: 'error', path: null, start: windowStart })
      onAudioStatus('error', 0)
    })
    // Reading the next window while this one plays keeps a long preview from
    // stopping at the join. This is only a warm-up for the cache.
    if (clipDuration > windowStart + AUDIO_WINDOW) {
      window.setTimeout(() => {
        if (!current()) return
        void api.audioTrack(clipPath, alternate, windowStart + AUDIO_WINDOW, AUDIO_WINDOW).catch(() => undefined)
      }, 1500)
    }
  }, [clipPath, clipDuration, alternate, windowStart, onAudioStatus, holdSeek])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return
    // A dragged playhead moves many times a second; seeking the picture for
    // every pointer position makes the drag stutter, so it holds still here
    // and lands once the pointer comes up.
    if (holdSeek) return
    if (Math.abs(video.currentTime - local) > 0.3) {
      try {
        seekGuard.current = Date.now()
        video.currentTime = local
      } catch {
        /* not seekable yet */
      }
    }
  }, [local, src, holdSeek])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Holding the rail only parks the picture on the frame it was showing. The
    // sound is never taken away for it: it carries on until the pointer lands,
    // which is where the picture catches up.
    if (playing) {
      video.play().catch(() => onPlayingChange(false))
    } else {
      video.pause()
    }
  }, [playing, onPlayingChange, src])

  // Volume and speed belong to both the picture's own audio and the pulled-out
  // track, whichever one is carrying the sound right now.
  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = volume
      // The picture keeps its own audio until the chosen track is playing, so
      // a slow or failed extraction can never leave the preview silent.
      video.muted = muted || (altReady && Boolean(altSrc))
      video.playbackRate = rate
      video.preservesPitch = true
    }
    const audio = audioRef.current
    if (audio) {
      audio.volume = volume
      audio.muted = muted
      audio.playbackRate = rate
      audio.preservesPitch = true
    }
  }, [volume, muted, rate, altSrc, altReady, src, playing])

  // Keep the pulled-out track glued to the picture, including across seeks.
  useEffect(() => {
    const audio = audioRef.current
    if (!altSrc) return
    const sync = () => {
      const audio = audioRef.current
      const video = videoRef.current
      if (!audio || !video || audio.readyState < 1) return
      const target = video.currentTime - alt.start
      if (target >= 0 && Math.abs(audio.currentTime - target) > 0.12) {
        try {
          audio.currentTime = target
        } catch {
          /* not seekable yet */
        }
      }
    }
    // Line the track up first, then start it, so it never plays from the top.
    sync()
    if (playing) void audio?.play().catch(() => undefined)
    else audio?.pause()
    const timer = window.setInterval(() => {
      const element = audioRef.current
      if (!element) return
      if (playing && element.paused) void element.play().catch(() => undefined)
      if (!playing && !element.paused) element.pause()
      sync()
    }, 250)
    return () => window.clearInterval(timer)
  }, [altSrc, playing, clipPath, src, alt.start])

  useEffect(() => {
    // While the rail is held the playhead belongs to the pointer, so the
    // paused picture must not keep reporting the frame it is parked on.
    if (!playing || holdSeek || !clip) return
    let raf = 0
    const tick = () => {
      const video = videoRef.current
      if (video) {
        const now = Date.now()
        if (now - lastReport.current > 90 && now - seekGuard.current > 140) {
          lastReport.current = now
          // Hand over to the next recording at its boundary instead of stopping.
          const index = clips.findIndex((entry) => entry.path === clip.path)
          const next = clips[index + 1]
          if (next && video.currentTime >= clip.duration - 0.08) {
            onTime(next.start)
            return
          }
          onTime(clip.start + Math.min(video.currentTime, clip.duration))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, holdSeek, onTime, clip, clips])

  if (!info) {
    return (
      <div className="player player-empty">
        <div className="player-empty-inner">
          <div className="player-empty-mark">◫</div>
          <h2>No clip loaded</h2>
          <p>Open a recording to start cutting. Everything runs locally through FFmpeg.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="player">
      {!failed && clip && (
        <video
          key={clip.path}
          ref={videoRef}
          src={src ?? undefined}
          preload="auto"
          onError={() => setFailed(true)}
          onLoadedMetadata={(event) => {
            // A seek issued before the file was ready is dropped, so repeat it here;
            // this is what makes the picture follow a jump into another recording.
            const video = event.currentTarget
            const target = localRef.current
            if (Math.abs(video.currentTime - target) > 0.05) {
              try {
                video.currentTime = target
              } catch {
                /* not seekable yet */
              }
            }
          }}
          onEnded={() => {
            const index = clips.findIndex((entry) => entry.path === clip.path)
            const next = clips[index + 1]
            if (next) onTime(next.start)
            else onPlayingChange(false)
          }}
          onClick={() => onPlayingChange(!playing)}
          className="player-video"
        />
      )}

      {altSrc && (
        <audio
          ref={audioRef}
          src={altSrc}
          preload="auto"
          onPlaying={() => setAltReady(true)}
          onCanPlay={() => {
            // A play() issued while the file was still loading can be dropped.
            if (playing) void audioRef.current?.play().catch(() => undefined)
          }}
          onError={() => {
            setAltReady(false)
            onAudioStatus('error', 0)
          }}
          onLoadedMetadata={() => {
            const audio = audioRef.current
            const video = videoRef.current
            if (!audio || !video) return
            const target = video.currentTime - alt.start
            if (target >= 0 && Math.abs(audio.currentTime - target) > 0.05) {
              try {
                audio.currentTime = target
              } catch {
                /* not seekable yet */
              }
            }
          }}
        />
      )}

      {failed && (
        <div className="player-fallback">
          <div className="player-empty-mark">⚠</div>
          <h3>This codec will not play in the browser</h3>
          <p>
            {info.video?.codec?.toUpperCase()} in {info.formatName?.split(',')[0] || 'this container'} cannot be decoded here.
            Build a small H.264 preview and keep editing — the original file is never touched.
          </p>
          <button type="button" className="btn btn-primary" onClick={onBuildProxy} disabled={proxyBusy}>
            {proxyBusy ? 'Building preview…' : 'Build preview proxy'}
          </button>
        </div>
      )}

      {info.isAudioOnly && !failed && (
        <div className="player-audio">
          <div className="player-audio-bars" aria-hidden>
            {Array.from({ length: 24 }).map((_, index) => (
              <span key={index} style={{ animationDelay: `${index * 60}ms` }} />
            ))}
          </div>
          <div className="player-audio-label">Audio only · {info.audio?.codec?.toUpperCase()}</div>
        </div>
      )}

      {clips.length > 1 && (
        <div className="player-clip-badge" title="This recording and where it sits on the project timeline">
          {clips.findIndex((entry) => entry.path === clip?.path) + 1} / {clips.length} · {clip ? info.name : ''}
        </div>
      )}

      <a className="player-open-external" href={clip ? api.streamUrl(proxies[clip.path] || clip.path) : '#'} target="_blank" rel="noreferrer">
        open in player
      </a>
    </div>
  )
}
