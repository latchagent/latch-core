# Latch — Investor Memo

**Latch is the control plane and system of record for AI agents.**

---

## The Problem

AI coding agents — Claude Code, Codex, Cursor, OpenClaw — are being adopted across every engineering organization. These are not autocomplete tools. They are autonomous agents that read files, write code, execute shell commands, call APIs, and modify infrastructure. They operate with the developer's full credentials.

69% of organizations suspect employees are already using unsanctioned AI tools. Whether leadership has approved it or not, these agents are inside the building with root access.

The result: no visibility into what they're doing, no control over what they're allowed to do, no audit trail, and no way to prove compliance. Each tool has its own configuration format, its own permission model, and its own extension mechanism. A team using three AI tools has three separate governance systems to maintain. Most teams maintain zero.

---

## What's Already Going Wrong

This is not theoretical risk:

- **Nov 2025**: Anthropic disclosed Chinese state-sponsored actors weaponized Claude Code to automate 80-90% of intrusion operations
- **Dec 2025**: 30+ exploitable vulnerabilities found across Cursor, Copilot, Claude Code, Roo Code, and JetBrains Junie in a single month
- **Sep 2025**: A malicious MCP server package (1,500 weekly downloads) silently BCCed all emails to an attacker's address
- **2026**: 21,000+ exposed OpenClaw instances creating "shadow AI with elevated privileges"
- IBM 2025: AI-associated breaches cost $650K+ each. Shadow AI breaches cost $670K more than average. Source code accounts for 42% of AI-related data policy violations.

---

## The Compliance Forcing Function

SOC 2 does not mention "AI agents" by name. It doesn't need to. Existing Trust Service Criteria — CC6 (access controls), CC7 (monitoring), CC8 (change management), CC9 (vendor risk) — already apply to any actor that touches systems or code. Every AI coding agent is in scope. Companies just have no way to demonstrate compliance.

The regulatory timeline is converging from every direction simultaneously:

- **EU AI Act** high-risk enforcement: August 2, 2026 — six months. Fines up to 35M euros or 7% of global turnover.
- **Microsoft SSPA v10** now requires ISO 42001 for AI vendors — live today.
- **Gartner** named agentic AI oversight the #1 cybersecurity trend for 2026.
- **Forrester** predicts 60% of Fortune 100 will appoint a Head of AI Governance this year.
- **OWASP** published a Top 10 for Agentic Applications (Dec 2025). **NIST** published an AI cybersecurity framework profile (Jan 2026). **ISACA** launched an AI Audit certification. The audit profession is tooling up.
- SOC 2 auditors are already asking: "Can you inventory your AI agents? Show me the audit trail. What's your change management process for AI-generated code?"

The question companies will face is not "should we govern our AI agents?" — it's "can you prove you do?"

---

## Where We Sit in the Landscape

Over $400M in VC went to AI security startups in 2025. That capital is spread across six distinct layers — prompt filtering, code scanning, endpoint monitoring, workspace firewalls, cloud AI posture, and non-human identity. Each layer solves a real problem. None of them solve this one.

Prompt filters (Prompt Security, Lakera) operate on content — they cannot distinguish between tool calls. Code scanners (Snyk, Cycode) secure the output — they don't govern agent behavior. Endpoint monitors (Zenity, $55M raised) observe agents at the OS/process level — they don't integrate at the harness's native authorization boundary. Workspace firewalls (Coder) restrict network domains — they can't tell a benign file write from a dangerous one. Cloud posture tools (Wiz, Microsoft Foundry) govern AI in production infrastructure — coding agents run on developer laptops. Identity platforms (Astrix, Oasis) manage credentials — they know who the agent is, not what it's doing right now. Compliance platforms (Vanta, Drata) are complementary — they help pass audits but provide no runtime enforcement for AI agents.

Latch operates at a layer none of these reach: the harness's native tool-call decision point. Each AI coding tool has a bespoke extension mechanism — Claude Code uses PreToolUse shell hooks with exit code semantics, Codex CLI uses TOML config with Starlark rule files, OpenClaw uses a JavaScript plugin API. Latch integrates with all of them, translates a single policy set into each tool's native format, and makes real-time allow/block decisions on every tool invocation before it executes.

---

## What Latch Is

Latch is a desktop environment where developers run AI coding agents — Claude Code, Codex, OpenClaw — with unified governance built in.

**One policy engine.** Write rules once. Latch translates them into each harness's native enforcement mechanism: Claude Code's PreToolUse shell hooks (exit code semantics), Codex CLI's TOML config + Starlark prefix rules, OpenClaw's JavaScript plugin API. Each harness has a completely different extension mechanism. Getting them all to talk to one policy engine with fail-closed security is the core technical problem.

**Runtime tool-call interception.** A local authorization server intercepts every tool call — file reads, writes, shell commands, API calls — before it executes. Not after. Fail-closed by default: unknown sessions are denied, missing policies are denied, failed auth checks are denied. Every decision is authenticated via shared-secret bearer token.

