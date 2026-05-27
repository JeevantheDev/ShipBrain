# ShipBrain Telegram Bot Integration Plan

## Overview

Build a conversational Telegram bot that allows users to query and manage ShipBrain resources (PRs, incidents, releases, approvals) via natural language chat. The architecture will be AI-provider agnostic to support easy switching between Gemini, Azure OpenAI (MS Foundry), Anthropic, or any other LLM provider.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────────────────────────────────┐
│                 │     │              ShipBrain (Vercel)             │
│    Telegram     │     │  ┌─────────────────────────────────────┐   │
│      User       │────▶│  │  /api/telegram/webhook              │   │
│                 │     │  │  - Receives messages                 │   │
└─────────────────┘     │  │  - Authenticates user                │   │
                        │  │  - Routes to AI Service              │   │
                        │  └──────────────┬──────────────────────┘   │
                        │                 │                           │
                        │                 ▼                           │
                        │  ┌─────────────────────────────────────┐   │
                        │  │  AI Provider Abstraction Layer      │   │
                        │  │  ┌─────────┬─────────┬───────────┐  │   │
                        │  │  │ Gemini  │ Azure   │ Anthropic │  │   │
                        │  │  │         │ OpenAI  │           │  │   │
                        │  │  └─────────┴─────────┴───────────┘  │   │
                        │  └──────────────┬──────────────────────┘   │
                        │                 │                           │
                        │                 ▼                           │
                        │  ┌─────────────────────────────────────┐   │
                        │  │  Tool/Function Layer                │   │
                        │  │  - getPendingPRs()                  │   │
                        │  │  - getIncidents()                   │   │
                        │  │  - getReleases()                    │   │
                        │  │  - approvePR()                      │   │
                        │  │  - acknowledgeIncident()            │   │
                        │  └──────────────┬──────────────────────┘   │
                        │                 │                           │
                        │                 ▼                           │
                        │  ┌─────────────────────────────────────┐   │
                        │  │  Supabase Database                  │   │
                        │  └─────────────────────────────────────┘   │
                        └─────────────────────────────────────────────┘
```

---

## Required Setup

### 1. Telegram Bot Setup

| Item | Description |
|------|-------------|
| **Bot Token** | Create bot via [@BotFather](https://t.me/BotFather) on Telegram |
| **Webhook URL** | `https://your-app.vercel.app/api/telegram/webhook` |
| **Bot Commands** | Register commands like `/prs`, `/incidents`, `/releases`, `/help` |

**BotFather Commands to Set:**
```
prs - List pending PRs
incidents - Show open incidents
releases - Recent releases
approve - Approve a PR or release
help - Show available commands
```

### 2. Environment Variables

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_WEBHOOK_SECRET=random_secret_for_verification

# AI Provider (switch by changing ACTIVE_AI_PROVIDER)
ACTIVE_AI_PROVIDER=gemini  # Options: gemini | azure | anthropic | openai

# Gemini (current)
GEMINI_API_KEY=your_gemini_key

# Azure OpenAI / MS Foundry (future)
AZURE_OPENAI_API_KEY=your_azure_key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Anthropic (optional)
ANTHROPIC_API_KEY=your_anthropic_key

# OpenAI (optional)
OPENAI_API_KEY=your_openai_key
```

### 3. Database Changes

Add table to link Telegram users to ShipBrain accounts:

```sql
-- Migration: Add telegram_users table
CREATE TABLE public.telegram_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  telegram_chat_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verification_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_telegram_chat_id ON telegram_users(telegram_chat_id);
CREATE INDEX idx_telegram_user_id ON telegram_users(user_id);

-- RLS Policy
ALTER TABLE telegram_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own telegram link" ON telegram_users
  FOR ALL USING (auth.uid() = user_id);
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Day 1-2)

#### 1.1 AI Provider Abstraction Layer

```
lib/
  ai/
    providers/
      index.ts          # Provider factory
      types.ts          # Shared types/interfaces
      gemini.ts         # Gemini implementation
      azure-openai.ts   # Azure OpenAI implementation
      anthropic.ts      # Anthropic implementation
```

