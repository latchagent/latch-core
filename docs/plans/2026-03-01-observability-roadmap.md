# Latch Observability & Governance Roadmap

> **Vision:** Latch is Datadog + Sentry for AI coding agents.

**Core thesis:** Nobody has built the nervous system for AI coding agents. The market is splitting into enterprise agent governance (Rubrik, Geordie, Lasso) and developer AI tool governance (Backslash, Snyk, GitHub). Latch is differentiated by operating at the PTY/terminal level across multiple harnesses — a fundamentally stronger control point than IDE plugins or CI/CD hooks.

**Competitive landscape researched:** Rubrik Agent Cloud, Backslash Security, Secure Code Warrior, Snyk/Invariant Labs, Pillar Security, Geordie AI, Lasso Security, Reco AI, Salus, GitHub Agent Control Plane.

---

## Completed

### Observability Phase 1: Cost & Token Dashboard
- Per-session usage tracking (tokens, cost, model breakdown)
- Daily and session-level summaries
- Usage export (JSON/CSV)

### Observability Phase 2: Session Timeline / Replay
- Claude Code JSONL parsing (turn-by-turn)
- Tool call extraction with duration, tokens, cost
- Conversation browser scoped by project

### Observability Phase 3: Stuck/Loop Detection
- Repeated file read detection (3+ in 15-turn window)
- Repeated command failure detection
- Write/edit cycle detection
- Cost velocity spike detection
- Wasted cost quantification per pattern

### Observability Phase 4: Deep Analytics
- Work phase classification (planning/implementation/debugging/coordination/responding)
- Phase cost attribution with visual breakdown
- Context window pressure curves with cache hit ratios
- Rate-limit gap detection
- Per-project health dashboard with weekly spend trends
- Project drill-down → conversation → deep analytics navigation

---

## Roadmap

### Phase 5: Live Session Tailing
**The real-time nervous system. Powers everything that follows.**

- Real-time tool call stream visible from a dashboard (not just terminal)
- Live cost ticker per active session
- File touch map — which files are being read/written right now
- Live loop/anomaly detection with in-progress warnings
- Intervention controls: pause, kill, flag from the dashboard
- Multi-session overview when running parallel agents

**Why first:** Creates the live data pipeline that Phases 6-8 consume. Most visceral feature — watching an agent work in real-time is the "holy shit" moment.

---

### Phase 6: Budgets, SLOs & Leak Detection
**The money and security layer. Quick wins on top of the live stream.**

#### Budgets & SLOs
- Per-session spend limits (hard kill at threshold)
- Per-project daily/weekly budget caps
- SLO definitions ("95th percentile session cost < $8")
- Trend alerts ("you're on pace to exceed weekly budget by Thursday")
- Auto-kill runaway sessions that exceed limits

#### Secrets & Credential Leak Detection
- Real-time scanning of agent output for API keys, tokens, passwords
- Pattern matching (AWS keys, GitHub tokens, generic high-entropy strings)
- Alert before leaked credentials reach a commit
- Leverages existing proxy and activity stream infrastructure
- Near-zero new infrastructure — detection layer on existing data

**Why second:** Budgets are the CFO feature — justifies the tool to anyone paying the bills. Leak detection is a fast win on existing infrastructure.

---

### Phase 7: Issues & Post-Mortems → GitHub / Linear
**When something goes wrong, auto-create a trackable issue where teams already work.**

- Auto-detect "bad sessions" (loops, budget exceeded, policy violations, high waste)
- Generate structured incident with:
  - Full session trace (tool calls, decisions, outcomes)
  - Breadcrumb trail of what led to the failure
  - Blast radius — files touched, commands run
  - Cost impact
  - Loop patterns detected
- Push to GitHub Issues or Linear (user configures integration)
- Tagging and severity classification
- Link back to Latch session for full replay

**Why third:** Requires the detection capabilities from Phases 3-6. Issues that live only in Latch are useless — they need to flow into existing workflows.

---

### Phase 8: Agent Rewind / Rollback
**Git-native undo for agent damage.**

- Auto-checkpoint working tree before agent sessions start
- Periodic checkpoints during long sessions
- Blast radius visualization — "here's everything this agent touched"
- Selective rewind: pick a checkpoint, see the diff, restore
- Per-file revert capability within a checkpoint
- Leverages existing git worktree infrastructure

**Why fourth:** Requires blast radius mapping (which Issues builds) and live session tracking (Phase 5). Git is our snapshot infrastructure — no need to build Rubrik's backup stack.

---

### Phase 9: Session Replay & Agent Benchmarking
**Learn from your AI usage at scale.**

#### Session Replay
- Record full agent sessions as replayable traces
- Share replays with teammates (link or embed)
- Use cases: code review, debugging, onboarding, demos
- "Here's how the agent built this feature, step by step"

#### Agent Benchmarking
- Run the same task across different models/harnesses
- Compare: cost, time, code quality, loop frequency
- Data-driven model selection
- "Sonnet is 3x cheaper than Opus for refactoring with similar quality"
- Historical comparison across your own usage patterns

**Why fifth:** Requires mature data collection from all previous phases. High value but not urgent — nice-to-have that becomes must-have at scale.

---

### Phase 10: Policy-as-Code Marketplace
**Community-shared governance templates.**

- Curated policy templates: SOC2, HIPAA, "strict no-network", "junior dev guardrails"
- One-click install into Latch
- Community contributions with review/rating
- Versioned policies with changelogs
- Like ESLint shared configs but for agent governance

**Why last:** Requires a mature policy system and user base. Network effects need critical mass. Build when there's demand.

---

## Positioning

**Tagline:** "The observability and governance platform for AI coding agents."

**Rubrik comparison:** Rubrik is enterprise infrastructure-level ($50-160K/year, sales-driven). Latch is developer-first, terminal-native, pay-as-you-grow. We eat the market from the bottom — individual developers and small teams first, then grow into enterprise.

**Unique advantages no competitor has:**
1. PTY-level control across 3+ harnesses (not IDE-locked)
2. Per-session sandboxing (Docker, Seatbelt, Bubblewrap)
3. Cryptographic audit trail with Merkle proofs
4. Deep analytics with phase classification and loop detection
5. Git-native rewind (no external snapshot infrastructure)
6. Real-time anomaly detection on tool usage patterns
