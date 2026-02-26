# Latch — Pitch Deck

---

## Slide 1: The Shift

**"Your developers have new coworkers. They have root access."**

- AI coding agents (Claude Code, Codex, Cursor, Copilot, OpenClaw) are being adopted faster than any dev tool in history
- These aren't autocomplete anymore — they're autonomous agents that read files, write code, execute shell commands, call APIs, and modify infrastructure
- They operate with the developer's full credentials
- 69% of organizations already suspect employees are using unsanctioned AI tools
- This is happening whether engineering leadership approves it or not

> **SPEAKER NOTES**
>
> Open casual. "Let me set the context for what we're building and why." Don't oversell the shift — they already know AI is happening. The key thing to land is that these tools aren't chatbots. They execute. They have the developer's credentials. That's the "oh" moment. The 69% shadow AI stat is your hook for the next slide — even if a company hasn't approved these tools, employees are using them anyway.

---

## Slide 2: What Can Go Wrong

**"It already has."**

- **Nov 2025**: Anthropic disclosed that Chinese state-sponsored actors weaponized Claude Code to automate 80-90% of intrusion operations — recon, exploit development, credential harvesting, lateral movement, data exfiltration
- **Dec 2025**: Security researchers found 30+ exploitable vulnerabilities across every major AI coding tool in a single month — Cursor, Copilot, Claude Code, Roo Code, JetBrains Junie. The technique ("IDEsaster") uses prompt injection combined with legitimate IDE features
- **Sep 2025**: A malicious MCP server with 1,500 weekly downloads was silently BCCing every email to an attacker's address. The mcp-remote package (437k+ downloads) enabled remote code execution
- **2025**: An Ethereum core developer's crypto wallet was drained after installing a typosquatted Cursor extension
- **2026**: 21,000+ exposed OpenClaw instances with critical vulnerabilities — "shadow AI with elevated privileges"

And those are just the ones we know about.

- IBM 2025: AI-associated breaches cost **$650K+ each**
- Shadow AI breaches cost **$670K more** than average breaches
- Source code accounts for **42% of AI-related data policy violations**

> **SPEAKER NOTES**
>
> Don't read every bullet — pick 2-3 that land hardest for this audience. The state-sponsored Claude Code story and the malicious MCP server are the strongest because they're specific and visceral. The IBM cost numbers close it out with financial impact. If someone asks "is this really happening?", the answer is "state actors are already using these tools offensively." Let that breathe for a second before moving to compliance. You want them slightly uncomfortable before you give them the regulatory pressure on top.

---

## Slide 3: The Compliance Wall

**"Every company will need to prove they govern their AI agents. Most can't."**

Here's what's converging right now:

**SOC 2 — already applies, nobody's ready**
- SOC 2 doesn't mention "AI agents" by name. It doesn't need to.
- CC6 (access controls), CC7 (monitoring), CC8 (change management), CC9 (vendor risk) — every AI coding agent that touches code or systems is already in scope under these existing criteria
- Auditors are already asking: "Can you inventory your AI agents? Show me the audit trail. What's your change management process for AI-generated code?"
- The SOC 2+ mechanism exists today — organizations can bolt ISO 42001's 38 AI-specific controls onto their SOC 2 examination right now
- The question companies will face isn't "should we govern our AI agents?" — it's "can you prove you do?"

**EU AI Act — hard deadline, real teeth**
- High-risk enforcement: **August 2, 2026** — six months from now
- Requirements: conformity assessments, technical documentation, human oversight, log retention (minimum 6 months)
- Fines: up to **35 million euros or 7% of global turnover**

**Everything else is converging simultaneously**
- Microsoft SSPA v10 requires ISO 42001 for AI vendors — live today
- NIST published an AI cybersecurity framework profile — January 2026
- OWASP published a Top 10 for Agentic Applications — December 2025
- ISACA launched an AI Audit certification — the audit profession is tooling up
- Gartner named agentic AI oversight the **#1 cybersecurity trend for 2026**
- Forrester predicts 60% of Fortune 100 will appoint a Head of AI Governance this year

