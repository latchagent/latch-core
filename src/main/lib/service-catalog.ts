// src/main/lib/service-catalog.ts
/**
 * @module service-catalog
 * @description Built-in service definitions for common developer tools.
 *
 * Each entry is a ServiceDefinition that can be installed by the user.
 * The catalog is static — user-customized services live in ServiceStore.
 */

import type { ServiceDefinition } from '../../types'

export const SERVICE_CATALOG: ServiceDefinition[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'vcs',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { GH_TOKEN: '${credential.token}', GITHUB_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.github.com', '*.githubusercontent.com', 'github.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['ghp_[a-zA-Z0-9_]{36}', 'ghu_[a-zA-Z0-9_]+', 'ghs_[a-zA-Z0-9_]+'], fields: [] },
    },
    skill: {
      description: 'GitHub access via gh CLI and GitHub API. Auth is automatic.',
      capabilities: ['gh pr create', 'gh issue list', 'gh api', 'git push', 'git pull'],
      constraints: ['Never print or log tokens', 'Use gh CLI when possible', 'Do not modify ~/.config/gh/'],
    },
  },
  {
    id: 'npm',
    name: 'npm',
    category: 'registry',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { NPM_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['registry.npmjs.org', 'www.npmjs.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['npm_[a-zA-Z0-9]{36}'], fields: [] },
    },
    skill: {
      description: 'npm registry access for publishing and installing private packages.',
      capabilities: ['npm publish', 'npm install (private)'],
      constraints: ['Never print tokens', 'Do not modify ~/.npmrc'],
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { OPENAI_API_KEY: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.openai.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['sk-[a-zA-Z0-9]{48}', 'sk-proj-[a-zA-Z0-9_-]+'], fields: [] },
    },
    skill: {
      description: 'OpenAI API access. Auth is automatic.',
      capabilities: ['OpenAI API calls', 'curl to api.openai.com'],
      constraints: ['Never print API keys', 'Use environment variable, not hardcoded keys'],
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { ANTHROPIC_API_KEY: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.anthropic.com'],
        headers: { 'x-api-key': '${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: ['sk-ant-[a-zA-Z0-9_-]+'], fields: [] },
    },
    skill: {
      description: 'Anthropic API access. Auth is automatic.',
      capabilities: ['Anthropic API calls'],
      constraints: ['Never print API keys'],
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'ci',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { VERCEL_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['api.vercel.com', 'vercel.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'internal',
      redaction: { patterns: [], fields: [] },
    },
    skill: {
      description: 'Vercel deployment and project management. Auth is automatic.',
      capabilities: ['vercel deploy', 'vercel env', 'vercel ls'],
      constraints: ['Never print tokens', 'Do not modify ~/.vercel/'],
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'comms',
    protocol: 'http',
    credential: { type: 'token', fields: ['token'] },
    injection: {
      env: { SLACK_TOKEN: '${credential.token}' },
      files: {},
      proxy: {
        domains: ['slack.com', '*.slack.com'],
        headers: { Authorization: 'Bearer ${credential.token}' },
      },
    },
    dataTier: {
      defaultTier: 'confidential',
      redaction: { patterns: ['xoxb-[0-9]+-[a-zA-Z0-9]+', 'xoxp-[0-9]+-[a-zA-Z0-9]+'], fields: [] },
    },
    skill: {
      description: 'Slack API access for messaging and workspace operations.',
      capabilities: ['Slack API calls', 'curl to slack.com'],
      constraints: ['Never print tokens', 'Do not post to channels without explicit instruction'],
    },
  },
  {
    id: 'aws',
    name: 'AWS',
    category: 'cloud',
    protocol: 'http',
    credential: { type: 'env-bundle', fields: ['accessKeyId', 'secretAccessKey'] },
    injection: {
      env: {
        AWS_ACCESS_KEY_ID: '${credential.accessKeyId}',
        AWS_SECRET_ACCESS_KEY: '${credential.secretAccessKey}',
      },
      files: {},
      proxy: {
        domains: ['*.amazonaws.com', '*.aws.amazon.com'],
        headers: {},
      },
    },
    dataTier: {
      defaultTier: 'confidential',
      redaction: {
        patterns: ['AKIA[0-9A-Z]{16}', '[a-zA-Z0-9/+=]{40}'],
        fields: [],
      },
    },
    skill: {
      description: 'AWS access via aws CLI. Auth is automatic via environment variables.',
      capabilities: ['aws s3', 'aws ec2', 'aws lambda', 'aws iam'],
      constraints: ['Never print access keys', 'Do not modify ~/.aws/'],
    },
  },
]

/** Look up a catalog service definition by id. */
export function getCatalogService(id: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG.find(s => s.id === id)
}
