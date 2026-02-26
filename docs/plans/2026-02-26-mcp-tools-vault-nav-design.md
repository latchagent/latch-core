# MCP Tool Discovery, Policy Integration & Vault Navigation

## Problem

Three gaps prevent Latch from delivering a complete policy-driven MCP experience:

1. **No tool discovery.** MCP servers expose tools at runtime, but Latch never asks. The `tools` field on `McpServerRecord` is either hardcoded from the catalog or manually typed by the user. Servers added outside the catalog start with an empty tool list, making the PolicyEditor's MCP tool picker invisible for them.

2. **Policy editor has blind spots.** The `McpToolPicker` only renders tools that are already in the `tools[]` array. The `McpServerRulesEditor` requires manually typing server names instead of selecting from known servers. Users cannot see tool descriptions when deciding allow/deny/prompt.

3. **Vault is session-scoped.** The secrets vault rail panel only appears when a session is active. Secrets are global resources that should be accessible from top-level navigation.

## Design

### 1. MCP Tool Introspection Service

A new `mcp-introspect.ts` service spawns an MCP server, performs the protocol handshake, calls `tools/list`, and returns the results.

**Stdio transport:**
1. Spawn the server with its configured command, args, and env.
2. Send the MCP `initialize` JSON-RPC request over stdin.
3. Send a `tools/list` request.
4. Parse the response for tool names and descriptions.
5. Kill the process.

**HTTP transport:**
1. POST `tools/list` to the server's URL following the MCP HTTP protocol.
2. Parse tool names and descriptions from the response.

**Secret resolution:** The service resolves `${secret:KEY}` env var references via `SecretStore` before spawning, so servers requiring API keys work during discovery.

**Timeout:** 10 seconds. On timeout, return an error rather than hang.

**Error handling:** Discovery failures show an inline error in the UI. Existing tool data is never overwritten on failure.

**IPC:** `latch:mcp-discover-tools` accepts the server's config (command, args, env, transport, url) and returns `{ ok, tools?: { name, description }[], error? }`.

### 2. Data Model Changes

Add `toolDescriptions` alongside the existing `tools` array:

```typescript
export interface McpServerRecord {
  // ... existing fields ...
  tools: string[]                           // kept for backward compat
  toolDescriptions: Record<string, string>  // NEW: { "create_issue": "Create a new GitHub issue" }
}
```

**SQLite:** Add `tool_descriptions TEXT` column (JSON-encoded) via idempotent `ALTER TABLE ADD COLUMN`.

**Discovery updates both fields together.** Manual edits to the tools text input still work but won't have descriptions.

### 3. McpEditor & McpDetail UI

**McpEditor modal:**
- Add a "Discover Tools" button above the tools text input.
- On click: spinner, call `latch:mcp-discover-tools`, populate tools + descriptions.
- On success: "Found N tools" confirmation. On failure: inline error.
- Button disabled until enough config exists (command for stdio, url for http).

**McpDetail modal:**
- Add a "Tools" section listing each tool with its description.
- "No tools discovered" placeholder when empty, with a "Discover Tools" button.

**McpView cards:**
- Add a tool count badge on each server card (e.g., "12 tools").

### 4. PolicyEditor Improvements

Two targeted improvements (no structural changes):

1. **Tool descriptions as tooltips.** Each tool chip in `McpToolPicker` gets a `title` attribute from `toolDescriptions`. Hovering reveals what the tool does.

2. **McpServerRulesEditor dropdown.** Replace the manual text input for server names with a `<select>` populated from `mcpServers`. Users pick from known servers.

The `toolRules` and `mcpServerRules` data model is unchanged.

### 5. Vault Sidebar View

**New sidebar entry:** "Vault" icon between MCP and Radar. Sets `activeView: 'vault'`.

**New `VaultView` component** (full-page, like McpView):
- Header with "Add Secret" button.
- Info banner explaining `${secret:KEY}` syntax.
- Secret cards: name, key, tags, dates. Edit and Delete buttons.
- Search/filter bar.

**Remove from rail.** The vault tab is removed from the rail to avoid duplication. The rail stays focused on session-scoped panels (Activity, Policy).

**AppView type:** Add `'vault'` to the union.

## Files Summary

**New files:**
- `src/main/services/mcp-introspect.ts` — MCP protocol introspection service

**Modified files:**
- `src/types/index.ts` — `toolDescriptions` on McpServerRecord, `'vault'` on AppView
- `src/main/index.ts` — `latch:mcp-discover-tools` IPC handler
- `src/preload/index.ts` — `discoverMcpTools` method
- `src/main/stores/mcp-store.ts` — `tool_descriptions` column migration + serialization
- `src/renderer/components/modals/McpEditor.tsx` — discover button, descriptions
- `src/renderer/components/modals/McpDetail.tsx` — tools section with descriptions
- `src/renderer/components/McpView.tsx` — tool count badge on cards
- `src/renderer/components/modals/PolicyEditor.tsx` — tool tooltips, server rules dropdown
- `src/renderer/components/Sidebar.tsx` — vault nav entry
- `src/renderer/components/Rail.tsx` — remove vault tab
- `src/renderer/App.tsx` — vault view routing, remove vault from rail
- `src/renderer/store/useAppStore.ts` — discoverMcpTools action, vault view state
- `src/renderer/styles.css` — vault view styles, discover button styles, tool badge
- `src/renderer/components/panels/VaultPanel.tsx` — renamed/refactored to VaultView

## Verification

1. **Discovery round-trip:** Configure a stdio MCP server with valid command. Click "Discover Tools." Verify tools + descriptions populate.
2. **Discovery with secrets:** Configure an MCP server whose env uses `${secret:KEY}`. Verify discovery resolves the secret and spawns successfully.
3. **Discovery failure:** Point at a bad command. Verify inline error, no data loss.
4. **PolicyEditor tool picker:** After discovery, open PolicyEditor. Verify MCP tools appear in the picker with correct descriptions on hover.
5. **Server rules dropdown:** In PolicyEditor, verify the McpServerRulesEditor shows a dropdown of known MCP servers.
6. **Vault sidebar:** Click Vault in sidebar. Verify full secret management view renders without needing a session.
7. **Rail cleanup:** Verify the vault tab no longer appears in the rail.
