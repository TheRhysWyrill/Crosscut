import { useEffect, useState } from 'react'
import type { Tools } from '../types'
import { desktop, type UpdateStatus } from '../desktop'
import {
  DONATE_LABEL,
  DONATE_QR,
  DONATE_URL,
  DEVELOPER,
  DEVELOPER_LINK,
  DEVELOPER_URL,
  openLink,
} from '../donation'

interface AboutModalProps {
  open: boolean
  tools: Tools | null
  update: UpdateStatus
  onCheckUpdates: () => void
  onInstallUpdate: () => void
  onClose: () => void
}

const FEATURES = [
  'Lossless cutting copies the streams straight out of the source, so trimming a huge file takes seconds instead of a re-encode.',
  'Several files on one timeline, cut, reordered and joined into a single export in one pass.',
  'Batch encoding to H.264, HEVC, AV1 and ProRes, with hardware acceleration, fades and soft wipes between fragments.',
  'No upload, no cloud, no account. Everything runs locally on the bundled FFmpeg.',
]

export default function AboutModal({ open, tools, update, onCheckUpdates, onInstallUpdate, onClose }: AboutModalProps) {
  const [version, setVersion] = useState('')

  useEffect(() => {
    if (!open) return undefined
    let live = true
    desktop?.info().then((info) => {
      if (live) setVersion(info.version)
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      live = false
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide about"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="About CrossCut"
      >
        <header className="modal-head">
          <div>
            <h2>CrossCut</h2>
            <p className="muted small">
              {version ? `Version ${version} · ` : ''}Lossless video cutting and batch encoding
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        <div className="modal-body about-body">
          <div className="about-copy">
            <p>
              CrossCut is a lightweight desktop video editor built for speed. It opens instantly,
              sips memory and disk space, and still handles files that make a full editing suite
              crawl: lossless cuts, multi-file joins, batch encoding and analysis in one window.
            </p>
            <ul className="about-list">
              {FEATURES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted small">
              Developed by <strong>{DEVELOPER}</strong> ·{' '}
              <button type="button" className="link-btn" onClick={() => openLink(DEVELOPER_URL)}>
                {DEVELOPER_LINK}
              </button>
            </p>
            <p className="muted small">
              {tools?.ok ? `Bundled FFmpeg ${tools.version.split('-')[0]}` : 'FFmpeg'}, GPLv3, built
              by gyan.dev. Source and licence text ship next to the app.
            </p>
            <div className="about-update">
              {update.state === 'ready' ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={onInstallUpdate}>
                  Restart and install {update.version}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={onCheckUpdates}
                  disabled={update.state === 'checking' || update.state === 'downloading'}
                >
                  {update.state === 'checking'
                    ? 'Checking…'
                    : update.state === 'downloading'
                      ? `Downloading ${update.percent}%`
                      : 'Check for updates'}
                </button>
              )}
              {(update.message || update.state === 'available') && (
                <span className={`small ${update.state === 'error' ? 'warn-text' : 'muted'}`}>{update.message}</span>
              )}
            </div>
          </div>

          <div className="donate-card">
            <span className="donate-title">Free, and staying that way</span>
            <img className="donate-qr" src={DONATE_QR} alt="Donation QR code" width={176} height={176} />
            <span className="muted small">Scan with your phone</span>
            <button type="button" className="btn" onClick={() => openLink(DONATE_URL)}>
              {DONATE_LABEL}
            </button>
          </div>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
