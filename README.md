# Ontimo 推廣紀錄

A mobile-first tracker for Ontimo's in-person promotion outside Taipei pharmacies. Promoters log each person they talk to (who they were, whether they joined, voucher tier, LINE/IG/App/medication checks, why they refused, what was hard about the app, an optional photo), plus a daily summary, a shared ideas board and a location list. The 數據 tab compares locations, demographics and the NT$50 vs NT$100 voucher tiers.

## Stack

| Part | Cloudflare service | Where |
|---|---|---|
| Page (one HTML file, no build step) | Pages | `public/index.html` |
| API | Pages Functions | `functions/api/[[path]].js` |
| Records | D1 (SQLite) | `migrations/` |
| Photos | R2 | binding `PHOTOS` |

Records are stored as JSON documents in one `docs` table, keyed by collection (`promoters`, `locations`, `contacts`, `sessions`, `inspo`, `stock`, `settings`). Phones poll `/api/sync` every 15 s and on focus, so changes from other promoters show up within seconds. Deletes are kept as tombstones so every phone learns about them.

Access is one shared team passcode. Logging in sets a signed HttpOnly cookie for 180 days. Changing `TEAM_PASSCODE` logs everyone out.

## First deploy

```bash
npm install
npx wrangler login

# 1. Database: copy the printed database_id into wrangler.toml
npx wrangler d1 create ontimo-marketing-record
npm run db:migrate            # creates the table and loads the 104 seed locations

# 2. Photo bucket
npx wrangler r2 bucket create ontimo-marketing-photos

# 3. Deploy (first run creates the Pages project)
npm run deploy

# 4. Secrets (then redeploy once so they take effect)
npx wrangler pages secret put TEAM_PASSCODE
npx wrangler pages secret put SESSION_SECRET   # any long random string, e.g. `openssl rand -hex 32`
npm run deploy
```

If you deploy by connecting the GitHub repo in the Cloudflare dashboard instead, set the build output directory to `public`, leave the build command empty, and add the D1 binding `DB`, the R2 binding `PHOTOS` and the two secrets under the project's settings.

## Local development

```bash
printf 'TEAM_PASSCODE=test-pass\nSESSION_SECRET=dev-secret\n' > .dev.vars
npm run db:migrate:local
npm run dev                    # http://localhost:8788
```

## Editing the seed locations

Edit `scripts/locations.tsv`, then run `npm run seed` to regenerate `migrations/0002_seed.sql`. Seed rows use `INSERT OR IGNORE`, so they never overwrite locations already edited in the app. Locations can also be added, edited and deleted in the app itself.

## Adding a promoter

Give them the URL and the passcode. On first visit they type their name, and their phone remembers it.
