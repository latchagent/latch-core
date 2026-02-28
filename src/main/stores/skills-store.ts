import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'

/** Harnesses that use markdown injection into a single agent file */
const HARNESS_AGENT_FILES: Record<string, string> = {
  codex: path.join(os.homedir(), '.codex', 'AGENTS.md'),
}

/** Harnesses that use ~/.X/skills/<skill-id>/SKILL.md (one file per skill) */
const HARNESS_SKILLS_DIRS: Record<string, string> = {
  claude:   path.join(os.homedir(), '.claude',   'skills'),
  openclaw: path.join(os.homedir(), '.openclaw', 'skills'),
  droid:    path.join(os.homedir(), '.factory',  'skills'),
}

const SYNC_MARKER_START = '<!-- latch:skills:start -->'
const SYNC_MARKER_END   = '<!-- latch:skills:end -->'

export class SkillsStore {
  db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(db: Database.Database): SkillsStore {
    const store = new SkillsStore(db)
    store._init()
    return store
  }

  _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        body        TEXT NOT NULL,
        tags        TEXT,
        harnesses   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `)
  }

  listSkills() {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY name ASC').all() as any[]
    return { ok: true, skills: rows.map(this._deserialise) }
  }

  getSkill(id: string) {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as any
    if (!row) return { ok: false, error: `Skill '${id}' not found.` }
    return { ok: true, skill: this._deserialise(row) }
  }

  saveSkill(skill: any) {
    if (!skill?.id)   return { ok: false, error: 'Skill must have an id.' }
    if (!skill?.name) return { ok: false, error: 'Skill must have a name.' }
    if (!skill?.body) return { ok: false, error: 'Skill must have a body.' }

    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO skills (id, name, description, body, tags, harnesses, created_at, updated_at)
      VALUES (@id, @name, @description, @body, @tags, @harnesses, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        name = @name, description = @description, body = @body,
        tags = @tags, harnesses = @harnesses, updated_at = @now
    `).run({
      id: skill.id, name: skill.name, description: skill.description ?? null,
      body: skill.body,
      tags: skill.tags ? skill.tags.join(',') : null,
      harnesses: skill.harnesses ? JSON.stringify(skill.harnesses) : null,
      now
    })

    return { ok: true }
  }

  deleteSkill(id: string) {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    return { ok: true }
  }

  async syncToHarness(harnessId: string) {
    const { skills } = this.listSkills()
    const applicable = skills.filter((s: any) => {
      if (!s.harnesses || s.harnesses.length === 0) return true
      return s.harnesses.includes(harnessId)
    })

    // Harnesses with a skills/ directory (Claude Code, OpenClaw)
    const skillsDir = HARNESS_SKILLS_DIRS[harnessId]
    if (skillsDir) {
      return this._syncToSkillsDir(skillsDir, applicable)
    }

    // Harnesses using markdown injection into a single agent file (Codex)
    const targetPath = HARNESS_AGENT_FILES[harnessId]
    if (!targetPath) return { ok: false, error: `Unknown harness '${harnessId}'.` }

    const skillBlock = this._renderSkillBlock(applicable)

    let existing = ''
    try { existing = await fs.readFile(targetPath, 'utf8') } catch { /* doesn't exist yet */ }

    const updated = this._spliceBlock(existing, skillBlock)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, updated, 'utf8')

    return { ok: true, path: targetPath }
  }

  /** Write each skill as <skillsDir>/<skill-id>/SKILL.md with YAML frontmatter. */
  async _syncToSkillsDir(skillsDir: string, skills: any[]) {
    await fs.mkdir(skillsDir, { recursive: true })

    // List existing dirs so we can remove uninstalled latch-managed ones
    let existingDirs: string[] = []
    try { existingDirs = await fs.readdir(skillsDir) } catch { /* directory doesn't exist yet */ }

    const skillIds = new Set(skills.map((s: any) => s.id))

    for (const skill of skills) {
      const skillDir = path.join(skillsDir, skill.id)
      await fs.mkdir(skillDir, { recursive: true })

      const frontmatter = [
        '---',
        `name: ${skill.name}`,
        skill.description ? `description: ${skill.description}` : null,
        'managed-by: latch',
        '---',
      ].filter(Boolean).join('\n')

      const content = `${frontmatter}\n\n${skill.body}\n`
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8')
    }

    // Clean up dirs for skills that were uninstalled (only latch-managed ones with the marker)
    for (const dir of existingDirs) {
      if (skillIds.has(dir)) continue
      const skillMdPath = path.join(skillsDir, dir, 'SKILL.md')
      try {
        const content = await fs.readFile(skillMdPath, 'utf8')
        if (!content.includes('managed-by: latch')) continue  // Not ours — leave it
        await fs.rm(path.join(skillsDir, dir), { recursive: true })
      } catch {
        // No SKILL.md or can't read — not ours, leave it alone
      }
    }

    return { ok: true, path: skillsDir }
  }

  _deserialise(row: any) {
    let harnesses = null
    if (row.harnesses) {
      try { harnesses = JSON.parse(row.harnesses) } catch { /* fallback to null */ }
    }
    return {
      ...row,
      tags: row.tags ? row.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
      harnesses
    }
  }

  _renderSkillBlock(skills: any[]): string {
    if (!skills.length) return `${SYNC_MARKER_START}\n${SYNC_MARKER_END}`
    const sections = skills.map((s) => {
      const header = `## ${s.name}`
      const desc = s.description ? `\n_${s.description}_\n` : ''
      return `${header}${desc}\n${s.body}`
    })
    return [SYNC_MARKER_START, '', ...sections, '', SYNC_MARKER_END].join('\n')
  }

  _spliceBlock(content: string, block: string): string {
    const startIdx = content.indexOf(SYNC_MARKER_START)
    const endIdx = content.indexOf(SYNC_MARKER_END)
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      return content.slice(0, startIdx) + block + content.slice(endIdx + SYNC_MARKER_END.length)
    }
    const separator = content.length && !content.endsWith('\n\n') ? '\n\n' : ''
    return `${content}${separator}${block}\n`
  }
}

export { HARNESS_AGENT_FILES }
