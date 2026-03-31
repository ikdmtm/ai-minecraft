import type Database from 'better-sqlite3';

export interface EpisodeSummary {
  generation: number;
  survivalMinutes: number;
  deathCause: string;
  lessons: string[];
  achievements: string[];
  emotionalSummary: string;
}

export interface LifetimeMemory {
  totalDeaths: number;
  bestSurvivalMinutes: number;
  averageSurvivalMinutes: number;
  topDeathCauses: Array<{ cause: string; count: number }>;
}

interface EpisodeRow {
  generation: number;
  survival_minutes: number;
  death_cause: string;
  lessons_json: string;
  achievements_json: string;
  emotional_summary: string;
}

export class EpisodicMemory {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        generation        INTEGER PRIMARY KEY,
        survival_minutes  REAL NOT NULL,
        death_cause       TEXT NOT NULL,
        lessons_json      TEXT NOT NULL DEFAULT '[]',
        achievements_json TEXT NOT NULL DEFAULT '[]',
        emotional_summary TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS short_term_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        note       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  saveEpisode(ep: EpisodeSummary): void {
    this.db.prepare(`
      INSERT INTO episodes (generation, survival_minutes, death_cause, lessons_json, achievements_json, emotional_summary)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation) DO UPDATE SET
        survival_minutes = excluded.survival_minutes,
        death_cause = excluded.death_cause,
        lessons_json = excluded.lessons_json,
        achievements_json = excluded.achievements_json,
        emotional_summary = excluded.emotional_summary
    `).run(
      ep.generation,
      ep.survivalMinutes,
      ep.deathCause,
      JSON.stringify(ep.lessons),
      JSON.stringify(ep.achievements),
      ep.emotionalSummary,
    );
  }

  getRecentEpisodes(limit: number): EpisodeSummary[] {
    const rows = this.db.prepare(
      'SELECT * FROM episodes ORDER BY generation DESC LIMIT ?',
    ).all(limit) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  getAccumulatedLessons(): string[] {
    const rows = this.db.prepare(
      'SELECT lessons_json FROM episodes ORDER BY generation DESC',
    ).all() as Array<{ lessons_json: string }>;

    const seen = new Set<string>();
    const result: string[] = [];
    for (const row of rows) {
      const lessons: string[] = JSON.parse(row.lessons_json);
      for (const l of lessons) {
        if (!seen.has(l)) {
          seen.add(l);
          result.push(l);
        }
      }
    }
    return result;
  }

  getLifetimeMemory(): LifetimeMemory {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(MAX(survival_minutes), 0) as best,
        COALESCE(AVG(survival_minutes), 0) as avg
      FROM episodes
    `).get() as { total: number; best: number; avg: number };

    const causes = this.db.prepare(`
      SELECT death_cause as cause, COUNT(*) as count
      FROM episodes
      GROUP BY death_cause
      ORDER BY count DESC
      LIMIT 10
    `).all() as Array<{ cause: string; count: number }>;

    return {
      totalDeaths: stats.total,
      bestSurvivalMinutes: stats.best,
      averageSurvivalMinutes: Math.round(stats.avg * 10) / 10,
      topDeathCauses: causes,
    };
  }

  saveShortTermNote(note: string): void {
    this.db.prepare(
      'INSERT INTO short_term_notes (note) VALUES (?)',
    ).run(note);
  }

  getShortTermNotes(limit: number): string[] {
    const rows = this.db.prepare(
      'SELECT note FROM short_term_notes ORDER BY id DESC LIMIT ?',
    ).all(limit) as Array<{ note: string }>;
    return rows.map(r => r.note);
  }

  buildMemoryContext(maxEpisodes: number): string {
    const episodes = this.getRecentEpisodes(maxEpisodes);
    const lifetime = this.getLifetimeMemory();
    const lessons = this.getAccumulatedLessons();

    const lines: string[] = [];

    if (lifetime.totalDeaths > 0) {
      lines.push(`【過去の記録】死亡回数: ${lifetime.totalDeaths}, 最長生存: ${lifetime.bestSurvivalMinutes}分, 平均: ${lifetime.averageSurvivalMinutes}分`);
    }

    if (lifetime.topDeathCauses.length > 0) {
      lines.push(`【主な死因】${lifetime.topDeathCauses.map(c => `${c.cause}(${c.count}回)`).join(', ')}`);
    }

    if (lessons.length > 0) {
      lines.push(`【蓄積した教訓】`);
      for (const l of lessons.slice(0, 10)) {
        lines.push(`- ${l}`);
      }
    }

    for (const ep of episodes) {
      lines.push(`\n【世代${ep.generation}】${ep.survivalMinutes}分生存, 死因: ${ep.deathCause}`);
      if (ep.achievements.length > 0) {
        lines.push(`  達成: ${ep.achievements.join(', ')}`);
      }
      if (ep.emotionalSummary) {
        lines.push(`  感想: ${ep.emotionalSummary}`);
      }
    }

    return lines.join('\n');
  }
}

function rowToEpisode(row: EpisodeRow): EpisodeSummary {
  return {
    generation: row.generation,
    survivalMinutes: row.survival_minutes,
    deathCause: row.death_cause,
    lessons: JSON.parse(row.lessons_json),
    achievements: JSON.parse(row.achievements_json),
    emotionalSummary: row.emotional_summary,
  };
}