> **SPEAKER NOTES**
>
> This is the "why now" slide but you're planting it early as context, not as the close. The key insight to deliver conversationally: "SOC 2 doesn't say the words 'AI agent' anywhere. It doesn't need to. CC6, CC7, CC8 already cover access controls, monitoring, and change management for anything that touches systems. Every AI coding agent is already in scope — companies just have no way to demonstrate compliance." That's the aha. The EU AI Act deadline (August 2026, six months) and the Gartner/Forrester stats are your proof that this isn't speculation. If they ask "is this really going to be enforced?", point to Microsoft SSPA v10 — it's live today, requiring ISO 42001 for AI vendors.

---

## Slide 4: The Gap + Landscape

**"The market is crowded at every layer except the one that matters."**

Think about every other actor in your infrastructure:
- **Humans** have IAM — Okta, Active Directory, CyberArk
- **Services** have API gateways — Kong, Apigee, rate limiting, auth
- **Infrastructure changes** have IaC — Terraform, audit logs, plan/apply
- **Code changes** have SCM — Git, PR reviews, branch protection

**AI coding agents have... nothing.**

There's no shortage of AI security companies — over $400M in VC went to AI security startups in 2025. But they all operate at the wrong layer:

| They Do This | Players | What's Missing |
|-------------|---------|---------------|
| Scan the code agents write | Snyk, Cycode | Doesn't govern agent behavior |
| Filter prompts & responses | Prompt Security, Lakera, WitnessAI | Doesn't operate at tool-call level |
| Monitor agents from outside (OS/endpoint) | Zenity ($55M raised) | Can't enforce at the harness's native decision point |
| Firewall the workspace network | Coder ($400M+ val) | Can't distinguish between tool calls; only works in their CDEs |
| Manage agent credentials | Astrix, Oasis, Silverfort | Knows who the agent is, not what it's doing right now |
| Automate compliance checkboxes | Vanta, Drata | No runtime enforcement or evidence collection for AI agents |
| Govern cloud AI workloads | Wiz, Microsoft, Palo Alto, Fiddler | Cloud-first — coding agents run on developer laptops |

Each AI tool also has its own completely different governance mechanism — Claude Code uses shell hooks, Codex uses TOML + Starlark rules, OpenClaw uses JavaScript plugins. There is no standard. A team using three tools has three separate, incompatible systems to maintain. Most teams maintain zero.

**Nobody hooks into the harness's native decision point to make real-time allow/block calls on individual tool invocations. That's the layer compliance requires and security depends on.**

> **SPEAKER NOTES**
>
> This is where you anticipate the "who else is doing this?" question and answer it before they ask. The key points to land:
>
> - **Zenity is the closest comp.** $55M raised, Gartner Cool Vendor. They deploy an endpoint agent that monitors coding assistants at the OS/process level. But they watch from the outside — they don't hook into Claude's PreToolUse hooks, Codex's Starlark rules, or OpenClaw's plugin API. They can't enforce "allow Write on /src, block Write on /etc" because they don't integrate at the harness's native authorization boundary. They're also selling top-down to $100K+ enterprise CISOs. We're going bottom-up to dev teams.
>
> - **Coder has an AI governance add-on.** Agent Boundaries = network-level firewalls (domain allowlists). That's like using a bouncer at the building entrance when you need a lock on every door. It only works inside Coder's own cloud dev environments — can't govern agents on laptops.
>
> - **Snyk acquired Invariant Labs** for MCP-scan and a guardrails proxy. But Snyk secures the code that agents write, not what tools agents use. Invariant Gateway is middleware for custom agent apps, not a control plane for commercial coding tools.
>
> - **The big security vendors (Palo Alto, CrowdStrike, Wiz) are 12-18 months away.** Palo Alto is teasing "Cortex AgentiX" for late 2026. They'll govern AI agents in production cloud workloads. Coding agents run on dev laptops. Different layer. By the time they ship, we're embedded in the audit process.
>
> - **Vanta/Drata are complementary, not competitive.** They help you check SOC 2 boxes. Latch provides the runtime enforcement and evidence they need to check against. This is a partnership opportunity, not a conflict.
>
> - **M&A validates the space.** Palo Alto bought Protect AI for $500M+. Cisco bought Robust Intelligence for ~$400M. Check Point bought Lakera. Snyk bought Invariant Labs. Proofpoint bought Acuvity. F5 bought Calypso AI for $180M. Every large security platform is acquiring in this space. Purpose-built startups here are either category winners or acquisition targets.
>
> If the technical person pushes: "Zenity watches from the outside. We enforce from the inside. That's the difference between an audit log and a firewall."

