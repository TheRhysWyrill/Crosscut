import type { MediaInfo, VideoStream } from './types'

/**
 * What kind of high dynamic range a recording carries, if any.
 *
 * PQ is HDR10 and HLG is what phones and broadcast cameras record; both look
 * wrong played back as if they were plain SDR, which is why the export panel
 * says so before anything is re-encoded.
 */
export function hdrKind(video: VideoStream | null | undefined): 'HDR10' | 'HLG' | null {
  if (!video) return null
  const transfer = String(video.colorTransfer ?? '').toLowerCase()
  if (transfer === 'smpte2084') return 'HDR10'
  if (transfer === 'arib-std-b67') return 'HLG'
  return null
}

export function isHdrInfo(info: MediaInfo | null | undefined): boolean {
  return hdrKind(info?.video) !== null
}
