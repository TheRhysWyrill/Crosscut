export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error' | 'unavailable'
  version: string
  percent: number
  message: string
}

export interface DesktopBridge {
  openMedia(options?: { title?: string; multiple?: boolean; defaultPath?: string }): Promise<string[]>
  openFiles(options?: { title?: string; multiple?: boolean; defaultPath?: string; filters?: unknown[] }): Promise<string[]>
  openDirectory(options?: { title?: string; defaultPath?: string }): Promise<string>
  pickFfmpegFolder(): Promise<string>
  reveal(target: string): Promise<boolean>
  openPath(target: string): Promise<boolean>
  info(): Promise<{
    version: string
    platform: string
    dataDir: string
    apiUrl: string
    electron: string
    /** True only for the published installer, so the support card is not shown while developing. */
    support: boolean
    packaged: boolean
  }>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<boolean>
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  pathForFile(file: File): string
  /** Fires when the user tries to close the window, before the app exits. */
  onQuitRequest(callback: () => void): () => void
  /** Close the window for real, skipping the quit prompt. */
  quit(): Promise<boolean>
  window?: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<boolean>
    isMaximized(): Promise<boolean>
    onMaximizedChange(callback: (maximized: boolean) => void): () => void
  }
}

declare global {
  interface Window {
    desktop?: DesktopBridge
  }
}

export const desktop: DesktopBridge | null =
  typeof window !== 'undefined' ? (window.desktop ?? null) : null

export const IDLE_UPDATE: UpdateStatus = { state: 'idle', version: '', percent: 0, message: '' }

export const isDesktop = Boolean(desktop)

/** Ask for one or more media files. Uses the native dialog inside the desktop app. */
export async function pickMedia(multiple = true, title = 'Open media'): Promise<string[]> {
  if (desktop) return desktop.openMedia({ multiple, title })
  const answer = window.prompt(`${title} — enter a full file path`)
  return answer ? [answer] : []
}

export async function pickDirectory(title = 'Choose folder', defaultPath?: string): Promise<string> {
  if (desktop) return desktop.openDirectory({ title, defaultPath })
  const answer = window.prompt(`${title}\n\nEnter a full folder path`, defaultPath ?? '')
  return answer ?? ''
}

export async function pickFiles(multiple = true, title = 'Select files'): Promise<string[]> {
  if (desktop) return desktop.openFiles({ multiple, title })
  const answer = window.prompt(`${title} — enter a full file path`)
  return answer ? [answer] : []
}

export async function revealPath(target: string): Promise<void> {
  if (desktop) {
    await desktop.reveal(target)
    return
  }
  await navigator.clipboard?.writeText(target).catch(() => undefined)
}
