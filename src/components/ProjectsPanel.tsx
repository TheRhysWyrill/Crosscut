import { useEffect, useState } from 'react'
import type { ExportConfig, MediaInfo, SavedProject, Segment } from '../types'
import { baseName, shortTimecode } from '../format'

interface ProjectsPanelProps {
  projects: SavedProject[]
  clips: MediaInfo[]
  segments: Segment[]
  config: ExportConfig
  currentProjectId: string | null
  onSave: (name: string, id?: string) => Promise<void>
  onLoad: (project: SavedProject) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onQueue: (projects: SavedProject[], startNow: boolean) => Promise<void>
  onError: (message: string) => void
}

const MODE_LABEL: Record<string, string> = {
  lossless: 'lossless',
  smart: 'smart render',
  encode: 're-encode',
}

function keptSeconds(project: SavedProject): number {
  return project.segments.reduce((sum, segment) => (segment.enabled ? sum + (segment.end - segment.start) : sum), 0)
}

function audioNote(project: SavedProject, config: ExportConfig): string {
  const mode = config.audioMode ?? 'first'
  if (mode === 'both' && project.audioTracks.length > 1) return ` · ${project.audioTracks.length} audio runs`
  if (mode === 'all') return ' · all audio'
  if (mode.startsWith('track:')) return ' · one track'
  return ''
}

export default function ProjectsPanel({
  projects,
  clips,
  segments,
  config,
  currentProjectId,
  onSave,
  onLoad,
  onDelete,
  onQueue,
  onError,
}: ProjectsPanelProps) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!clips.length) {
      setName('')
      return
    }
    const existing = projects.find((project) => project.id === currentProjectId)
    setName(existing?.name ?? baseName(clips[0].path))
  }, [clips, currentProjectId, projects])

  const current = projects.find((project) => project.id === currentProjectId) ?? null
  const chosen = projects.filter((project) => selected.includes(project.id))

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel projects-panel">
      <section className="block">
        <h3>Current project</h3>
        {clips.length > 0 ? (
          <>
            <label className="field">
              <span>Name</span>
              <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <p className="hint">
              Saves {clips.length === 1 ? 'the recording' : `all ${clips.length} recordings and their order`}, the{' '}
              {segments.length} fragment{segments.length === 1 ? '' : 's'} and the export settings (mode, audio track,
              naming, folder). Load it later or send it to the batch.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !name.trim()}
                onClick={() => run(() => onSave(name.trim(), currentProjectId ?? undefined))}
              >
                {current ? 'Update project' : 'Save project'}
              </button>
              {current && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy || !name.trim()}
                  onClick={() => run(() => onSave(name.trim(), undefined))}
                >
                  Save as copy
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="hint">Open a clip to save it as a project.</p>
        )}
      </section>

      <section className="block">
        <h3>Saved projects</h3>
        {projects.length === 0 ? (
          <p className="hint">Nothing saved yet. A saved project holds its cut list, audio choice and export settings.</p>
        ) : (
          <ul className="project-list">
            {projects.map((project) => {
              const isCurrent = project.id === currentProjectId
              return (
                <li key={project.id} className={`project-row${isCurrent ? ' current' : ''}`}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={selected.includes(project.id)}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, project.id]
                            : previous.filter((id) => id !== project.id),
                        )
                      }
                    />
                    <span className="project-name ellipsis" title={project.source}>
                      {project.name}
                    </span>
                  </label>
                  <div className="project-meta muted small">
                    {project.clips?.length > 1
                      ? `${project.clips.length} clips`
                      : baseName(project.source)}{' '}
                    · keeps {shortTimecode(keptSeconds(project))} ·{' '}
                    {MODE_LABEL[project.export?.mode ?? 'lossless'] ?? project.export?.mode}
                    {audioNote(project, project.export ?? config)}
                  </div>
                  <div className="project-actions">
                    <button type="button" className="btn btn-xs" disabled={busy} onClick={() => run(() => onLoad(project))}>
                      Load
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      disabled={busy}
                      title="Delete project"
                      onClick={() => run(() => onDelete(project.id))}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <footer className="panel-foot">
        <div className="summary">
          <strong>{chosen.length}</strong> selected ·{' '}
          {chosen.reduce((sum, project) => sum + keptSeconds(project), 0) > 0
            ? shortTimecode(chosen.reduce((sum, project) => sum + keptSeconds(project), 0))
            : '0:00'}{' '}
          to process
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} />
          <span>Start processing immediately</span>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy || chosen.length === 0}
          onClick={() => run(() => onQueue(chosen, startNow))}
        >
          {busy ? 'Adding…' : chosen.length ? `Add ${chosen.length} to batch` : 'Add to batch'}
        </button>
      </footer>
    </div>
  )
}
