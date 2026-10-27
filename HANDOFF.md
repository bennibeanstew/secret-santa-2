# Secret Santa: handoff

Paste this file into a new Claude conversation together with the project folder (or the zip) to continue.

## Goal

Web app for Secret Santa with an iOS liquid glass style UI.

- Host creates an event and adds emails.
- Each invitee gets an email with a personal link.
- Each person adds a wishlist: item name + link, 5 rows to start, "+ Add item" for more, "Save and send" button at the bottom.
- Once everyone has sent their list, the host draws names at random.
- Each person gets an in-app notification (bell) and an email with their giftee's list.

## Decisions made

- Local full-stack app (Node + Express, vanilla JS frontend, no build step). Not on Boltable yet.
- Identity: unique link per person (token in URL), no accounts.
- Email: Gmail / Google Workspace via nodemailer, using an App Password.
- Storage: Postgres when `DATABASE_URL` is set (whole state in one JSONB row, in memory with write-through on every change, tested across restarts against Postgres 16); otherwise local JSON file (`data/db.json`). Single process.
- Host takes part in the draw.
- Draw is a random derangement (nobody gets themselves).
- Minimum participants: 2 (test setting). Set `MIN_PARTICIPANTS` to 3 in `server.js` for real use.
- Visual palette: Bolt palette (Neutral, Indigo, Blue, Turquoise, Purple, Sage, Red), light and dark mode.

## Files

- `server.js`: API, storage, email, draw logic, `.env` loader
- `public/index.html`, `public/style.css`, `public/app.js`: UI
- `.env.example`: config template
- `README.md`: run and sharing instructions

## Run

```
cd <project folder>
npm install
npm start
```

Open http://localhost:3000.

## Email setup

1. Create a Google App Password (Google Account > Security > 2-Step Verification > App passwords). Workspace admins can disable these.
2. `cp .env.example .env`, then fill in `SMTP_USER` and `SMTP_APP_PASSWORD`.
3. Restart the server. It prints `Email: sending via <address>` when configured, otherwise `Email: DRY RUN`.
4. In dry run, emails are only written to `data/outbox.json`. The app shows "Email not configured" in that case.

Never paste the App Password into chat or code. `.env` is excluded from the zip.

## Status

- Working (tested end to end with Playwright at phone width, light and dark, no console errors): create event, invite, submit lists, host draw (derangement verified), assignment, notifications, dry-run emails.
- Added in session 2: remove participant (before draw), resend email to one person (invite or, after the draw, their assignment), delete event, host recovery email with their own link, in-memory rate limiting (240 req/min per IP, 15/min on mail endpoints), toast width fix.
- Not yet tested: real Gmail sending (the `.env` file was not created yet).

## Known issues and next steps

- Invite links use `BASE_URL` (default `http://localhost:3000`). Other people cannot open them. Fix: run a tunnel (`npx cloudflared tunnel --url http://localhost:3000`) and start with `BASE_URL=<tunnel url> npm start`, or deploy it.
- Option to move to Boltable: needs a database instead of the JSON file, SSO or link auth, Google Workspace via Workload Identity Federation for email.
- Not built: edit a participant's email or name, per-person copyable links (deliberately skipped: a host holding all tokens could open anyone's assignment), persistent rate limiting.
- Terminal gotcha: the tab running `npm start` cannot run other commands. Open a second tab (Cmd+T).

## Conventions from the user's project (Bolt design system)

- Direct, concise, no fluff. No em-dashes in documents.
- Visuals default to the Bolt color palette.
- Ask clarifying questions before starting work.

## Hosting (decided: GitHub -> Vercel + Neon Postgres; Render was dropped because it asked for a credit card)

- `server.js` exports the Express app (`module.exports = app`); locally `node server.js` still listens. Vercel serves `public/` from its CDN.
- With `DATABASE_URL` (or `POSTGRES_URL`) every API request reads the state row fresh; write requests lock it (`SELECT ... FOR UPDATE`) until they commit, so serverless instances cannot overwrite each other. Tested locally: two separate instances, 21 simultaneous submits all persisted, simultaneous double draw gave one 200 and one 409.
- Env vars on Vercel: `DATABASE_URL`, `SMTP_USER`, `SMTP_APP_PASSWORD`. `BASE_URL` is optional: it falls back to `VERCEL_PROJECT_PRODUCTION_URL`. Set `BASE_URL` once there is a custom domain.
- Not tested on Vercel itself (no access from the build session). If the first deploy misbehaves, check: `/` loads from `public/index.html`, `/api/config` returns JSON, function logs for Postgres connection errors. If Vercel shows a login page to visitors, turn off Deployment Protection for production.
- Rate limiting is per instance (in memory), so it is approximate on Vercel.