**Full audit trail.** Every session, every tool call, every authorization decision — logged to a structured, queryable SQLite database with automatic pruning. This is the evidence an auditor needs.

**Anomaly detection.** Z-score statistical analysis flags unusual patterns: volume spikes, new tool access, error rate changes, high-risk action surges. Runs on a 30-second interval and triggers on every 10 events. Configurable sensitivity.

**Zero developer friction.** Agents run in autonomous mode at full speed. Policies enforce silently in the background. No double-prompting. Developers don't feel governed — they feel productive.

---

## What's Built

Latch is not a prototype. The product is implemented and functional:

- **Authorization server** (613 lines) — HTTP server with tool classification, context-aware authorization, glob-based path blocking, interactive approval workflow, 120s timeout with risk-appropriate defaults
- **Policy engine** (876 lines) — Multi-harness policy enforcement with three seeded policies (Default, Strict, Read-Only), per-harness config, Zod schema validation
- **Activity store** (177 lines) — Immutable SQLite audit log, 10K-row cap with auto-pruning, session-scoped queries, indexed timestamps
- **Anomaly radar** (212 lines) — Four anomaly types, z-score normalization, adaptive baselines (6h-72h), configurable sensitivity
- **Workflow orchestration** (145 lines) — Multi-step agent workflows with explicit handoff between harnesses, built-in templates (plan/implement/verify), state machine with artifact tracking
- **Skills bank** (137 lines) — Reusable prompt/capability definitions with two-way sync to harness AGENTS.md files
- **Session management** (128 lines) — SQLite-backed sessions with git worktree integration, Docker container support, policy overrides
- **Terminal management** (101 lines) — node-pty with environment allowlisting, session ID validation, Docker exec support
- **Full React frontend** (3,800+ lines) — Zustand state management, xterm.js terminal emulator, session wizard, policy editor, workflow creator, activity panel, approval UI

Total: ~8,900 lines of TypeScript across main process, preload, and renderer. All features implemented, no stubs.

---

## Defensibility

Latch's defensibility compounds over time across three layers:

