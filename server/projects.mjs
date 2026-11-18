import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { projectDirectory, safeName, writeJson } from './config.mjs'

// Projects are stored under the name the user gave them, so the folder reads
// like a list of projects instead of a pile of UUIDs.
const fileFor = (name) => path.join(projectDirectory(), `${safeName(name, 'Untitled project')}.json`)

function projectFiles() {
  try {
    return fs
      .readdirSync(projectDirectory())
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(projectDirectory(), name))
  } catch {
    return []
  }
}

// The id lives inside the record, so a rename can still find the old file.
function findById(id) {
  if (!id) return null
  for (const file of projectFiles()) {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (record?.id === id) return { file, record }
    } catch {
      /* skip a corrupt file */
    }
  }
  return null
}

// Never overwrite a different project that happens to share the name.
function availableFile(record, previous) {
  const target = fileFor(record.name)
  const same = (a, b) => a && b && path.resolve(a) === path.resolve(b)
  if (same(target, previous) || !fs.existsSync(target)) return target
  const stem = path.basename(target, '.json')
  for (let i = 2; i < 5000; i += 1) {
    const next = path.join(path.dirname(target), `${stem} (${i}).json`)
    if (same(next, previous) || !fs.existsSync(next)) return next
  }
  return path.join(path.dirname(target), `${stem}-${Date.now()}.json`)
}

function cleanSegments(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((segment) => ({
      id: String(segment?.id ?? crypto.randomUUID()),
      start: Math.max(0, Number(segment?.start) || 0),
      end: Math.max(0, Number(segment?.end) || 0),
      label: typeof segment?.label === 'string' ? segment.label.slice(0, 120) : '',
      enabled: segment?.enabled !== false,
      // A fragment that switches audio track must still do so after a save.
      audio: typeof segment?.audio === 'string' ? segment.audio : '',
    }))
    .filter((segment) => segment.end > segment.start)
}

function cleanAudioTracks(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((track) => ({
      index: Number(track?.index) || 0,
      codec: String(track?.codec ?? ''),
      channels: Number(track?.channels) || 0,
      language: String(track?.language ?? ''),
      title: String(track?.title ?? ''),
    }))
    .filter((track) => track.index >= 0)
}

/** The preview/export track picked for each recording, keyed by source path. */
function cleanTracks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    const index = Number(value)
    if (!key || !Number.isInteger(index) || index < 0) continue
    out[String(key)] = index
  }
  return out
}

function cleanClips(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((clip) => ({
      path: String(clip?.path ?? ''),
      offset: Math.max(0, Number(clip?.offset) || 0),
      duration: Math.max(0, Number(clip?.duration) || 0),
    }))
    .filter((clip) => clip.path)
}

function clean(input, existing) {
  const now = Date.now()
  const clips = cleanClips(input?.clips ?? existing?.clips)
  const record = {
    id: String(input?.id || existing?.id || crypto.randomUUID()),
    name: safeName(input?.name, existing?.name || 'Untitled project'),
    source: String(input?.source ?? existing?.source ?? clips[0]?.path ?? ''),
    duration: Number(input?.duration ?? existing?.duration) || 0,
    clips,
    segments: cleanSegments(input?.segments ?? existing?.segments),
    audioTracks: cleanAudioTracks(input?.audioTracks ?? existing?.audioTracks),
    tracks: cleanTracks(input?.tracks ?? existing?.tracks),
    export: { ...(existing?.export ?? {}), ...(input?.export && typeof input.export === 'object' ? input.export : {}) },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return record
}

export function listProjects() {
  const projects = []
  for (const file of projectFiles()) {
    let record = null
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // skip a corrupt file rather than losing the rest
    }
    if (!record || typeof record !== 'object' || !record.id) continue

    // Projects saved by older versions were named after their id: move them
    // to the name the user gave them, if that name is free.
    const target = fileFor(record.name)
    let current = file
    if (path.basename(file) !== path.basename(target) && !fs.existsSync(target)) {
      try {
        fs.renameSync(file, target)
        current = target
      } catch {
        /* keep the old name if it cannot be moved */
      }
    }
    // Very old records predate the name field; fall back to the file name.
    if (typeof record.name !== 'string' || !record.name.trim()) {
      record.name = path.basename(current, '.json')
    }
    projects.push(record)
  }
  return projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function saveProject(input) {
  const id = input?.id ? String(input.id) : ''
  const found = id ? findById(id) : null
  const record = clean(input ?? {}, found?.record ?? null)
  const file = availableFile(record, found?.file ?? null)
  writeJson(file, record)
  if (found?.file && path.resolve(found.file) !== path.resolve(file)) {
    try {
      fs.unlinkSync(found.file)
    } catch {
      /* the new file is written; a leftover old one is harmless */
    }
  }
  return record
}

export function deleteProject(id) {
  const found = findById(id)
  if (!found) return false
  try {
    fs.unlinkSync(found.file)
    return true
  } catch {
    return false
  }
}
