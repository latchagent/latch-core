# Supervisor Agent: Terminal-Driving Policy Enforcement

**Date**: 2026-02-27
**Status**: Design approved, pending implementation plan

---

## Problem

Latch's current policy enforcement relies on hooking into harness tool calls
via HTTP (PreToolUse hooks that curl an authz server). This approach is fragile:

- Hook timeouts kill blocking connections before the user can respond
- `--dangerously-skip-permissions` disables native permission prompts
- Grant timing breaks with parallel tool calls
- Each harness has different hook semantics and edge cases
- The retry flow ("approve in Latch, then tell the LLM to try again") is clunky

**Core insight**: instead of intercepting tool calls from outside the harness,
*drive the harness from above*. The harness runs in its native "ask the user"
mode. A Latch supervisor agent watches and types the answer.

---

## Architecture

### Principle

Latch doesn't fight the harness — it *drives* it. The harness runs in its
natural permission mode. Latch IS the user.

### Components

```
┌─────────────────────────────────────────────────────┐
│                   Latch Main Process                 │
│                                                      │
│  PreToolUse hook ──notify──▶ Supervisor Service      │
│  (exits 0 immediately)      │                        │
│                              ├─ Policy Engine (fast)  │
│                              │   authorizeToolCall()  │
│                              │   → allow/deny/prompt  │
│                              │                        │
│  PTY output stream ────────▶ Prompt Detector (regex)  │
│                              │                        │
│                              ├─ allow → types "y"     │
│                              ├─ deny  → types "n"     │
│                              └─ prompt → Latch UI     │
│                                   ↕                   │
│                              User clicks [Y] / [N]    │
│                              → types into terminal    │
│                                                      │
│  LLM Agent (on-demand) ─────▶ Summarization          │
│                              ├─ User chat             │
│                              └─ Feed messages         │
└─────────────────────────────────────────────────────┘
```

### Two-Tier Decision Engine

**Fast path (no LLM — handles 90%+ of decisions):**
- Hook provides structured data: `{ tool, input, session }`
- `authorizeToolCall()` evaluates against merged policy
- Returns allow/deny/prompt in microseconds
- Prompt detector matches terminal output via regex
- PTY writer types the response

**Smart path (LLM — on-demand only):**
- Summarizes recent activity for the feed
- Answers user questions in the session chat
- Makes nuanced decisions when policy is ambiguous
- Input is structured activity log, not raw terminal output

---

## Supervisor Scope

**One supervisor per session.** Each session has its own supervisor with focused
context for that session's harness, policy, and activity.

Supervisors bubble important events to the global feed:
- Blocked actions always bubble (user needs to know)
- Escalation requests always bubble (user needs to respond)
- Routine auto-approvals do NOT bubble (just noise)
- Session milestones bubble (completion, errors)

Users can respond from either the session pane (full context) or the feed
(quick inline response).

---

## Interaction Model

### Session Pane (deep context)

The supervisor posts status updates and escalation requests within the session:

```
🔵 Supervisor: Claude is researching LLM SEO strategies.
   Auto-approved: WebSearch (3x), WebFetch (5x)
   Blocked: Bash(curl | sh) — pipe-to-shell policy

You: allow bash for this session

🔵 Supervisor: Got it. Bash is now allowed for this session.
   I'll auto-approve shell commands.

🔵 Supervisor: Claude wants to write to ~/.ssh/config.
   This path is in your blocked globs. Allow?  [Y] [N]
```

### Global Feed (inbox)

Aggregated highlights from all session supervisors:

```
[SEO Research] Approved 3 WebSearches automatically        ✓
[Backend]      ⚠ Claude wants to git push --force    [Y] [N]
[Docs]         Session complete. 12 files updated.         ✓
```

### What the user can say in chat

- Policy overrides: "allow network for this session"
- Questions: "what did Claude just do?" / "why was that blocked?"
- Commands: "pause" / "resume" / "cancel"

---

## Hook Configuration

The hook becomes a lightweight notification — no blocking, no HTTP response
codes, no grants:

```bash
#!/bin/bash
# Notify supervisor — non-blocking
curl -sf http://127.0.0.1:PORT/supervise/SESSION_ID \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer SECRET' \
  -d @- 2>/dev/null &
exit 0
```

The hook always exits 0. It never blocks. The harness shows its native
permission prompt. The supervisor types the answer.

### Harness Configuration

- **Claude Code**: No `--dangerously-skip-permissions`. Minimal allow list
  (only harmless tools: Read, Glob, Grep, etc.). Everything else prompts
  natively. Deny list for hard policy denials.
- **Codex**: Native approval mode (`--approval-mode full`). Supervisor drives
  the interactive prompts.
- **OpenClaw**: Native `ask: on` mode. Supervisor handles exec-approval prompts.

---

## Terminal Prompt Detection

Each harness has known prompt patterns. The supervisor watches PTY output
for these patterns after receiving a hook notification.

### Claude Code
```
/Do you want to proceed\?/
/❯\s+\d+\.\s+Yes/
```

### Codex
```
/approve this action/i
/\[y\/n\]/i
```

### Response Typing

**CRITICAL: Always select single-approval only.** Many harnesses offer "Yes,
and don't ask again" (Claude Code option 2). The supervisor must NEVER select
this — it would remove future prompts and the supervisor loses control over
subsequent calls. Always select the single-approval option so every tool call
is individually evaluated.

