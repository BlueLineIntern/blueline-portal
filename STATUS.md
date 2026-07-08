# BlueLine Advisors Portal — Status

**Live site:** https://blueline-portal.fsabin.workers.dev/
**Admin view:** https://blueline-portal.fsabin.workers.dev/admin (needs the `ADMIN_TOKEN` secret set in Cloudflare)
**Repo:** https://github.com/BlueLineIntern/blueline-portal
**Local path:** `C:\Users\joshu\Documents\blueline-portal`
**Cloudflare account:** fsabin@blueline-advisors.com (Worker + Pages: project name `blueline-portal`)

## Architecture
Single Cloudflare Worker serves both the static frontend (`public/`) and the API
(`worker.js`), same origin — no CORS needed. Data lives in a Cloudflare KV
namespace called `PORTAL_KV`.

- `public/index.html` / `public/assets/style.css` / `public/assets/script.js` — client-facing login, questionnaire, dashboard
- `public/admin.html` — internal staff view of all client submissions, gated by `ADMIN_TOKEN` secret (separate from client logins)
- `worker.js` — register/login/logout, questionnaire save/load, admin listing
- `wrangler.toml` — Worker config incl. KV binding and static assets directory

## Current questionnaire schema (as of commit `e74632d`)
```
{
  budget: { housing, groceries, transportation, investments, debt, discretionary, other },  // monthly $ each
  experienceLevel: "beginner" | "intermediate" | "advanced" | "expert",
  riskAnswers: { 1: 1-5, 2: 1-5, 3: 1-5, 4: 1-5, 5: 1-5 },  // 5 scored questions
  riskScore: 5-25,           // computed server-side, sum of riskAnswers
  riskCategory: string,      // Conservative / Moderately Conservative / Moderate / Moderately Aggressive / Aggressive
  goalShortTerm, goalMediumTerm, goalLongTerm: string,
  updatedAt: ISO timestamp
}
```
Note: any test data saved before this schema (had `budgetRange` + single `riskTolerance` 1-10 slider)
is stale/incompatible. Frontend now tolerates missing fields without crashing, but old
records will show blank budget/risk sections.

## Known gaps / flagged but not addressed
- No rate limiting on login/register.
- No data retention policy or encryption beyond Cloudflare defaults for client PII
  (names, emails, financial goals, risk answers) in KV.
- `ADMIN_TOKEN` grants full read access to all client data, no per-user audit log.
- Only one Cloudflare account/login in use (fsabin@blueline-advisors.com) — no
  documented plan for what happens to account ownership if that changes.
- Site is on the `workers.dev` subdomain, not a custom `blueline-advisors.com` domain.

## To continue in a new chat
Tell Claude: "Continue work on the BlueLine Advisors portal — read STATUS.md and
recent git log in C:\Users\joshu\Documents\blueline-portal for context."
