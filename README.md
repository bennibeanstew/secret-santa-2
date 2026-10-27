# Secret Santa

Liquid glass web app. Node + Express backend, vanilla JS frontend, JSON file storage.

## Run

```
cd /Users/benniotting/Documents/secret-santa
npm install
npm start
```

Open http://localhost:3000.

## Email (Google Workspace / Gmail)

Set environment variables before `npm start`. Never paste the password into code or chat.

- `SMTP_USER`: sender address
- `SMTP_APP_PASSWORD`: Google App Password (Account > Security > 2-Step Verification > App passwords)
- `BASE_URL`: public URL used in email links (must be reachable by recipients, e.g. a tunnel or hosted URL)

Without these, emails are not sent. They are written to `data/outbox.json` (dry run).

## Sharing links with other people

`localhost` only works on your own machine. For other people to open the links:

1. `npm start`
2. In a second terminal: `npx cloudflared tunnel --url http://localhost:3000` (prints a public https URL)
3. Restart the server with `BASE_URL=<that url> npm start`

## Flow

- Host creates event and invites emails. Host also takes part.
- Each person opens their personal link, adds items (5 rows, "+ Add item" for more), presses Save and send.
- Host sees progress. "Draw names" unlocks when everyone has sent a list (minimum 3 people).
- Draw is a random derangement (nobody gets themselves). Each person gets an in-app notification (bell) and an email with the giftee's list.

## Notes

- Links are the login. Anyone with a link acts as that person.
- Data lives in `data/db.json`. Single process only.

## Host features

- Remove a person (before the draw), resend an email to one person, remind everyone pending, delete the event.
- The host also receives an email with their own link at creation. Keep it, it is the only way back in.

## Database

Set `DATABASE_URL` to a Postgres connection string (Neon has a free tier) and the app stores everything there. Leave it unset to use `data/db.json` locally.

## Deploy on Vercel

1. Push the repo to GitHub (never commit `.env` or `node_modules`).
2. Vercel: Add New, Project, import the repo. Leave build settings on defaults.
3. Environment variables: `DATABASE_URL` (Postgres, e.g. Neon), `SMTP_USER`, `SMTP_APP_PASSWORD`.
4. Deploy. Invite links use the production address automatically (`BASE_URL` overrides it).