---

## Slide 5: Latch

**"One control plane for every AI coding agent."**

Latch is a desktop environment where developers run their AI coding agents — Claude Code, Codex, OpenClaw, more coming — with unified governance built in.

**One policy engine.** Write your rules once. Latch translates them into each tool's native enforcement mechanism automatically. You don't need to learn three different config formats.

**Runtime interception.** Every tool call — file reads, writes, shell commands, API calls — goes through Latch's authorization server before it executes. Not after. Before. Fail-closed by default: if the policy check fails for any reason, the action is denied.

**Full activity record.** Every session, every tool call, every decision — logged, structured, and queryable. This is your audit trail. This is what you show the SOC 2 auditor.

**Anomaly radar.** Z-score detection flags unusual patterns automatically — sudden spike in file deletions, unexpected network calls, access to files outside the project scope. You don't have to watch the feed; the system watches for you.

**Zero friction for developers.** Agents run in autonomous mode at full speed. No double-prompting, no "click allow" on every action. The policies enforce silently in the background. Developers don't feel governed — they feel productive.

> **SPEAKER NOTES**
>
> This is the release slide — you've built four slides of tension, now you resolve it. Keep this crisp. Don't demo or go deep on features yet. The line to land: "Latch makes governance invisible to the developer and visible to the auditor." That one sentence is the product positioning. If they want to go deeper, that's what slide 6 is for. The "zero friction" point matters — a governance tool that slows developers down will get uninstalled. Agents run at full speed; policies enforce silently. That's the trick.

---

## Slide 6: How It Actually Works

**"We hook into each tool's native enforcement — that's the hard part."**

_(This slide is a simple architecture diagram. Three harnesses on one side, Latch in the middle, policy engine + activity log + radar on the other.)_

Each AI coding tool has a completely different extension mechanism:

| Tool | How Latch Hooks In |
|------|-------------------|
| **Claude Code** | PreToolUse shell hook in `.claude/settings.json` — exit 0 allows, exit 2 blocks. Latch injects a curl command that calls the local authz server. |
| **Codex CLI** | `.codex/config.toml` for approval policy + sandbox mode, `.codex/rules/` for Starlark prefix rules, notify hook for observation. Latch generates all config files. |
| **OpenClaw** | `before_tool_call` plugin API. Latch generates a JS plugin at `.openclaw/plugins/` that calls the local authz server. |

The authorization server runs on localhost — no data leaves the developer's machine unless the organization opts into cloud aggregation. Every request carries a shared-secret bearer token. Unknown sessions get denied. Missing policies get denied. If curl fails, the action gets denied. Security-first, not bolted on.

> **SPEAKER NOTES**
>
> This slide is for the technical person. Keep it visual — ideally a simple architecture diagram, not a wall of text. The table is your fallback if the slide is text-only. The thing to communicate: "Every AI coding tool has a completely different enforcement mechanism. Getting them all to talk to one policy engine with fail-closed security is the hard engineering problem. That's what we've built." The localhost detail matters for security-conscious listeners — no data leaves the machine. If the technical person asks about failure modes, you have a strong answer: unknown sessions get denied, missing policies get denied, curl failures get denied. Everything fails closed. That's a design choice most tools don't make because it's harder to ship.

---

## Slide 7: Why This Is Defensible

**"The moat deepens with every customer."**

Latch's defensibility isn't one thing — it compounds over time.

**Phase 1 — Now: Integration depth + security architecture**
We're first to build a production-grade translation layer across multiple AI coding harnesses with fail-closed security. This is real engineering — not a wrapper. A funded competitor can replicate individual integrations, but maintaining parity across a growing set of harnesses with constantly changing APIs is a treadmill. We're already on it.

**Phase 2 — 12 months: Auditor recognition**
As companies use Latch to pass SOC 2 audits and EU AI Act assessments, auditors start recognizing it. They see it at 50 companies, they recommend it at the 51st. This is the Vanta/Drata flywheel — more adoption leads to more auditor trust leads to more adoption. Once you're embedded in the audit process, ripping Latch out means re-explaining your entire AI governance story from scratch.

