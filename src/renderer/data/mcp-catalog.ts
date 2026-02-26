/**
 * Built-in catalog of popular pre-configured MCP servers.
 * Users can one-click install these into their Latch MCP store
 * and sync them to any supported harness.
 */

import type { McpTransport } from '../../types'

export interface CatalogMcpServer {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  tags: string[]
  icon: string
  tools?: string[]
  envHints?: Record<string, string>
}

export const MCP_CATALOG: CatalogMcpServer[] = [
  // ── Developer ──────────────────────────────────────────────────────────────
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'Create and manage repos, issues, PRs, and more via the GitHub API',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    tags: ['developer', 'github'],
    icon: 'G',
    tools: [
      'create_or_update_file', 'search_repositories', 'create_issue',
      'create_pull_request', 'get_file_contents', 'push_files',
      'list_issues', 'get_issue', 'update_issue', 'add_issue_comment',
      'search_code', 'search_issues', 'list_commits',
      'create_repository', 'fork_repository', 'create_branch',
    ],
    envHints: { GITHUB_PERSONAL_ACCESS_TOKEN: 'GitHub PAT with repo scope' },
  },
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage local files and directories securely',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    tags: ['developer', 'filesystem'],
    icon: 'F',
    tools: [
      'read_file', 'write_file', 'list_directory', 'create_directory',
      'move_file', 'search_files', 'get_file_info',
      'read_multiple_files', 'list_allowed_directories',
    ],
  },
  {
    id: 'mcp-git',
    name: 'Git',
    description: 'Git operations — status, diff, log, commit, branch management',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    tags: ['developer', 'git'],
    icon: 'G',
  },
  {
    id: 'mcp-playwright',
    name: 'Playwright',
    description: 'Browser automation — navigate, click, fill forms, take screenshots',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    tags: ['developer', 'testing', 'browser'],
    icon: 'P',
    tools: [
      'browser_navigate', 'browser_screenshot', 'browser_click',
      'browser_fill', 'browser_snapshot', 'browser_hover',
      'browser_select_option', 'browser_press_key', 'browser_wait',
      'browser_close', 'browser_resize', 'browser_handle_dialog',
      'browser_tab_list', 'browser_tab_new', 'browser_tab_select',
      'browser_tab_close', 'browser_pdf_save',
      'browser_console_messages', 'browser_network_requests',
    ],
  },
  {
    id: 'mcp-fetch',
    name: 'Fetch',
    description: 'Fetch web content and convert to markdown for easy consumption',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    tags: ['developer', 'web'],
    icon: 'F',
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Dynamic problem-solving through structured thought sequences',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags: ['developer', 'reasoning'],
    icon: 'S',
  },

  // ── Database ───────────────────────────────────────────────────────────────
  {
    id: 'mcp-sqlite',
    name: 'SQLite',
    description: 'Query and analyze local SQLite databases',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '/tmp/test.db'],
    tags: ['database', 'sqlite'],
    icon: 'S',
  },

  // ── Search ─────────────────────────────────────────────────────────────────
  {
    id: 'mcp-brave-search',
    name: 'Brave Search',
    description: 'Web and local search using the Brave Search API',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: '' },
    tags: ['search', 'web'],
    icon: 'B',
    envHints: { BRAVE_API_KEY: 'Brave Search API key from brave.com/search/api' },
  },

  // ── Productivity ───────────────────────────────────────────────────────────
  {
    id: 'mcp-slack',
    name: 'Slack',
    description: 'Read and send Slack messages, manage channels and threads',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    tags: ['productivity', 'slack'],
    icon: 'S',
    envHints: {
      SLACK_BOT_TOKEN: 'Slack Bot User OAuth Token (xoxb-...)',
      SLACK_TEAM_ID: 'Slack workspace team ID',
    },
  },
  {
    id: 'mcp-notion',
    name: 'Notion',
    description: 'Search, read, and update Notion pages and databases',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: '' },
    tags: ['productivity', 'notion'],
    icon: 'N',
    envHints: { NOTION_TOKEN: 'Notion integration token (ntn_...)' },
  },
  {
    id: 'mcp-linear',
    name: 'Linear',
    description: 'Manage Linear issues, projects, and team workflows',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-linear'],
    env: { LINEAR_API_KEY: '' },
    tags: ['productivity', 'linear'],
    icon: 'L',
    envHints: { LINEAR_API_KEY: 'Linear API key from linear.app/settings/api' },
  },
  {
    id: 'mcp-google-drive',
    name: 'Google Drive',
    description: 'Search and read Google Drive files and Google Docs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    tags: ['productivity', 'google'],
    icon: 'D',
    envHints: { GDRIVE_CREDENTIALS_PATH: 'Path to OAuth credentials JSON file' },
  },
  {
    id: 'mcp-google-maps',
    name: 'Google Maps',
    description: 'Geocoding, directions, places, and elevation via Google Maps API',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '' },
    tags: ['productivity', 'maps'],
    icon: 'M',
    envHints: { GOOGLE_MAPS_API_KEY: 'Google Maps Platform API key' },
  },
  {
    id: 'mcp-sentry',
    name: 'Sentry',
    description: 'Retrieve and analyze Sentry issues and error data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@latest'],
    env: { SENTRY_ACCESS_TOKEN: '' },
    tags: ['productivity', 'observability'],
    icon: 'S',
    envHints: { SENTRY_ACCESS_TOKEN: 'Sentry access token with project read scope' },
  },

  // ── Design ─────────────────────────────────────────────────────────────────
  {
    id: 'mcp-figma',
    name: 'Figma',
    description: 'Read Figma designs, components, and styles for design-to-code',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    env: { FIGMA_API_KEY: '' },
    tags: ['design', 'figma'],
    icon: 'F',
    envHints: { FIGMA_API_KEY: 'Figma personal access token from figma.com/developers' },
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  {
    id: 'mcp-memory',
    name: 'Memory',
    description: 'Persistent memory using a knowledge graph for long-term context',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['ai', 'memory'],
    icon: 'M',
  },
]
