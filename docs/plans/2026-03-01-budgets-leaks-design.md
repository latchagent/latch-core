# Budgets, SLOs & Leak Detection — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Add spend controls (per-session limits, daily project budgets, SLOs) and real-time credential leak detection to Latch Desktop, building on the live event pipeline.

**Architecture:** Two new main-process modules — `budget-enforcer.ts` (subscribes to usage events, enforces limits, pushes alerts) and `leak-scanner.ts` (pure computation, scans strings for credential patterns). Both feed into the existing LiveEvent/Feed/Radar alert channels. Budget config lives in Settings (global defaults) with per-session overrides in the session wizard.

**Tech Stack:** TypeScript, existing usage-event pipeline, settings-store, live-tailer IPC push.

---

## Budget Enforcement

### Configuration

- **Global defaults** in Settings view:
  - `default-session-budget` — max USD per session (e.g., $10). Null = no limit.
  - `daily-project-budget` — max USD per project per day (e.g., $50). Null = no limit.
- **Per-session override** on session record:
  - `budgetUsd` field on SessionRecord. Set in session wizard. Overrides global default.

### Enforcement Flow

1. `budget-enforcer.ts` subscribes to `latch:usage-event` (same events the usage store gets)
2. Maintains running cost per session and per project (daily)
3. At **80%** of limit → push warning to renderer:
   - LiveEvent anomaly: "Session approaching budget limit ($8.00 / $10.00)"
   - Feed item with warning
4. At **100%** of limit → push confirmation request to renderer:
   - Budget alert dialog: "Session X has exceeded its $10 budget. Kill or extend?"
   - **Kill** → SIGTERM to PTY via pty-manager
   - **Extend** → doubles the limit for this session, logs the extension
5. No limit configured → no enforcement

### SLO Tracking

Simple threshold stored in settings:
- `slo-session-cost-p95` — target 95th percentile session cost (e.g., $8)
- Checked against rolling 30-day session cost data from usage store
- When breached → Radar signal at 'medium' level

---

## Leak Detection

### Scanner Module

`leak-scanner.ts` — pure computation module (no I/O), similar to loop-detector.ts.

**Input:** A string to scan (file content, command output, tool call input/output).

**Output:** Array of `LeakMatch` objects with type, matched text (redacted), and location.

### Detection Patterns

| Pattern | Regex/Heuristic |
|---------|-----------------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` |
| AWS Secret Key | 40-char base64 near `aws_secret` |
| GitHub Token | `ghp_`, `gho_`, `ghs_`, `github_pat_` prefixed |
| OpenAI / Anthropic | `sk-[a-zA-Z0-9]{20,}` |
| Stripe | `sk_live_`, `pk_live_`, `rk_live_` prefixed |
| Private Key | `-----BEGIN.*PRIVATE KEY-----` |
| Generic High-Entropy | Shannon entropy > 4.5 on 20+ char alphanumeric strings |
| Env Patterns | `PASSWORD=`, `SECRET=`, `API_KEY=`, `TOKEN=` with value |

### Integration Points

1. **Live tailer** — when extracting tool call content from JSONL, scan Write/Edit inputs
2. **Authz server** — when a Write/Edit tool call comes through, scan the content field
3. Both emit LiveEvent anomalies and Feed items on detection

### Alert Flow

1. Leak detected → `LiveEvent` with `kind: 'anomaly'`, `anomalyKind: 'credential-leak'`
2. Red banner in Live view stream
3. Feed item with file path and pattern type
4. Radar signal at 'high' level
5. **No blocking** — alerts only, user decides action

---

## UI Changes

### Settings View
- New "Budgets" section with fields for:
  - Default session budget (USD)
  - Daily project budget (USD)
  - SLO: 95th percentile session cost target (USD)

### Session Wizard
- Optional "Budget limit" field (USD) — overrides global default

### Live View
- Budget warning/exceeded anomalies appear inline in event stream
- Leak detection anomalies appear as red banners with credential type and file path

### Budget Alert Dialog
- Modal when session hits 100% budget
- Shows: session name, current cost, budget limit
- Actions: Kill Session, Extend Budget (2x)

---

## New Types

```typescript
export interface BudgetAlert {
  id: string
  sessionId: string
  kind: 'warning' | 'exceeded'
  currentCostUsd: number
  limitUsd: number
  timestamp: string
}

export interface LeakMatch {
  kind: string        // 'aws-key', 'github-token', 'private-key', 'high-entropy', etc.
  preview: string     // redacted preview: "AKIA****XXXX"
  filePath?: string   // if found in a Write/Edit target
  line?: number
}
```
