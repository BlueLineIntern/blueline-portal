# BlueLine Portal — Technical Handoff Documentation

Reverse-engineered documentation for the BlueLine Advisors client portal and advisor CRM.
Written to let an experienced developer understand, run, troubleshoot, modify, and deploy
this system without access to the original developer.

**Documented against commit `68c61e4` (2026-08-20), branch `main`.**
**Live deployment verified at `https://blueline-portal.fsabin.workers.dev` on 2026-08-20.**

---

## Read this first

Two things about this codebase are unusual and will mislead you if you don't know them up front:

1. **There is no build step and no dependencies.** No `package.json`, no `node_modules`, no
   bundler config, no framework. The frontend is hand-written HTML/CSS/vanilla JS served as
   static assets. The backend is a single 8,414-line Cloudflare Worker. What you read is what
   runs. See [03-repository-guide.md](03-repository-guide.md).

2. **`dev-server.ps1` is a 3,265-line hand-written PowerShell re-implementation of the entire
   backend**, used for local development because `wrangler` cannot run on the original
   developer's ARM Windows machine. It is a *parallel implementation*, not a proxy. Every
   backend change needs a matching change there or local testing silently diverges from
   production. See [11-local-development.md](11-local-development.md).

---

## Document index

### For leadership
| Doc | Contents |
|---|---|
| [01-executive-overview.md](01-executive-overview.md) | What this is, who uses it, what the company depends on, vendors, cost, risk summary, investment priorities |
| [20-failure-impact.md](20-failure-impact.md) | What breaks, how badly, when each dependency fails |
| [14-security-review.md](14-security-review.md) | Ranked security findings (leadership should read the Critical/High table) |

### Architecture and orientation
| Doc | Contents |
|---|---|
| [02-architecture.md](02-architecture.md) | Stack, boundaries, request lifecycle, diagrams |
| [03-repository-guide.md](03-repository-guide.md) | Every file, what it does, what to read before changing things |
| [21-new-developer-start-here.md](21-new-developer-start-here.md) | **Start here if you are new.** Ordered learning path |

### Subsystem reference
| Doc | Contents |
|---|---|
| [04-frontend.md](04-frontend.md) | Pages, routing, state, forms, styling, shared modules |
| [05-backend-api.md](05-backend-api.md) | All 87 endpoints, inputs, auth, behaviour, failures |
| [06-auth-and-permissions.md](06-auth-and-permissions.md) | Sessions, MFA, roles, workspace isolation, permissions matrix |
| [07-data-model.md](07-data-model.md) | Complete KV schema, all 29 key namespaces, relationships, encryption |
| [08-workflows.md](08-workflows.md) | End-to-end traces of the major flows |
| [09-integrations.md](09-integrations.md) | Microsoft Graph (SharePoint + Outlook), failure behaviour |
| [13-storage-and-notifications.md](13-storage-and-notifications.md) | File storage, uploads, notifications, email |
| [16-business-rules.md](16-business-rules.md) | Business logic, state machines, calculations, limits |

### Operating it
| Doc | Contents |
|---|---|
| [10-configuration.md](10-configuration.md) | Complete environment variable inventory |
| [11-local-development.md](11-local-development.md) | Setup, running, testing, gotchas |
| [12-deployment.md](12-deployment.md) | CI/CD, hosting, cron, rollback, DNS |
| [15-operations.md](15-operations.md) | Logging, observability, testing strategy, incident response |
| [18-troubleshooting.md](18-troubleshooting.md) | Symptom-to-cause guide |
| [19-common-tasks.md](19-common-tasks.md) | How to make common changes |

### Risk and follow-up
| Doc | Contents |
|---|---|
| [14-security-review.md](14-security-review.md) | Ranked security findings with evidence |
| [17-technical-debt.md](17-technical-debt.md) | Debt, fragility, likely bugs, hard-coded assumptions |
| [22-glossary-and-handoff.md](22-glossary-and-handoff.md) | Glossary, open questions, access checklist |

---

## Evidence and confidence conventions

Throughout these docs:

| Marker | Meaning |
|---|---|
| **CONFIRMED** | Verified by reading the code and/or observing live behaviour. Evidence cited. |
| **INFERRED** | Strong conclusion from code structure, but not directly observed running. |
| **UNKNOWN** | Could not be determined with available access. Explicitly flagged, not guessed. |
| **ASSUMPTION** | A judgement call made to keep moving. Stated so it can be checked. |
| **SUSPECTED BUG** | Looks wrong. Includes reasoning; not confirmed by reproduction unless stated. |

Line references are of the form `worker.js:1234`. **Line numbers are accurate as of commit
`68c61e4`** and will drift. Function and constant names are the durable reference — prefer
searching by name.

## What was verified live

| System | Method | Result |
|---|---|---|
| Live Worker | `curl` against `blueline-portal.fsabin.workers.dev` | Reachable, responding, routes registered |
| GitHub repo | `gh repo view` | **Public repository** (see security review) |
| DNS | `nslookup` | No custom domain; `blueline-advisors.com` is Squarespace, unrelated |
| Security headers | `curl -I` on assets vs 404s | Headers absent on real pages (see security review) |
| Test suite | `node scripts/test-*.js` | 1 of 3 passes; 2 fail on CRLF, not logic |
| Committed secrets | `git grep` + history scan | None found |

**Not verified:** Cloudflare dashboard settings (KV contents, secret presence, Workers Builds
config), SharePoint tenant configuration, Entra app registration permissions. These require
console access and are listed as open questions in
[22-glossary-and-handoff.md](22-glossary-and-handoff.md).
