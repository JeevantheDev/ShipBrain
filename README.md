# ShipBrain

**An approval-gated AI release pipeline.**

ShipBrain turns engineering tickets into reviewed pull requests, explains failing CI, orchestrates preview and production deployments, manages incidents, and drafts post-mortems — but never acts without a human pressing **Confirm**.

> Built for the Azure AI Foundry Hackathon · June 2026  
> Live demo → [ship-brain.vercel.app](https://ship-brain.vercel.app)

---

## What It Does

| Pillar | What ShipBrain automates | What you still confirm |
|---|---|---|
| **Spec → PR** | Decomposes ticket, generates scaffold, opens Draft PR | Review & merge on GitHub |
| **Release Pipeline** | Preview deploy, release PR, production deploy, rollback | Every deploy gate |
| **Incident Commander** | AI root-cause analysis, hotfix PR, reverse sync, post-mortem | Hotfix approval |
| **CI Monitor** | Syncs GitHub Actions runs, explains failures | Fix & rerun |

Three surfaces — **web dashboard**, **AI chat**, **Telegram bot** — all feeding one pipeline and one audit log.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser / Client                    │
│  Next.js 14 App Router  ·  React 18  ·  TypeScript      │
│                                                         │
│  Release Trace Board  ·  CI Monitor  ·  Incident View   │
│  AI Chat Drawer  ·  Settings  ·  Spec-to-PR             │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE
┌────────────────────────▼────────────────────────────────┐
│                   Next.js API Routes                    │
│                                                         │
│  /api/github/repo-setup   — onboarding                  │
│  /api/chat/stream         — AI chat SSE                 │
│  /api/deployments/*       — preview / production        │
│  /api/traces/*            — release trace CRUD          │
│  /api/incidents/*         — incident management         │
│  /api/webhooks/github     — GitHub event receiver       │
│  /api/webhooks/incidents  — external alert receiver     │
│  /api/telegram/webhook    — Telegram bot receiver       │
└──────┬────────────┬───────────────────┬─────────────────┘
       │            │                   │
┌──────▼──────┐ ┌──▼────────────┐ ┌───▼─────────────────┐
│  Supabase   │ │  Azure AI     │ │  GitHub API          │
│  Postgres   │ │  Foundry      │ │  + Webhooks          │
│             │ │  gpt-4.1-mini │ │                      │
│  38 tables  │ │  + Knowledge  │ │  PRs · Branches      │
│  RLS auth   │ │  Base (RAG)   │ │  Workflows · Secrets │
│  Realtime   │ │  LangChain    │ │  Tags · Webhooks     │
└─────────────┘ └───────────────┘ └──────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────┐
│           External Integrations                         │
│                                                         │
│  Cloudflare Pages  — preview + production hosting       │
│  Telegram Bot      — mobile release operations          │
│  PagerDuty         — incident webhook source            │
└─────────────────────────────────────────────────────────┘
```

### Key directories

```
app/
  (dashboard)/          # All authenticated dashboard pages
  api/                  # API routes (Next.js Route Handlers)
  page.tsx              # Landing page
lib/
  actions/              # Unified write actions (deploy, rollback, hotfix…)
  ai/                   # LLM model, chat, tools, foundry KB, chains
  agent/                # Context builder for AI (live DB snapshot)
  github/               # GitHub API — setup, PRs, workflows, webhooks
  orchestrator/         # Release trace state machine
  telegram/             # Telegram bot commands + NL routing
  cloudflare/           # Cloudflare Pages project management
  shipbrain/            # Semver, API keys, public URL helpers
components/
  app-shell/            # ChatDrawer, sidebar, layout shell
  releases/             # Release Trace Board, RollbackSelector
  landing/              # Landing page sections
supabase/migrations/    # 38 Postgres migrations
scripts/
  reset-sandbox-repo.mjs   # Dev helper: reset sandbox for onboarding test
```

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) · TypeScript |
| Database | Supabase (Postgres + RLS + Realtime) |
| AI | Azure AI Foundry · gpt-4.1-mini · LangChain |
| Knowledge base | Azure AI Foundry RAG (shipbrain-knowledgebase740) |
| Hosting | Cloudflare Pages (preview + production for connected repos) |
| Auth | Supabase Auth (GitHub OAuth) |
| CI/CD integration | GitHub API + GitHub Actions + Webhooks |
| Mobile surface | Telegram Bot API |
| Incident source | PagerDuty webhook / custom webhook |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project
- A GitHub OAuth app (or personal access token)
- An Azure AI Foundry resource with a `gpt-4.1-mini` deployment
- A Cloudflare account with API token (for repo deployments)
- Optional: Telegram bot token, PagerDuty token

### 1. Clone and install

```bash
git clone https://github.com/JeevantheDev/ShipBrain.git
cd ShipBrain
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in `.env.local` — see the [Environment Variables](#environment-variables) section below.

### 3. Run database migrations

```bash
npm run migrate:apply
```

### 4. Start the dev server

```bash
npm run dev        # starts on http://localhost:3003
```

### 5. Expose local server for webhooks (GitHub + Telegram)

GitHub and Telegram webhooks require a public URL. Use [ngrok](https://ngrok.com) or similar:

```bash
ngrok http 3003
```

Set the resulting URL as `SHIPBRAIN_API_URL` and `NEXT_PUBLIC_SHIPBRAIN_API_URL` in `.env.local`, then restart the server.

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values below.

### AI Provider (choose one — Azure AI Foundry recommended)

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | `microsoft_foundry` \| `anthropic` \| `openai` \| `google` |
| `AZURE_AI_FOUNDRY_API_KEY` | Azure AI Foundry resource API key |
| `AZURE_AI_FOUNDRY_ENDPOINT` | e.g. `https://your-resource.services.ai.azure.com` |
| `AZURE_AI_FOUNDRY_DEPLOYMENT_NAME` | Deployment name, e.g. `gpt-4.1-mini` |
| `AZURE_AI_FOUNDRY_PROJECT_ENDPOINT` | Foundry project endpoint for knowledge base RAG |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint (used as search endpoint for RAG) |
| `AZURE_AI_FOUNDRY_KNOWLEDGE_BASE` | Knowledge base name, e.g. `shipbrain-knowledgebase740` |
| `ANTHROPIC_API_KEY` | Anthropic API key (if using Anthropic fallback) |
| `OPENAI_API_KEY` | OpenAI API key (if using OpenAI fallback) |
| `GOOGLE_API_KEY` | Google API key (if using Gemini fallback) |

### Supabase

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `DATABASE_URL` | Postgres connection string (pooled via pgBouncer) |
| `DIRECT_URL` | Postgres direct connection string (for migrations) |

### GitHub

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal access token with repo + workflow + webhook scopes |
| `GITHUB_WEBHOOK_SECRET` | Secret used to verify incoming GitHub webhook payloads |
| `GITHUB_USERNAME` | Your GitHub username |

### Application URLs

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_APP_URL` | Local: `http://localhost:3003` · Production: your Vercel URL |
| `SHIPBRAIN_API_URL` | Public URL ShipBrain uses for internal callbacks (ngrok in dev) |
| `NEXT_PUBLIC_SHIPBRAIN_API_URL` | Same as above, exposed to the browser |

### Cloudflare Pages

| Variable | Description |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages edit permission |
| `CLOUDFLARE_WEBHOOK_SECRET` | Secret for verifying Cloudflare deploy callbacks |

### Telegram (optional)

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret used to verify Telegram webhook payloads |
| `TELEGRAM_FLUSH_SECRET` | Secret for the Telegram message flush endpoint |

### PagerDuty (optional)

| Variable | Description |
|---|---|
| `PAGERDUTY_API_TOKEN` | PagerDuty API token for incident integration |
| `PAGERDUTY_FROM_EMAIL` | Email used in PagerDuty API requests |
| `PAGERDUTY_API_BASE` | e.g. `https://api.eu.pagerduty.com` |

---

## Release Pipeline Flow

```
Ticket
  └─▶ Spec-to-PR (AI decomposes · human confirms)
        └─▶ Draft PR on GitHub
              └─▶ Developer reviews + merges to develop
                    └─▶ Deploy Preview (ShipBrain dispatches · human confirms)
                          └─▶ Cloudflare Pages preview URL
                                └─▶ Create Release PR develop → main (human confirms)
                                      └─▶ Human merges on GitHub
                                            └─▶ Deploy Production (human confirms + tags)
                                                  └─▶ Production live
                                                        └─▶ Rollback available anytime
```

---

## Incident Flow

```
Alert / webhook
  └─▶ Incident opened in ShipBrain
        └─▶ AI analysis (root cause · confidence · fix proposal · rollback steps)
              └─▶ Create Hotfix PR (human confirms)
                    └─▶ Developer pushes fix commits
                          └─▶ Approve Hotfix (human confirms · production deploys)
                                └─▶ Reverse sync PR main → develop (auto-created)
                                      └─▶ Incident resolved
                                            └─▶ Post-mortem generated (7 sections)
```

---

## Useful Scripts

```bash
npm run dev              # Start dev server on :3003
npm run build            # Production build
npm run migrate:apply    # Apply Supabase migrations
npm run migrate:status   # Check migration status

make reset-all           # Reset DB + sandbox repo (for onboarding tests)
make reset-sandbox       # Reset sandbox repo only (branches, tags, workflows)
make reset-db            # Reset app data only (keeps auth users)
```

---

## Team

**Jeevan Jyoti Dash** · **Amit Kumar Rout**

Built on Azure AI Foundry · GPT-4.1-mini · June 2026
