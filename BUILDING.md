# Building Chartroom Voyages

The site is plain HTML, CSS and JavaScript with no build step. You need [Node.js](https://nodejs.org/) 22 or later.

- `npm test` runs the checks for voyage files, worlds, courses, race timing and submissions.
- `npm run preview` serves the site at `http://localhost:8765` as it is in the repository.
- `npm run preview:demo` serves a temporary copy with a few made-up voyages and race runs, so every page has something to show. The repository itself isn't changed.
- `npm run build` rebuilds `data/` from `courses/`, `worlds/`, `voyages/` and `runs/`. The submission Action does this after each accepted submission.

Submissions arrive as GitHub issues from the forms in `.github/ISSUE_TEMPLATE`. The workflow in `.github/workflows/submissions.yml` runs `scripts/submit.mjs` on each one, commits what it accepts and replies on the issue.