When a prompt is detected and the supervisor has a queued action:
- **Allow**: select option 1 "Yes" (single approval only)
- **Deny**: select option 3 "No" (or equivalent)
- **Prompt**: do nothing — show inline approval in Latch UI, type after user
  clicks (again, option 1 only when approved)

---

## End-to-End Flows

### Auto-approve (policy allows)

1. Claude decides to call WebSearch
2. PreToolUse hook → notifies supervisor → exits 0
3. `authorizeToolCall()` → allow
4. Queue: pendingAction["WebSearch"] = "approve"
5. Claude shows native prompt
6. PTY watcher detects prompt → types `y\r`
7. WebSearch executes
8. Activity log: auto-approved

**User sees**: nothing. Invisible.

### Auto-deny (policy blocks)

1. Claude decides to call Bash(rm -rf /tmp)
2. PreToolUse hook → notifies supervisor → exits 0
3. `authorizeToolCall()` → deny (command rule)
4. Queue: pendingAction["Bash"] = "deny"
5. Claude shows native prompt
6. PTY watcher detects prompt → types `n\r`
7. Claude adapts
8. Feed: "Blocked: rm -rf /tmp — destructive operation"

**User sees**: feed notification.

### Escalate to user (prompt rule)

1. Claude decides to call WebSearch
2. PreToolUse hook → notifies supervisor → exits 0
3. `authorizeToolCall()` → prompt (explicit tool rule)
4. No action queued
5. Claude shows native prompt
6. PTY watcher detects prompt — no queued action
7. Supervisor posts: "Claude wants to search: '...'. Allow? [Y] [N]"
8. User clicks [Y]
9. Supervisor types `y\r`
10. WebSearch executes

**User sees**: inline approval button. One click.

---

## What Changes

| Component | Current | Supervisor Model |
|-----------|---------|-----------------|
| Hook script | Curls authz server, blocks/allows | Notifies supervisor, exits 0 instantly |
| Claude permissions | Allow-list everything | Minimal allow list, harness prompts naturally |
| Policy enforcement | HTTP response codes (200/403) | Typing into terminal (y/n) |
| Approval UX | ApprovalBar + grant + retry | Supervisor types answer directly |
| User interaction | None | Chat in session pane, feed bubbling |
| Activity tracking | Same | Same, plus LLM summarization |

---

## New Files

| File | Purpose |
|------|---------|
| `src/main/services/supervisor.ts` | Core: policy engine + prompt detector + PTY actor |
| `src/main/services/supervisor-llm.ts` | LLM: summarization, chat, ambiguous decisions |
| `src/renderer/components/SupervisorChat.tsx` | Session pane chat UI |
| `src/renderer/components/FeedView.tsx` | Existing — add inline approval buttons |

## Modified Files

| File | Changes |
|------|---------|
| `src/main/services/policy-enforcer.ts` | Hook becomes notify-only, remove skip-permissions, minimal allow list |
| `src/main/services/authz-server.ts` | Add `/supervise/:sessionId` endpoint (or repurpose existing) |
| `src/main/lib/pty-manager.ts` | Expose PTY output stream for supervisor to watch |
| `src/renderer/store/useAppStore.ts` | Supervisor chat state, inline approval actions |

---

## Known Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| ANSI escape codes in PTY output | Regex won't match prompts | Strip ANSI codes before matching, or read from xterm.js parsed buffer |
| Prompt format changes between harness versions | Supervisor stops detecting prompts | Version-aware patterns, fallback to "pause and ask user" if no match |
| Wrong key input format | Typing garbage into terminal | Test experimentally per harness, document exact key sequences |
| Parallel tool calls (3 WebSearches at once) | Queue/prompt mismatch | Match queued actions to prompts by tool name, not FIFO |
| Supervisor types at wrong time (not a prompt) | Input goes to wrong place | Double-check: recent hook notification AND regex match must both be true |
| "Don't ask again" option selected | Supervisor loses control | NEVER select option 2. Always single-approval (option 1). Hardcoded. |
| Hook fires after prompt appears | Supervisor misses the window | Verify hook → prompt ordering. If reversed, fall back to terminal-only detection |

## Phased Implementation

### Phase 1: Terminal-driving policy enforcement (immediate)
- Supervisor service with policy engine + prompt detector + PTY writer
- Hook becomes notify-only (exit 0 for allows/prompts, exit 2 for hard denies)
- Minimal allow list, harness prompts natively
- Feed posts for blocked/approved actions
- Inline approval buttons for "prompt" rules
- **Verification**: Create policy with WebSearch=prompt, start Claude session,
  verify supervisor auto-approves/denies per policy and posts to feed

### Phase 2: Supervisor chat + LLM summarization
- SupervisorChat component in session pane
- LLM-powered summarization of activity
- User can chat: "what's Claude doing?" / "allow network"
- Policy overrides via natural language

### Phase 3: Notifications + cross-session
- SMS/push notification for escalation requests
- Cross-session awareness in feed
- Global coordination commands

## Future Extensions

- **SMS/push notifications**: Escalation requests can be sent via SMS. User
  texts back "yes" → supervisor types the answer. Manage your AI fleet from
  your phone.
- **Cross-session coordination**: Global supervisor layer that can route
  messages between session supervisors ("when session 1 finishes, start
  session 2").
- **Learning**: Supervisor remembers user's past decisions and adjusts
  suggestions. "You usually allow WebSearch — auto-approving."
- **Audit trail**: Complete log of every decision, who made it (supervisor vs
  user), and why. Compliance-ready.