**Key Interface:**
```typescript
// lib/ai/providers/types.ts
export interface AIProvider {
  chat(messages: ChatMessage[], tools?: Tool[]): Promise<AIResponse>;
  parseToolCalls(response: AIResponse): ToolCall[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

**Provider Factory:**
```typescript
// lib/ai/providers/index.ts
export function getAIProvider(): AIProvider {
  const provider = process.env.ACTIVE_AI_PROVIDER || 'gemini';

  switch (provider) {
    case 'gemini':
      return new GeminiProvider();
    case 'azure':
      return new AzureOpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}
```

#### 1.2 Telegram Webhook Endpoint

```
app/
  api/
    telegram/
      webhook/
        route.ts        # Main webhook handler
      setup/
        route.ts        # Set webhook URL
```

### Phase 2: Bot Tools/Functions (Day 2-3)

#### 2.1 Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_pending_prs` | List PRs awaiting review/approval | `status?: string` |
| `get_incidents` | List incidents by status | `status?: 'open' \| 'investigating' \| 'resolved'` |
| `get_releases` | Recent releases and their status | `limit?: number` |
| `get_environments` | Preview/production environment status | none |
| `approve_pr` | Approve a specific PR | `prNumber: number, note?: string` |
| `acknowledge_incident` | Acknowledge an incident | `incidentId: string` |
| `reject_incident` | Reject an incident | `incidentId: string, reason: string` |
| `get_ci_status` | Current CI/CD pipeline status | `branch?: string` |

#### 2.2 Tool Implementation

```
lib/
  telegram/
    tools/
      index.ts          # Tool registry
      prs.ts            # PR-related tools
      incidents.ts      # Incident tools
      releases.ts       # Release tools
      environments.ts   # Environment tools
```

### Phase 3: User Authentication (Day 3-4)

#### 3.1 Linking Flow

```
User starts bot → Bot sends verification code
                           ↓
User enters code in ShipBrain Settings page
                           ↓
Account linked → Bot can now access user's data
```

#### 3.2 Settings Page Addition

Add Telegram section to `/settings/secrets`:
- Show verification code
- Link/unlink Telegram account
- Test notification button

### Phase 4: Conversation Flow (Day 4-5)

#### 4.1 System Prompt

```typescript
const SYSTEM_PROMPT = `You are ShipBrain Assistant, a helpful bot for managing CI/CD, PRs, incidents, and releases.

You have access to the following tools:
- get_pending_prs: List pull requests pending review or approval
- get_incidents: List incidents (open, investigating, or resolved)
- get_releases: Show recent releases and their deployment status
- get_environments: Check preview and production environment status
- approve_pr: Approve a pull request (requires PR number)
- acknowledge_incident: Start investigating an incident
- reject_incident: Reject an incident as not actionable

Guidelines:
1. Be concise - Telegram messages should be brief
2. Use formatting: *bold*, _italic_, \`code\`
3. For lists, use bullet points or numbered lists
4. Always confirm before taking actions (approve, reject)
5. If user is not verified, guide them to link their account

Current user: {{username}}
Verified: {{verified}}
`;
```

#### 4.2 Example Conversations

```
User: What PRs need my attention?
Bot: 📋 *Pending PRs:*

     1. #42 - Add user authentication
        Branch: `feature/auth`
        Status: Awaiting approval

     2. #38 - Fix checkout bug
        Branch: `hotfix/checkout`
        Status: CI passing, ready to merge

     Reply with "approve 42" to approve a PR.
```

```
User: Any incidents?
Bot: 🚨 *Open Incidents:*

     1. `INC-a3f8` - High
        Checkout latency spike
        Status: Open (2h ago)

     No investigating incidents.

     Reply "ack a3f8" to acknowledge.
```

---

## File Structure

```
lib/
  ai/
    providers/
      index.ts
      types.ts
      gemini.ts
      azure-openai.ts
      anthropic.ts
  telegram/
    client.ts           # Telegram API client
    tools/
      index.ts
      prs.ts
      incidents.ts
      releases.ts
      environments.ts
    formatter.ts        # Format responses for Telegram
    auth.ts             # User verification logic

app/
  api/
    telegram/
      webhook/
        route.ts
      setup/
        route.ts
      verify/
        route.ts
  (dashboard)/
    settings/
      telegram/
        page.tsx        # Telegram linking UI

supabase/
  migrations/
    XXX_telegram_users.sql
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/telegram/webhook` | POST | Receive Telegram updates |
| `/api/telegram/setup` | POST | Set webhook URL with Telegram |
| `/api/telegram/verify` | POST | Verify user linking code |

---

## Switching AI Providers

To switch from Gemini to Azure OpenAI (MS Foundry):

1. **Add Azure credentials to `.env`:**
   ```env
   AZURE_OPENAI_API_KEY=your_key
   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   AZURE_OPENAI_DEPLOYMENT=gpt-4o
   ```

2. **Change active provider:**
   ```env
   ACTIVE_AI_PROVIDER=azure
   ```

3. **Deploy** - No code changes required.

The abstraction layer handles:
- Different API formats
- Tool/function calling syntax differences
- Response parsing
- Error handling

---

## Security Considerations

1. **Webhook Verification**: Validate Telegram webhook requests using secret token
2. **User Authentication**: Require account linking before accessing data
3. **Action Confirmation**: Double-confirm destructive actions (approve, reject)
4. **Rate Limiting**: Implement rate limits to prevent abuse
5. **Audit Logging**: Log all actions taken via Telegram

---

## Deployment Checklist

- [ ] Create Telegram bot via BotFather
- [ ] Add environment variables to Vercel
- [ ] Run database migration for `telegram_users` table
- [ ] Deploy application
- [ ] Set webhook URL: `POST /api/telegram/setup`
- [ ] Test bot commands
- [ ] Add Telegram section to settings page

---

## Future Enhancements

1. **Inline Keyboards**: Quick action buttons in messages
2. **Notifications**: Push alerts for new incidents, PR approvals needed
3. **Group Support**: Add bot to team groups for shared visibility
4. **Voice Messages**: Transcribe and process voice queries
5. **WhatsApp Support**: Extend same architecture to WhatsApp Business API

---

## Estimated Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1 | 2 days | AI abstraction + webhook endpoint |
| Phase 2 | 2 days | All bot tools implemented |
| Phase 3 | 1 day | User authentication flow |
| Phase 4 | 2 days | Conversation handling + testing |
| **Total** | **7 days** | Production-ready Telegram bot |

---

## Dependencies

```json
{
  "dependencies": {
    "telegraf": "^4.16.0",        // Optional: Telegram bot framework
    "@google/generative-ai": "^x.x.x",  // Current
    "@azure/openai": "^1.0.0",    // For Azure OpenAI
    "@anthropic-ai/sdk": "^x.x.x" // For Anthropic
  }
}
```

> **Note**: You can use raw `fetch` calls instead of SDKs to keep dependencies minimal. All providers support REST APIs.
