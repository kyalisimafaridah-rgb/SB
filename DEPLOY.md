# Deploy ScholarBase (Supabase + Render)

## Architecture

| Layer | Host |
|-------|------|
| Postgres + optional Auth later | **Supabase** |
| Node API + React SPA (one service) | **Render** Web Service |
| SMS | Africa's Talking |

The app no longer uses Neon’s serverless HTTP driver. It uses standard `pg` + Drizzle, which matches Supabase connection strings.

---

## 1. Supabase database

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → Database → Connection string → URI**.
3. Copy the URI (replace `[YOUR-PASSWORD]`).
4. In the SQL editor, either:
   - Run migrations from `drizzle/` after `npm run db:generate`, or
   - From your laptop with `DATABASE_URL` set: `npm run db:push` (applies schema).

**Enums & tables** are defined in `drizzle/schema.ts`. Apply them once before first login.

Recommended: enable **connection pooling** and use the **pooler** host on port `6543` (transaction mode) or session mode if you hit prepared-statement issues.

---

## 2. Render web service

### Option A — Blueprint (`render.yaml`)

1. Push this repo to GitHub/GitLab.
2. Render Dashboard → **New → Blueprint** → select the repo.
3. Fill secret env vars (see below).
4. Deploy.

### Option B — Manual

1. **New → Web Service** → connect repo.
2. **Build command:** `npm install && npm run build`  
   (or `pnpm install && pnpm build` if you use pnpm)
3. **Start command:** `npm start`
4. **Health check path:** `/api/health`
5. Instance: starter or higher (cron jobs need a process that stays up).

### Environment variables on Render

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | yes | Supabase URI |
| `JWT_SECRET` | yes | Long random string |
| `FRONTEND_URL` | yes | `https://<your-service>.onrender.com` |
| `OWNER_EMAIL` | yes | Your admin login email(s) |
| `AT_API_KEY` / `AT_USERNAME` | for SMS | |
| `VITE_SUPPORT_PHONE` | recommended | Must be set **at build time** |
| `NODE_ENV` | `production` | |
| `PORT` | auto on Render | Render sets this |

`VITE_*` variables are embedded during `vite build`. Set them in Render **before** the first production build, or trigger a rebuild after changing them.

### CORS

`FRONTEND_URL` must match the browser origin exactly (scheme + host, no trailing slash).

---

## 3. First admin user

1. Register a school with `OWNER_EMAIL` as the account email, **or**
2. Register normally, then set that email in `OWNER_EMAIL` and restart.

---

## 4. Local development

```bash
cp .env.example .env
# paste Supabase DATABASE_URL + JWT_SECRET
npm install
npm run db:push
npm run dev
```

---

## 5. Icons & PWA

Icons live in `client/public/`:

- `favicon-32.png`, `favicon-16.png`
- `apple-touch-icon.png` (180×180)
- `icon-192.png`, `icon-512.png`

Regenerate with: `python3 scripts/generate-icons.py`

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `SSL` / connection refused | Use Supabase pooler URI; ensure password is URL-encoded |
| CORS errors | `FRONTEND_URL` must equal the site URL |
| SMS silent fail | Set `AT_*` and check Render logs |
| Free Render sleep | Cold starts ~30s; upgrade plan for always-on + reliable cron |
| `prepared statement` errors on pooler | Use **session** mode pooler or direct `5432` connection |
