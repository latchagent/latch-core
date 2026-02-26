/**
 * @module policy-presets
 * @description Starter policy presets for the Create Policy view.
 * Each preset provides a name, description, and partial PolicyDocument
 * values that pre-fill the policy form.
 */

import type { PolicyPermissions, HarnessesConfig } from '../../types'

export interface PolicyPreset {
  name: string
  description: string
  permissions: PolicyPermissions
  harnesses: HarnessesConfig
}

export const POLICY_PRESETS: PolicyPreset[] = [
  {
    name: 'Protect my secrets',
    description: 'Block access to SSH keys, AWS credentials, .env files, and other sensitive paths. Disable network access.',
    permissions: {
      allowBash: true,
      allowNetwork: false,
      allowFileWrite: true,
      confirmDestructive: true,
      blockedGlobs: ['~/.ssh/**', '~/.aws/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '~/.gnupg/**'],
    },
    harnesses: {},
  },
  {
    name: 'Keep changes in scope',
    description: 'Prevent modifications to system files, lockfiles, and shell configs. Confirm destructive operations.',
    permissions: {
      allowBash: true,
      allowNetwork: true,
      allowFileWrite: true,
      confirmDestructive: true,
      blockedGlobs: ['/etc/**', '/usr/**', '~/.bashrc', '~/.zshrc', '~/.profile', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml'],
    },
    harnesses: {},
  },
  {
    name: 'Read-only exploration',
    description: 'No shell commands, no file writes, no network access. Agent can only read and search the codebase.',
    permissions: {
      allowBash: false,
      allowNetwork: false,
      allowFileWrite: false,
      confirmDestructive: false,
      blockedGlobs: [],
    },
    harnesses: {
      claude: { allowedTools: ['Read', 'Glob', 'Grep', 'Task', 'TodoRead', 'TodoList'] },
    },
  },
  {
    name: 'Strict oversight',
    description: 'Confirm all destructive operations. Block network and sensitive paths. Maximum control over agent behavior.',
    permissions: {
      allowBash: true,
      allowNetwork: false,
      allowFileWrite: true,
      confirmDestructive: true,
      blockedGlobs: ['~/.ssh/**', '~/.aws/**', '**/.env', '**/*.pem', '**/*.key'],
    },
    harnesses: {},
  },
  {
    name: 'Full auto (trust mode)',
    description: 'Everything allowed with no restrictions. Agent has full autonomy. Use only with trusted code and sandboxed environments.',
    permissions: {
      allowBash: true,
      allowNetwork: true,
      allowFileWrite: true,
      confirmDestructive: false,
      blockedGlobs: [],
    },
    harnesses: {},
  },
]
