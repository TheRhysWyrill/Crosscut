# Contributing to CrossCut

Thanks for wanting to help. CrossCut is a small desktop app, so a short set of
rules keeps it easy to review.

## Before you open a pull request

1. `npm ci`
2. `npm run ffmpeg` once, to fetch the bundled FFmpeg pair.
3. `npm run typecheck` and `npm run build` must both pass.
4. If you touched anything in `server/tasks.mjs`, run one real export through
   the queue and confirm the output plays, keeps its length and stays in sync.

## What not to commit

- `vendor/ffmpeg/**` — the binaries are over GitHub's 100 MB file limit and are
  downloaded by `npm run ffmpeg`.
- `release/**`, `dist/**`, `data/**` — build output and local state.
- Anything under `%APPDATA%\CrossCut` — settings, queue and caches.

## Style

- Match the file you are editing: the server is plain ES modules with no
  framework, the renderer is React with hooks and no state library.
- Comments explain why a thing is done, not what the line does.
- Exports must stay single-pass where they already are. If a change makes a
  lossless export re-encode, or adds a second full-file pass, it needs a note in
  the pull request explaining why it is unavoidable.

## Bug reports

Use the bug template and include the job log (queue row → `≡`) if a job failed.
That log has the exact ffmpeg command and its last lines, which is usually
enough to find the problem without the source file.

## Licensing

CrossCut is GPL-3.0-only. By contributing you agree your changes are released
under that licence.
