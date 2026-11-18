import { useEffect } from 'react'

interface ShortcutsModalProps {
  open: boolean
  /** True the first time it opens by itself, so the wording can say so. */
  firstRun: boolean
  onClose: () => void
  onDismissForever: () => void
}

const WORKFLOW: { title: string; body: string }[] = [
  {
    title: '1 · Bring in recordings',
    body: 'Open media, or drop files anywhere in the window. Every recording is appended to the timeline in order; nothing is copied or moved.',
  },
  {
    title: '2 · Cut',
    body: 'Space plays. Put the playhead inside a fragment and press M to split, D to cut it out, S to keep it, F to cut the fragment before it. I flips every kept and cut fragment.',
  },
  {
    title: '3 · Zoom in',
    body: 'Scroll on the timeline to zoom around the pointer, + and − step through the zoom levels, 0 fits the whole project. Drag a fragment edge to move the cut.',
  },
  {
    title: '4 · Export',
    body: 'Lossless copy is instant and exact. Smart render re-encodes only the frames around a cut. Re-encode is for changing format. Everything lands in the queue, where the log for any job is one click away.',
  },
]

const KEYS: { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause the preview' },
  { keys: ', · .', action: 'One frame back / forward (Shift for a whole second)' },
  { keys: 'M or L', action: 'Split the fragment at the playhead' },
  { keys: 'D', action: 'Cut out the selected fragment' },
  { keys: 'S', action: 'Keep the selected fragment' },
  { keys: 'F', action: 'Cut out the fragment before the selected one' },
  { keys: 'I', action: 'Invert: swap every kept and cut fragment' },
  { keys: 'Delete', action: 'Remove the selected marker' },
  { keys: 'Home / End', action: 'Start / end of the project' },
  { keys: 'Alt+Home / Alt+End', action: 'Start / end of the recording under the playhead' },
  { keys: 'Alt+← / Alt+→', action: 'Scroll the timeline by a tenth of the view' },
  { keys: '+ / −', action: 'Zoom in / out' },
  { keys: '0', action: 'Fit the whole project in the timeline' },
  { keys: 'Ctrl+Z / Ctrl+Shift+Z', action: 'Undo / redo a cut' },
  { keys: 'Ctrl+S', action: 'Save the current project' },
  { keys: 'Ctrl+C', action: 'Clear every cut and marker' },
  { keys: '?', action: 'Open this reference' },
]

/**
 * The shortcut reference. It also opens by itself on the first launch, because
 * the workflow (fragment, marker, queue) is not guessable from the buttons.
 */
export default function ShortcutsModal({ open, firstRun, onClose, onDismissForever }: ShortcutsModalProps) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide shortcuts"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={firstRun ? 'Getting started with CrossCut' : 'Keyboard shortcuts'}
      >
        <header className="modal-head">
          <div>
            <h2>{firstRun ? 'Welcome to CrossCut' : 'Keyboard shortcuts'}</h2>
            <p className="muted small">
              {firstRun
                ? 'Four steps from a raw recording to an export. Press ? any time to see this again.'
                : 'Everything works from the keyboard while the timeline has focus.'}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        <div className="modal-body shortcuts-body">
          <ol className="shortcut-steps">
            {WORKFLOW.map((step) => (
              <li key={step.title}>
                <strong>{step.title}</strong>
                <span className="muted small">{step.body}</span>
              </li>
            ))}
          </ol>
          <div className="shortcut-keys">
            {KEYS.map((entry) => (
              <div className="shortcut-row" key={entry.keys}>
                <kbd>{entry.keys}</kbd>
                <span>{entry.action}</span>
              </div>
            ))}
          </div>
        </div>

        <footer className="modal-foot">
          {!firstRun && (
            <button type="button" className="btn btn-ghost" onClick={onDismissForever}>
              Hide the welcome screen
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            {firstRun ? 'Start editing' : 'Close'}
          </button>
        </footer>
      </div>
    </div>
  )
}