**Phase 3 — 24 months: Data network effects**
This is the real moat. Across thousands of teams, Latch sees every tool call every AI agent makes. Anonymized and aggregated, this becomes:
- **Threat intelligence** — we detect malicious MCP servers, novel prompt injection attacks, and suspicious behavioral patterns before anyone else, because we're the only ones watching at this layer
- **Anomaly baselines** — "this agent behavior is abnormal compared to every developer we've ever seen" is fundamentally more powerful than "this is unusual compared to your last 30 days"
- **Policy templates** — "here's what 500 SOC 2-compliant companies allow their agents to do" gives new customers instant best-practice governance. No competitor can replicate this without the install base.

This is the Datadog playbook. It starts as a monitoring tool. The data makes it irreplaceable.

**Phase 4 — 36 months: Standard**
If Latch's policy format becomes the way teams express AI agent governance — the way Terraform became the way teams express infrastructure — we own the abstraction layer. Open-source the spec, get CI/CD tools to integrate, let other products import/export Latch policies. Now we're not just a product. We're the standard.

> **SPEAKER NOTES**
>
> Be honest here — investors respect it. "Our day-one moat is integration depth and security architecture. That's real but modest — a well-funded competitor could replicate individual integrations. The moat that matters is what happens at 12, 24, 36 months." Walk through the phases conversationally. The auditor flywheel is the easiest to explain — "once auditors see us at 50 companies, they recommend us at the 51st, same thing Vanta did for general SOC 2." The data network effects are the strongest — "we're the only ones watching at the tool-call layer across thousands of teams, so our threat intelligence and anomaly baselines are something no new entrant can replicate without our install base." The Datadog comp resonates: starts as monitoring, the data makes it irreplaceable. If they push on "what if Zenity just adds deeper hooks?" — "they'd have to rebuild their entire architecture from endpoint monitoring to harness-native integration, for each tool independently. That's not a feature add, it's a rewrite."

---

## Slide 8: Who Needs This

**"Three buyer personas, three timelines, one product."**

**Right now — the solo dev / small team**
- Using Claude Code or OpenClaw, moving fast, probably running with full permissions
- Knows they should have guardrails, doesn't want to slow down
- Latch is the easiest way to stay productive AND not accidentally `rm -rf` production
- Bottom-up adoption, individual/small team pricing
- This is our distribution wedge — land here, expand to the org

**6-12 months — the startup preparing for SOC 2**
- Series A/B company, first enterprise contracts requiring SOC 2 Type II
- Auditor asks: "How do you govern your AI coding tools?"
- Today's answer: "We... ask developers to be careful?"
- Latch answer: here's the policy, here's the activity log, here's the anomaly detection, here's the evidence export
- This buyer has urgency and budget. The compliance deadline creates the forcing function.

**12-24 months — the enterprise CISO / Head of AI Governance**
- Forrester says 60% of Fortune 100 will appoint this role in 2026
- Their mandate: get visibility and control over all AI tool usage across engineering
- They need a fleet-wide view — which agents, which tools, what policies, what happened
- Latch cloud dashboard: org-wide policy management, RBAC, SSO, audit exports, compliance reporting
- Enterprise contracts, seat licenses, annual renewals

