# Security policy

Stimli is a small research project, but it does handle authenticated user data
(Clerk-managed identities, workspace assets, Stripe customer ids). Take
security findings seriously.

## Reporting a vulnerability

If you find a vulnerability, please **do not** open a public issue. Instead:

1. Open a [private security advisory](https://github.com/manrajmondair/stimli/security/advisories/new) on GitHub, or
2. Email the maintainer with subject `STIMLI SECURITY` and a clear reproduction.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected endpoint, file, or commit (when you can pinpoint it).
- Your assessment of severity.

You should expect:

- An acknowledgement within **72 hours**.
- An initial triage and severity rating within **7 days**.
- A coordinated disclosure timeline once a fix is in flight.

## In scope

- The Cloudflare Pages Function at `functions/api/[[path]].js` and its helpers
  in `functions/api/_lib/`.
- The React/Vite frontend at `frontend/src/`.
- The Modal inference app at `inference/tribe_modal.py`.
- The deploy + CI workflows in `.github/workflows/`.

## Out of scope

- Findings that require physical access to the user's device.
- Self-XSS that the user must voluntarily execute (e.g., pasting attacker code
  into the browser console).
- Best-practice nits without a clear exploit path (e.g., missing security
  headers on static asset routes when no sensitive data flows through them).
- Vulnerabilities in upstream dependencies that have not been disclosed
  publicly — file those with the upstream project first.

## Hardening notes

For maintainers and contributors:

- Secrets (`POSTGRES_URL`, `CLERK_SECRET_KEY`, `STRIPE_*`, `TRIBE_API_KEY`)
  are managed via `wrangler pages secret put`. They are never committed.
- The Stripe webhook handler verifies signatures via
  `stripe.webhooks.constructEventAsync` and dedupes events through
  `stimli_billing_events` to prevent replay-driven state corruption.
- Workspace isolation is enforced at the API layer: every persistence query
  scopes by `workspace_id`, and `requirePermission(...)` gates writes by
  Clerk-derived role membership.
- CORS is restricted to the configured origins (see `wrangler.toml`
  `CLERK_AUTHORIZED_PARTIES` and the API's `baseHeaders`).
