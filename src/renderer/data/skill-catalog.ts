/**
 * Curated skill catalog from the OpenAI Agent Skills standard.
 * https://github.com/openai/skills/tree/main/skills/.curated
 *
 * Each skill has a body that gets synced to harness agent files
 * (CLAUDE.md, AGENTS.md, etc.) when installed via the Skills store.
 */

export interface CatalogSkill {
  id: string
  name: string
  description: string
  body: string
  tags: string[]
  icon: string        // single-letter fallback for UI
}

export const SKILL_CATALOG: CatalogSkill[] = [
  // ── GitHub / Git ────────────────────────────────────────────────────────────
  {
    id: 'gh-fix-ci',
    name: 'GitHub Fix CI',
    description: 'Debug failing GitHub Actions CI',
    icon: 'G',
    tags: ['github', 'ci', 'devops'],
    body: `Use when a user asks to debug or fix failing GitHub PR checks that run in GitHub Actions; use \`gh\` to inspect checks and logs, summarize failure context, draft a fix plan, and implement only after explicit approval. Treat external providers (for example Buildkite) as out of scope and report only the details URL.

## Workflow
1. Verify gh authentication (\`gh auth status\`).
2. Resolve the PR (prefer current branch PR via \`gh pr view --json number,url\`).
3. Inspect failing checks (GitHub Actions only) via \`gh pr checks\` and \`gh run view\`.
4. Scope non-GitHub Actions checks — label as external, report URL only.
5. Summarize failures with check name, run URL, and concise log snippet.
6. Create a fix plan and request approval before implementing.
7. After changes, suggest re-running tests and \`gh pr checks\` to confirm.`,
  },
  {
    id: 'gh-address-comments',
    name: 'GitHub Address Comments',
    description: 'Address comments in a GitHub PR review',
    icon: 'G',
    tags: ['github', 'code-review'],
    body: `Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in.

## Workflow
1. Run \`gh auth status\` to verify authentication.
2. Run \`gh pr view --json number,url,reviews,comments\` to get PR context.
3. Fetch review comments and issue comments.
4. For each actionable comment, propose or implement a fix.
5. Summarize all updates made.`,
  },
  {
    id: 'yeet',
    name: 'Yeet',
    description: 'Stage, commit, and open PR',
    icon: 'Y',
    tags: ['git', 'github', 'workflow'],
    body: `Use only when the user explicitly asks to stage, commit, push, and open a GitHub pull request in one flow using the GitHub CLI (\`gh\`).

## Prerequisites
- Require GitHub CLI \`gh\`. Check \`gh --version\`. If missing, ask the user to install.
- Require authenticated \`gh\` session via \`gh auth status\`.

## Naming conventions
- Branch: \`codex/{description}\` when starting from main/master/default.
- Commit: \`{description}\` (terse).
- PR title: \`[codex] {description}\` summarizing the full diff.

## Workflow
- If on main/master/default, create a branch: \`git checkout -b "codex/{description}"\`
- Stage everything: \`git add -A\`
- Commit tersely
- Push with tracking: \`git push -u origin $(git branch --show-current)\`
- Open a PR: \`gh pr create --draft --fill\`
- PR description must be detailed prose covering the issue, cause, fix, and validation.`,
  },

  // ── Deploy ──────────────────────────────────────────────────────────────────
  {
    id: 'vercel-deploy',
    name: 'Vercel Deploy',
    description: 'Deploy apps and agents with zero config on Vercel',
    icon: 'V',
    tags: ['deploy', 'vercel', 'hosting'],
    body: `Deploy applications and websites to Vercel. Always deploy as preview (not production) unless the user explicitly asks for production.

## Prerequisites
- Check whether the Vercel CLI is installed: \`command -v vercel\`

## Quick Start
1. If \`vercel\` is installed: \`vercel deploy [path] -y\` (use 10 minute timeout)
2. If not installed or auth fails, use the fallback deploy script.

## Production Deploys
Only if user explicitly asks: \`vercel deploy [path] --prod -y\`

## Output
Show the user the deployment URL. Do not curl/fetch the deployed URL to verify.`,
  },
  {
    id: 'cloudflare-deploy',
    name: 'Cloudflare Deploy',
    description: 'Deploy Workers, Pages, and platform services on Cloudflare',
    icon: 'C',
    tags: ['deploy', 'cloudflare', 'hosting'],
    body: `Deploy applications and infrastructure to Cloudflare using Workers, Pages, and related platform services. Use when the user asks to deploy, host, publish, or set up a project on Cloudflare.

## Authentication (Required Before Deploy)
Verify auth before deploying: \`npx wrangler whoami\`
Not authenticated? Run \`wrangler login\` (interactive) or set \`CLOUDFLARE_API_TOKEN\` env var.

## Quick Decision
- Serverless functions at the edge -> Workers
- Full-stack web app with Git deploys -> Pages
- Key-value storage -> KV
- Relational SQL -> D1
- Object/file storage (S3-compatible) -> R2
- Run inference (LLMs, embeddings, images) -> Workers AI`,
  },
  {
    id: 'netlify-deploy',
    name: 'Netlify Deploy',
    description: 'Deploy web projects to Netlify with the Netlify CLI',
    icon: 'N',
    tags: ['deploy', 'netlify', 'hosting'],
    body: `Deploy web projects to Netlify using the Netlify CLI (\`npx netlify\`). Use when the user asks to deploy, host, publish, or link a site/repo on Netlify, including preview and production deploys.

## Prerequisites
- Check Netlify CLI: \`npx netlify --version\`
- Authenticate: \`npx netlify login\` or set \`NETLIFY_AUTH_TOKEN\`

## Workflow
1. Link site: \`npx netlify link\` or \`npx netlify init\`
2. Deploy preview: \`npx netlify deploy\`
3. Deploy production: \`npx netlify deploy --prod\`
4. Return the deployment URL to the user.`,
  },
  {
    id: 'render-deploy',
    name: 'Render Deploy',
    description: 'Deploy applications to Render via Blueprints or MCP',
    icon: 'R',
    tags: ['deploy', 'render', 'hosting'],
    body: `Deploy applications to Render by analyzing codebases, generating render.yaml Blueprints, and providing Dashboard deeplinks. Use when the user wants to deploy, host, publish, or set up their application on Render's cloud platform.

## Workflow
1. Analyze the codebase to determine runtime, framework, and build settings.
2. Generate a \`render.yaml\` Blueprint with appropriate service configuration.
3. Provide Dashboard deeplinks for deployment.
4. Report service URL, env vars, and next steps.`,
  },

  // ── Browser / Testing ───────────────────────────────────────────────────────
  {
    id: 'playwright',
    name: 'Playwright CLI',
    description: 'Automate real browsers from the terminal',
    icon: 'P',
    tags: ['testing', 'browser', 'automation'],
    body: `Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via playwright-cli or the bundled wrapper script.

## Core Workflow
1. Open the page: \`playwright-cli open <url>\`
2. Snapshot to get stable element refs: \`playwright-cli snapshot\`
3. Interact using refs from the latest snapshot: \`playwright-cli click e15\`
4. Re-snapshot after navigation or significant DOM changes.
5. Capture artifacts (screenshot, pdf, traces) when useful.

## Guardrails
- Always snapshot before referencing element ids.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over \`eval\` and \`run-code\` unless needed.
- Use \`--headed\` when a visual check will help.`,
  },
  {
    id: 'screenshot',
    name: 'Screenshot Capture',
    description: 'Capture desktop or system screenshots',
    icon: 'S',
    tags: ['testing', 'capture', 'debug'],
    body: `Use when the user explicitly asks for a desktop or system screenshot (full screen, specific app or window, or a pixel region), or when tool-specific capture capabilities are unavailable and an OS-level capture is needed.

## Supported Modes
- Full screen capture
- Specific app or window capture
- Pixel region capture

## Output
Return the screenshot file path and a concise description of what was captured.`,
  },
  {
    id: 'develop-web-game',
    name: 'Develop Web Game',
    description: 'Web game dev + Playwright test loop',
    icon: 'W',
    tags: ['gaming', 'web', 'testing'],
    body: `Use when building or iterating on a web game (HTML/JS) and needs a reliable development + testing loop: implement small changes, run a Playwright-based test script with short input bursts and intentional pauses, inspect screenshots/text, and review console errors.

## Workflow
1. Implement small, focused changes to the game code.
2. Run the Playwright test script to validate changes.
3. Inspect screenshots and text output for correctness.
4. Review console errors and fix issues.
5. Iterate until the game behavior matches expectations.`,
  },

  // ── Design ──────────────────────────────────────────────────────────────────
  {
    id: 'figma',
    name: 'Figma',
    description: 'Use Figma MCP for design-to-code work',
    icon: 'F',
    tags: ['design', 'figma', 'mcp'],
    body: `Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code implementation, or Figma MCP setup and troubleshooting.

## Required Flow
1. Run get_design_context first for the exact node(s).
2. Run get_screenshot for a visual reference.
3. Only after both, download assets and start implementation.
4. Translate output into the project's conventions, styles and framework.
5. Validate against Figma for 1:1 look and behavior.

## Implementation Rules
- Reuse existing components instead of duplicating functionality.
- Use the project's color system, typography scale, and spacing tokens.
- If Figma MCP returns a localhost source for an image/SVG, use it directly.`,
  },
  {
    id: 'figma-implement-design',
    name: 'Figma Implement Design',
    description: 'Turn Figma designs into production-ready code',
    icon: 'F',
    tags: ['design', 'figma', 'frontend'],
    body: `Translate Figma nodes into production-ready code with 1:1 visual fidelity using the Figma MCP workflow (design context, screenshots, assets, and project-convention translation). Trigger when the user provides Figma URLs or node IDs, or asks to implement designs or components that must match Figma specs.

## Flow
1. get_design_context -> get_screenshot -> download assets -> implement.
2. Replace Tailwind utilities with project design-system tokens.
3. Reuse existing components (buttons, inputs, typography, icon wrappers).
4. Strive for 1:1 visual parity. Validate final UI against Figma screenshot.`,
  },

  // ── Documents / Media ───────────────────────────────────────────────────────
  {
    id: 'doc',
    name: 'Word Docs',
    description: 'Edit and review docx files',
    icon: 'D',
    tags: ['documents', 'docx', 'office'],
    body: `Use when the task involves reading, creating, or editing .docx documents, especially when formatting or layout fidelity matters; prefer python-docx plus visual rendering checks.

## Tools
- \`python-docx\` for programmatic document creation/editing.
- Render script for visual verification of layout and formatting.

## Workflow
1. Read existing .docx if provided.
2. Create or edit content with proper formatting.
3. Render and verify visual output.
4. Return the updated file plus a concise change summary.`,
  },
  {
    id: 'pdf',
    name: 'PDF Skill',
    description: 'Create, edit, and review PDFs',
    icon: 'P',
    tags: ['documents', 'pdf'],
    body: `Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter; prefer visual checks by rendering pages (Poppler) and use Python tools such as reportlab, pdfplumber, and pypdf for generation and extraction.

## Tools
- \`reportlab\` for PDF generation.
- \`pdfplumber\` / \`pypdf\` for extraction.
- Poppler for visual rendering checks.`,
  },
  {
    id: 'spreadsheet',
    name: 'Spreadsheet',
    description: 'Create, edit, and analyze spreadsheets',
    icon: 'X',
    tags: ['documents', 'excel', 'csv'],
    body: `Use when tasks involve creating, editing, analyzing, or formatting spreadsheets (.xlsx, .csv, .tsv) using Python (openpyxl, pandas), especially when formulas, references, and formatting need to be preserved and verified.

## Tools
- \`openpyxl\` for .xlsx creation/editing with formulas and formatting.
- \`pandas\` for data analysis and transformation.

## Workflow
1. Read the input file.
2. Apply requested changes (formulas, formatting, data transforms).
3. Verify formulas and references.
4. Return the updated file with a summary.`,
  },
  {
    id: 'jupyter-notebook',
    name: 'Jupyter Notebooks',
    description: 'Create Jupyter notebooks for experiments and tutorials',
    icon: 'J',
    tags: ['documents', 'jupyter', 'python'],
    body: `Use when the user asks to create, scaffold, or edit Jupyter notebooks (.ipynb) for experiments, explorations, or tutorials; prefer the bundled templates and helper scripts.

## Workflow
1. Use templates to scaffold a clean starting notebook.
2. Add sections with clear headers, runnable cells, and concise takeaways.
3. Include imports, setup, experiments, and conclusions.
4. Return the notebook file path.`,
  },

  // ── AI / Media Generation ──────────────────────────────────────────────────
  {
    id: 'imagegen',
    name: 'Image Gen',
    description: 'Generate and edit images using OpenAI',
    icon: 'I',
    tags: ['ai', 'images', 'openai'],
    body: `Use when the user asks to generate or edit images via the OpenAI Image API (generate image, edit/inpaint/mask, background removal or replacement, transparent background, product shots, concept art, covers, or batch variants). Requires OPENAI_API_KEY.

## Capabilities
- Image generation from text prompts
- Image editing / inpainting with masks
- Background removal and replacement
- Batch variant generation`,
  },
  {
    id: 'sora',
    name: 'Sora Video Generation',
    description: 'Generate and manage Sora videos',
    icon: 'S',
    tags: ['ai', 'video', 'openai'],
    body: `Use when the user asks to generate, remix, poll, list, download, or delete Sora videos via OpenAI's video API. Requires OPENAI_API_KEY and Sora API access.

## Capabilities
- Video generation from text prompts
- Video remixing
- Polling generation status
- Downloading videos, thumbnails, and spritesheets
- Batch video generation`,
  },
  {
    id: 'speech',
    name: 'Speech Generation',
    description: 'Generate narrated audio from text',
    icon: 'A',
    tags: ['ai', 'audio', 'openai'],
    body: `Use when the user asks for text-to-speech narration or voiceover, accessibility reads, audio prompts, or batch speech generation via the OpenAI Audio API. Requires OPENAI_API_KEY.

## Capabilities
- Text-to-speech with multiple built-in voices
- Narration, voiceover, accessibility reads
- Batch speech generation
- Custom voice creation is out of scope.`,
  },
  {
    id: 'transcribe',
    name: 'Audio Transcribe',
    description: 'Transcribe audio with optional speaker diarization',
    icon: 'T',
    tags: ['ai', 'audio', 'openai'],
    body: `Transcribe audio files to text with optional diarization and known-speaker hints. Use when a user asks to transcribe speech from audio/video, extract text from recordings, or label speakers in interviews or meetings.

## Capabilities
- Audio/video transcription
- Speaker diarization (labeling)
- Known-speaker hints for better accuracy
- Clean summary output`,
  },

  // ── Notion ──────────────────────────────────────────────────────────────────
  {
    id: 'notion-knowledge-capture',
    name: 'Notion Knowledge Capture',
    description: 'Capture conversations into structured Notion pages',
    icon: 'N',
    tags: ['notion', 'knowledge', 'documentation'],
    body: `Capture conversations and decisions into structured Notion pages; use when turning chats/notes into wiki entries, how-tos, decisions, or FAQs with proper linking.

## Workflow
1. Extract key information from conversations.
2. Structure into Notion pages with decisions, action items, and owners.
3. Link related pages and add proper metadata.
4. Verify page structure and content accuracy.`,
  },
  {
    id: 'notion-meeting-intelligence',
    name: 'Notion Meeting Intelligence',
    description: 'Prep meetings with Notion context and tailored agendas',
    icon: 'N',
    tags: ['notion', 'meetings', 'productivity'],
    body: `Prepare meeting materials with Notion context and research; use when gathering context, drafting agendas/pre-reads, and tailoring materials to attendees.

## Workflow
1. Gather context from relevant Notion pages.
2. Draft agenda with brief, decisions needed, and open questions.
3. Tailor materials to attendees and meeting goals.
4. Create structured Notion page with meeting prep.`,
  },
  {
    id: 'notion-research-documentation',
    name: 'Notion Research & Documentation',
    description: 'Research Notion content and produce briefs/reports',
    icon: 'N',
    tags: ['notion', 'research', 'documentation'],
    body: `Research across Notion and synthesize into structured documentation; use when gathering info from multiple Notion sources to produce briefs, comparisons, or reports with citations.

## Workflow
1. Search and gather information from multiple Notion sources.
2. Synthesize into a structured brief or report.
3. Include citations and source references.
4. Provide clear recommendations.`,
  },
  {
    id: 'notion-spec-to-implementation',
    name: 'Notion Spec to Implementation',
    description: 'Turn Notion specs into implementation plans and tasks',
    icon: 'N',
    tags: ['notion', 'planning', 'project-management'],
    body: `Turn Notion specs into implementation plans, tasks, and progress tracking; use when implementing PRDs/feature specs and creating Notion plans + tasks from them.

## Workflow
1. Read and analyze the Notion spec/PRD.
2. Break down into milestones and tasks with dependencies.
3. Create implementation plan in Notion with tracking.
4. Set up progress tracking and status updates.`,
  },

  // ── Integrations / Observability ────────────────────────────────────────────
  {
    id: 'linear',
    name: 'Linear',
    description: 'Manage Linear issues in Codex',
    icon: 'L',
    tags: ['project-management', 'linear', 'issues'],
    body: `Manage issues, projects & team workflows in Linear. Use when the user wants to read, create or update tickets in Linear.

## Capabilities
- Read and search Linear issues
- Create new issues with proper labels and assignments
- Update issue status, priority, and details
- Triage and organize backlogs`,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Read-only Sentry observability',
    icon: 'S',
    tags: ['observability', 'sentry', 'debugging'],
    body: `Use when the user asks to inspect Sentry issues or events, summarize recent production errors, or pull basic Sentry health data via the Sentry API; perform read-only queries and require SENTRY_AUTH_TOKEN.

## Capabilities
- Inspect Sentry issues and events
- Summarize recent production errors
- Pull basic Sentry health data
- Read-only queries only`,
  },
  {
    id: 'openai-docs',
    name: 'OpenAI Docs',
    description: 'Reference the official OpenAI Developer docs',
    icon: 'O',
    tags: ['documentation', 'openai', 'api'],
    body: `Use when the user asks how to build with OpenAI products or APIs and needs up-to-date official documentation with citations (Codex, Responses API, Chat Completions, Apps SDK, Agents SDK, Realtime, model capabilities or limits); prioritize OpenAI docs MCP tools and restrict any fallback browsing to official OpenAI domains.`,
  },

  // ── Security ────────────────────────────────────────────────────────────────
  {
    id: 'security-best-practices',
    name: 'Security Best Practices',
    description: 'Security reviews and secure-by-default guidance',
    icon: 'S',
    tags: ['security', 'review', 'best-practices'],
    body: `Perform language and framework specific security best-practice reviews and suggest improvements. Trigger only when the user explicitly requests security best practices guidance, a security review/report, or secure-by-default coding help. Supported languages: python, javascript/typescript, go. Do not trigger for general code review, debugging, or non-security tasks.`,
  },
  {
    id: 'security-ownership-map',
    name: 'Security Ownership Map',
    description: 'Map maintainers, bus factor, and sensitive code ownership',
    icon: 'S',
    tags: ['security', 'ownership', 'analysis'],
    body: `Analyze git repositories to build a security ownership topology (people-to-file), compute bus factor and sensitive-code ownership, and export CSV/JSON for graph databases and visualization. Trigger only when the user explicitly wants a security-oriented ownership or bus-factor analysis grounded in git history.`,
  },
  {
    id: 'security-threat-model',
    name: 'Security Threat Model',
    description: 'Repo-grounded threat modeling and abuse-path analysis',
    icon: 'S',
    tags: ['security', 'threat-model', 'appsec'],
    body: `Repository-grounded threat modeling that enumerates trust boundaries, assets, attacker capabilities, abuse paths, and mitigations, and writes a concise Markdown threat model. Trigger only when the user explicitly asks to threat model a codebase or path, enumerate threats/abuse paths, or perform AppSec threat modeling.`,
  },
]