> **SPEAKER NOTES**
>
> This is your GTM slide disguised as a persona slide. The important thing to communicate: you don't need to build three products. The governance layer is the same — you're just changing packaging, pricing, and distribution channel. The startup SOC 2 buyer is the money slide — they have urgency (first enterprise contract requires compliance) and budget (they'll pay to not lose the deal). The forcing function isn't you convincing them; it's their auditor telling them they need this. That's a beautiful sales motion. The enterprise expansion is aspirational but grounded — Forrester's 60% stat makes it concrete. If they ask about pricing: "bottom-up starts free or cheap for individuals, team tier for the SOC 2 buyer, enterprise tier with SSO/RBAC/dashboards for the CISO."

---

## Slide 9: The Market

**"$1.3 billion today. $4 billion by 2029. No incumbent."**

- Gartner sizes AI observability and governance at **$1.3B in 2026**, growing to **$4.0B by 2029**
- Gartner named agentic AI oversight the **#1 cybersecurity trend for 2026**
- Zenity (Gartner Cool Vendor in Agentic AI TRiSM) is the closest comp, but focused on enterprise low-code/no-code agents — not developer coding tools
- Vanta and Drata own SOC 2 automation for general compliance — neither has AI agent governance
- Nobody owns "system of record for AI coding agent activity"

The adjacent market is even bigger:
- Identity & access management: **~$20B** and growing
- Non-human identities already outnumber human identities **45:1** in most enterprises
- AI agents are creating a new class of non-human actor that existing IAM doesn't cover
- Whoever owns governance for this new actor class is building a generational company

> **SPEAKER NOTES**
>
> Keep this short — don't belabor TAM math. The $1.3B → $4B Gartner number is your anchor. The "no incumbent" point matters more than the number itself. Mention the M&A activity briefly: "Every major security platform — Palo Alto, Cisco, Check Point, Snyk, Proofpoint, F5 — acquired AI security startups in the last 12 months. Over $1.5B in acquisitions. That tells you the strategics see this as critical and are buying their way in. Purpose-built startups in this space are either category winners or acquisition targets. Both are good outcomes." The non-human IAM adjacent market ($20B) is your ceiling expansion — don't dwell on it here, save it for the next slide.

---

## Slide 10: The Path to a Billion-Dollar Company

**"Coding agents are the wedge. Agent identity is the platform."**

**Act 1: Wedge (now → 18 months)**
Governance for AI coding agents. Bottom-up developer adoption. Compliance pull from SOC 2 and EU AI Act deadlines. Land with the desktop product, prove the value.
→ Thousands of teams. $5-10M ARR.

**Act 2: Platform (18 months → 3 years)**
Expand horizontally beyond coding agents to any AI agent — customer support, data analysis, ops automation, internal tools. The policy engine and authz architecture is agent-type-agnostic; coding agents are just the first vertical. Enterprise tier with cloud dashboard, fleet management, compliance reporting.
→ Enterprise contracts. $50-100M ARR. Data network effects compounding.

**Act 3: Category (3-5 years)**
Latch becomes the identity and access management layer for non-human workers. Every enterprise manages human identities (Okta). Every enterprise will need to manage agent identities. Credentials, permissions, access scopes, session management, behavioral baselines, audit trails — for every AI agent in the organization, across every tool, every team, every use case.
→ Category-defining. $300M+ ARR. The "Okta for AI agents."

The expansion logic is simple: the same governance primitives (policy, interception, logging, anomaly detection) apply to any autonomous agent. We start where the pain is sharpest and most urgent — developers running AI coding tools with zero oversight — and expand the surface area as every other team in the organization starts deploying agents too.

> **SPEAKER NOTES**
>
> This is your "how does this become a billion-dollar company" answer. The three acts should feel inevitable, not aspirational. Act 1 is happening now — the product exists, the compliance wave is hitting. Act 2 is a natural horizontal expansion — "the policy engine doesn't know or care that it's governing a coding agent vs. a customer support agent. Same primitives: policy, interception, logging, anomaly detection." Act 3 is the big swing — "Okta for AI agents" is a one-liner that sticks. The supporting logic: non-human identities already outnumber human identities 45:1 in most enterprises, and that was before AI agents. Somebody will own this layer. If they push back on Act 3 being speculative, concede it: "Act 3 is a bet on where the market goes. Acts 1 and 2 build a very strong standalone company regardless. Act 3 is what makes it generational."

---

## Slide 11: Why Now (closing)

**"Six months."**

- EU AI Act high-risk enforcement: **August 2026**
- SOC 2 auditors are asking the questions **today**
- Gartner's #1 cybersecurity trend for 2026: **agentic AI oversight**
- Forrester predicts a publicly disclosed agentic AI breach in **2026**
- 13,000 MCP servers launched in a year, 30+ CVEs in a month, state-sponsored exploitation already documented

The compliance wave is not coming. It's here. The companies that don't have an answer in six months will fail audits, lose contracts, and eat breach costs.

We're building the answer.

> **SPEAKER NOTES**
>
> End clean. Don't rush through this — let the "six months" framing do the work. If the energy is right, close with: "Every company will need a system of record for what their AI agents are doing. Auditors are already asking. Regulators are already moving. We're building the answer, and the window to own this category is right now." Then stop talking and let them ask questions. The strongest close in a casual pitch is confidence + brevity. Don't oversell on the way out.