**Integration depth.** Each AI harness has a completely different extension mechanism — shell hooks with specific exit code semantics, TOML config with Starlark rule files, JavaScript plugin APIs. These interfaces are poorly documented, change frequently, and have subtle failure modes (a wrong exit code in Claude's hook system silently allows instead of blocking). Maintaining production-grade integrations across a growing set of harnesses is a treadmill. We're already on it.

**Auditor entrenchment.** As companies use Latch to pass SOC 2 audits and EU AI Act assessments, auditors recognize it. They see it at 50 companies, they recommend it at the 51st — the same flywheel that built Vanta and Drata. Once embedded in the audit process, switching means re-explaining your governance story from scratch.

**Data network effects.** Across thousands of teams, Latch sees every tool call every AI agent makes. Aggregated, this becomes threat intelligence (detecting malicious MCP servers and novel attack patterns before anyone else), anomaly baselines that improve with scale, and policy templates built from what SOC 2-compliant companies actually allow their agents to do. No new entrant can replicate this without the install base.

Compliance-driven systems of record compound. Salesforce is the system of record for customers. Workday is the system of record for employees. Latch is the system of record for AI agents.

---

## M&A Validation

Every major security platform is acquiring AI security startups:

| Acquirer | Target | Price | Date |
|----------|--------|-------|------|
| Palo Alto Networks | Protect AI | $500M+ | Jul 2025 |
| Palo Alto Networks | CyberArk | $25B | Feb 2026 |
| Cisco | Robust Intelligence | ~$400M | 2024 |
| Check Point | Lakera | Undisclosed | Q4 2025 |
| F5 Networks | Calypso AI | $180M | Sep 2025 |
| Snyk | Invariant Labs | Undisclosed | Jun 2025 |
| Proofpoint | Acuvity | Undisclosed | Feb 2026 |

Purpose-built startups in this space are either category winners or acquisition targets. Both are good outcomes.

---

## Market

Gartner sizes AI observability and governance at $1.3B in 2026, growing to $4.0B by 2029. No incumbent owns "system of record for AI coding agent activity."

The adjacent market is larger: identity and access management is ~$20B. Non-human identities already outnumber human identities 45:1 in most enterprises — and that was before AI agents.

---

## Path to Scale

**Act 1 — Wedge (now to 18 months):** Governance for AI coding agents. Bottom-up developer adoption. Compliance pull from SOC 2 and EU AI Act deadlines.

**Act 2 — Platform (18 months to 3 years):** Expand beyond coding agents to any AI agent — customer support, data analysis, ops automation. The policy engine and authorization architecture is agent-type-agnostic. Coding agents are the first vertical. Enterprise tier with cloud dashboard, fleet management, compliance reporting.

**Act 3 — Category (3-5 years):** Latch becomes the identity and access management layer for non-human workers. Every enterprise manages human identities (Okta). Every enterprise will need to manage agent identities — credentials, permissions, access scopes, session management, behavioral baselines, audit trails.

The same governance primitives — policy, interception, logging, anomaly detection — apply to any autonomous agent. We start where the pain is sharpest and the compliance deadline is nearest, and expand the surface area as every team in every organization starts deploying agents.

---

## Trusted Execution: The Payment Systems Playbook

The financial industry solved a version of this problem years ago. When payment processors needed to prove that cardholder data was handled correctly — not just that a policy existed, but that it was actually enforced and the data was never exposed — they moved sensitive operations into trusted execution environments. Sensitive data enters encrypted, gets processed inside an AWS Nitro Enclave where even the operator can't see it, and exits encrypted. Cryptographic attestation proves the exact code that ran. No trust required. Proof by architecture.

Latch is applying the same model to AI agent governance.

Today, Latch's authorization server runs on localhost — fast, functional, ships now. The architectural evolution is to move the policy enforcement and audit logging into a TEE. When a tool call hits the authorization boundary, it enters a secure enclave. Inside that enclave:

- **The policy that was configured is the policy that runs.** Attestation proves the enforcement code hasn't been tampered with — not by the developer, not by the agent, not by us.
- **The audit trail is cryptographically sealed.** Even the operator cannot retroactively alter what happened. When an auditor asks "was this policy enforced on Tuesday?", the answer is a cryptographic proof, not a log file.
- **Authorization decisions are verifiable by third parties.** An auditor, a CISO, or a compliance tool can independently verify that Latch's governance layer did what it said it did, without trusting Latch.

This matters because the compliance world is moving from "show me your policy" to "prove you enforced it." A configured policy is a statement of intent. A policy enforced inside a TEE with cryptographic attestation is a statement of fact. That distinction is what separates checkbox compliance from provable compliance — and it's the standard that payment systems, healthcare, and financial services already operate under.

As AI agents start touching production systems, customer data, and regulated workflows, the bar will rise to the same level. The companies that can prove enforcement — not just claim it — will be the ones that pass audits, win enterprise contracts, and avoid liability when something goes wrong.

---

## Go-To-Market

**Bottom-up, then compliance-driven, then enterprise.**

**Phase 1 — Developer adoption.** Latch ships as a free/low-cost desktop app. Individual developers and small teams adopt it because it's the easiest way to run multiple AI agents with guardrails and not slow down. Distribution through developer communities, open-source policy specs, and content around AI agent security. The product sells itself to anyone who's been burned by an agent doing something unexpected.

**Phase 2 — Compliance pull.** The SOC 2 and EU AI Act deadlines create a forcing function. Startups preparing for their first SOC 2 Type II need an answer when the auditor asks about AI agent governance. Latch is that answer — policy enforcement, audit trail, anomaly detection, evidence export. This buyer has urgency (enterprise contracts depend on compliance) and budget (they'll pay to not lose the deal). The sales motion is inbound: their auditor tells them they need this.

**Phase 3 — Enterprise expansion.** Cloud-hosted dashboard for fleet-wide visibility. Org-wide policy management, RBAC, SSO, compliance reporting. Sold to the CISO or Head of AI Governance. Annual contracts, seat-based pricing. The bottom-up adoption from Phase 1 gives us a warm landing — developers are already using Latch, the enterprise deal is "give your team what they're already using, plus admin controls."

**Partnerships that accelerate distribution:**
- **Compliance platforms** (Vanta, Drata) — Latch provides the runtime evidence they need for AI agent controls. Integration makes both products more valuable.
- **Audit firms** — Training programs for mid-market and Big 4 auditors on how to evaluate Latch reports. Once auditors recommend it, the flywheel spins.
- **Harness vendors** — Claude Code, Codex, and OpenClaw all benefit from a governance layer that makes their tools enterprise-adoptable. Co-marketing and integration partnerships.

---

## Team We Need to Build

This is a product that sits at the intersection of developer tooling, security infrastructure, and compliance. The founding team needs to reflect that.

**Security engineers who've built enforcement systems.** Not application security generalists — people who've worked on runtime authorization, policy engines, or access control systems at companies where getting it wrong had consequences. Payment processors, identity providers, cloud infrastructure. The kind of engineer who knows why fail-closed defaults matter and has opinions about exit code semantics.

**Developer tools experience.** Latch lives on the developer's machine. The UX has to be invisible — governance that slows developers down gets uninstalled. Someone who's shipped developer-facing products and understands bottom-up adoption, open-source community dynamics, and the difference between a tool developers tolerate and one they choose.

**Compliance and GRC expertise.** Not a consultant — someone who's been on the other side of a SOC 2 audit and knows what auditors actually look for, what evidence satisfies them, and how to package controls into something they can evaluate. This person shapes the product roadmap around what's auditable, not just what's technically possible. Relationships with audit firms accelerate the Phase 2 flywheel.

**Go-to-market in security/infrastructure SaaS.** Someone who's sold into engineering organizations and understands the bottom-up-to-enterprise motion. Ideally someone with a network in the CISO/security leadership community who can open doors for Phase 3 enterprise deals and knows how to work compliance deadlines as a sales trigger.

The early team is small and technical. Engineering-heavy, with compliance DNA baked in from the start — not bolted on after the product ships.

