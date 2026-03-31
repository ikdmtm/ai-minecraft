import type Database from 'better-sqlite3';

export interface Skill {
  name: string;
  description: string;
  context: string;
  steps: string[];
  successCount: number;
  failCount: number;
}

interface SkillRow {
  name: string;
  description: string;
  context: string;
  steps_json: string;
  success_count: number;
  fail_count: number;
  updated_at: string;
}

export class SkillLibrary {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name         TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        context      TEXT NOT NULL,
        steps_json   TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  addSkill(skill: Skill): void {
    this.db.prepare(`
      INSERT INTO skills (name, description, context, steps_json, success_count, fail_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        context = excluded.context,
        steps_json = excluded.steps_json,
        success_count = excluded.success_count,
        fail_count = excluded.fail_count,
        updated_at = datetime('now')
    `).run(
      skill.name,
      skill.description,
      skill.context,
      JSON.stringify(skill.steps),
      skill.successCount,
      skill.failCount,
    );
  }

  getAllSkills(): Skill[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY success_count DESC').all() as SkillRow[];
    return rows.map(rowToSkill);
  }

  findByContext(context: string): Skill[] {
    const rows = this.db.prepare(
      'SELECT * FROM skills WHERE context = ? ORDER BY success_count DESC',
    ).all(context) as SkillRow[];
    return rows.map(rowToSkill);
  }

  search(keyword: string): Skill[] {
    const pattern = `%${keyword}%`;
    const rows = this.db.prepare(
      'SELECT * FROM skills WHERE name LIKE ? OR description LIKE ? ORDER BY success_count DESC',
    ).all(pattern, pattern) as SkillRow[];
    return rows.map(rowToSkill);
  }

  getTopSkills(limit: number): Skill[] {
    const rows = this.db.prepare(
      'SELECT * FROM skills ORDER BY success_count DESC, fail_count ASC LIMIT ?',
    ).all(limit) as SkillRow[];
    return rows.map(rowToSkill);
  }

  recordSuccess(name: string): void {
    this.db.prepare(
      'UPDATE skills SET success_count = success_count + 1, updated_at = datetime(\'now\') WHERE name = ?',
    ).run(name);
  }

  recordFailure(name: string): void {
    this.db.prepare(
      'UPDATE skills SET fail_count = fail_count + 1, updated_at = datetime(\'now\') WHERE name = ?',
    ).run(name);
  }

  removeSkill(name: string): void {
    this.db.prepare('DELETE FROM skills WHERE name = ?').run(name);
  }

  getSummaries(): string[] {
    const skills = this.getAllSkills();
    return skills.map(s =>
      `[${s.name}] ${s.description} (成功:${s.successCount} 失敗:${s.failCount})`,
    );
  }
}

function rowToSkill(row: SkillRow): Skill {
  return {
    name: row.name,
    description: row.description,
    context: row.context,
    steps: JSON.parse(row.steps_json),
    successCount: row.success_count,
    failCount: row.fail_count,
  };
}
