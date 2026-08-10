# Eduri

Eduri is a private workspace for one-to-one tutoring. It combines lesson calls,
a collaborative whiteboard and code editor, student records, a reusable material
library, homework, scheduling, and progress tracking in one application.

The interface is in Russian. There is no public registration endpoint:

- the bootstrap administrator creates tutor accounts;
- a tutor creates each student and sends a one-time invitation;
- the student chooses a code phrase and later signs in with name + code phrase;
- duplicate names are supported, while an identical name/code combination is
  rejected because it cannot identify two different accounts.

## Included in the MVP

- role-separated admin, tutor, and student workspaces;
- opaque server-side sessions, CSRF protection, rate limits, hashed credentials,
  hashed one-time invitations, audit events, and tenant ownership checks;
- student history, upcoming lessons, private tutor notes, and material progress;
- note, link, file, and task materials with tags, search, and private downloads;
- homework assignment, draft answers, submission, return, and tutor review;
- persistent lesson rooms with self-hosted LiveKit video/screen sharing, a
  local-first CRDT whiteboard, Monaco, lesson plans, and autosaved board/code
  state;
- Python execution through Pyodide in a dedicated worker with bounded output
  and an explicit run action;
- Docker deployment, nginx/HTTPS configuration, verified daily backups, and
  guarded restore tooling for `eduri.ru`.

## Local development

Requirements: Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The development-only bootstrap credentials are
`admin` / `change-me-admin`. Production refuses to start with the development
lookup key or a short/missing administrator password.

Useful checks:

```bash
npm run typecheck
npm test
npm run build
npm audit
```

Runtime data is written to `./data` and is intentionally ignored by Git. See
`.env.example` for configuration.

## Production

The production layout keeps both application and media services on the Eduri VPS:

```text
Browser -> nginx :443 -> Express/Socket.IO :3020 -> SQLite + private uploads
        -> nginx /livekit -> LiveKit :7880 -> WebRTC/TURN media ports
Express -> private Docker gateway :7880 -> LiveKit management RPC
        -> nginx /vendor -> pinned self-hosted Pyodide and Monaco assets
```

Deployment and recovery procedures are documented in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md). Security boundaries and current MVP
limitations are documented in [`docs/SECURITY.md`](docs/SECURITY.md).
Board architecture and its exhaustive web control reference are documented in
[`docs/BOARD_ARCHITECTURE.md`](docs/BOARD_ARCHITECTURE.md) and
[`docs/BOARD_CONTROLS.md`](docs/BOARD_CONTROLS.md).

LiveKit rooms are limited to the lesson tutor and student. The deployment is
sized for up to three concurrent one-to-one calls without server-side recording
or transcoding. Access tokens are short-lived, room-bound, and issued only after
the application verifies lesson membership.

## Project layout

```text
src/client/   React application and lesson workspace
src/server/   Express API, SQLite migrations, and Socket.IO
src/shared/   shared API-facing types
ops/          nginx, Certbot, deployment, backup, and systemd files
docs/         operations and security runbooks
data/         local persistent state (not committed)
```

This is a personal/private service, not a public SaaS. Before allowing unrelated
tutors to use it, add staff MFA, encrypted off-site backups, a restore drill,
and an independent privacy/security review. Uploaded Code blobs and material
files already pass a fail-closed ClamAV quarantine flow before publication.
