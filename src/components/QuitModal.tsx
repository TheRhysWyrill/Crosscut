import { useEffect } from 'react'
import { DONATE_LABEL, DONATE_QR, DONATE_URL, openLink } from '../donation'

interface QuitModalProps {
  open: boolean
  /** Jobs still encoding: quitting now throws that work away. */
  running: number
  queued: number
  /** The support card only belongs to the published installer. */
  support: boolean
  onCancel: () => void
  onQuit: () => void
}

/**
 * Shown when the window is closed, before the app actually exits. The queue is
 * the first thing it mentions: closing with work in flight is the one way this
 * app can lose an hour of encoding. The support card follows afterwards, and
 * only in a published build.
 */
export default function QuitModal({ open, running, queued, support, onCancel, onQuit }: QuitModalProps) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const busy = running + queued
  const stopMessage =
    running > 0
      ? `${running} job${running === 1 ? ' is' : 's are'} still encoding${queued ? ` and ${queued} more ${queued === 1 ? 'is' : 'are'} waiting` : ''}. Closing now cancels ${running === 1 ? 'it' : 'them'} and leaves a partial file behind.`
      : `${queued} job${queued === 1 ? ' is' : 's are'} still in the queue. ${queued === 1 ? 'It has' : 'They have'} not started yet, and closing keeps ${queued === 1 ? 'it' : 'them'} for the next launch.`

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className={`modal quit${busy ? ' quit-busy' : ''}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={busy ? 'Jobs are still running' : 'Thanks for using CrossCut'}
      >
        <div className="modal-body quit-body">
          <span className="quit-mark">{busy ? '⏳' : '✕'}</span>
          <h2>{busy ? (running > 0 ? 'Still encoding' : 'Queue still waiting') : 'Thanks for using CrossCut'}</h2>

          {busy ? (
            <>
              <p className="muted small">{stopMessage}</p>
              {queued > 0 && running === 0 && (
                <p className="muted small">
                  Nothing is lost: the queue is saved, and the next launch offers to pick it up again.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="muted small">
                It is free, has no ads and no account, and it always will be. If it saved you a few hours,
                you can buy me a coffee.
              </p>
              {support && (
                <>
                  <img className="donate-qr" src={DONATE_QR} alt="Donation QR code" width={176} height={176} />
                  <button type="button" className="link-btn" onClick={() => openLink(DONATE_URL)}>
                    {DONATE_LABEL}
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <footer className="modal-foot quit-foot">
          {/* Focus stays on the safe choice: a stray Enter must not quit the app. */}
          <button type="button" className="btn" onClick={onCancel} autoFocus>
            {running > 0 ? 'Keep encoding' : busy ? 'Keep the queue' : 'Keep editing'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onQuit}>
            {running > 0 ? `Quit and stop ${running === 1 ? 'the job' : 'the jobs'}` : busy ? 'Close CrossCut' : 'Close CrossCut'}
          </button>
        </footer>
      </div>
    </div>
  )
}
