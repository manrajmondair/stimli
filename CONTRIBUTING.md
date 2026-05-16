# Contributing to Stimli

Thanks for the interest. Stimli is a small research codebase, so the
contribution loop is intentionally lightweight.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/manrajmondair/stimli.git
cd stimli
npm install

# 2. Run the suite to confirm a clean baseline
npm test

# 3. Pick the dev path that matches what you want to change
npm run dev:frontend    # Vite + FastAPI, fast iteration on the React shell
npm run dev:pages       # Wrangler Pages dev, production-parity Cloudflare runtime
```

See `README.md` → "Local development" for the longer version including
Modal inference and Docker.

## What we accept

Good fits:

- Bug fixes with a regression test (or a clear repro in the PR description).
- UX polish that improves accessibility, mobile responsiveness, or error
  recovery on existing flows.
- Backend hardening: better error messages, idempotency on side-effectful
  routes, performance wins on hot paths.
- Documentation: clearer setup, better examples in the README, expanded
  comments around non-obvious code.

Not great fits without discussion first:

- New top-level features. Open an issue to align on scope before writing
  code; otherwise we might already be working on something incompatible.
- Refactors that move large amounts of code without a behavior change.
- Dependency upgrades that affect bundle size or the Cloudflare Workers
  runtime contract. Open an issue first.

## House style

- Plain JavaScript on the backend (Cloudflare Pages Functions, no TypeScript
  in `functions/`). TypeScript on the frontend.
- Comments explain *why* (constraints, gotchas), not *what* — the identifier
  names handle the *what*.
- Keep changes scoped. A bug fix doesn't need a surrounding cleanup; a new
  feature doesn't need to refactor adjacent code unless it directly blocks
  the feature.
- New behavior gets a test. The test harness lives in `tests/` for the API
  and `frontend/src/test/` for the UI.

## Pull request checklist

Before opening a PR:

- [ ] `npm test` passes locally.
- [ ] If you touched the API, you added or updated a test in
      `tests/serverless-api.test.js`.
- [ ] If you touched a React surface, you ran it manually (Wrangler Pages
      dev or Vite dev) and the change works in a real browser.
- [ ] PR title is short (under 70 chars) and uses the imperative mood
      ("Add seat enforcement", not "Added seat enforcement").
- [ ] PR description explains *why* and links any related issue.

CI runs the full suite (`npm test`) on every PR; main-branch deploys are
gated on the same suite passing.

## Reporting bugs

Open a GitHub issue with:

1. What you expected to happen.
2. What actually happened.
3. Reproduction steps — ideally a minimal repo or a deploy URL.
4. Browser / Node / OS version when relevant.

For security issues, follow `SECURITY.md` instead.
