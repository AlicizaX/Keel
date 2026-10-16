import { Injectable, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'path';
import { dataDir } from '../common/paths';

@Injectable()
export class DatabaseService implements OnModuleInit {
  db: Database.Database;

  onModuleInit() {
    this.db = new Database(path.join(dataDir(), 'ucl.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        path TEXT,
        git_url TEXT,
        git_branch TEXT,
        valid INTEGER DEFAULT 0,
        unity_version TEXT,
        message TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS build_configs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        build_target TEXT NOT NULL DEFAULT 'Windows',
        unity_version TEXT,
        unity_path TEXT,
        execute_method TEXT,
        scenes TEXT DEFAULT '[]',
        defines TEXT DEFAULT '',
        version_name TEXT DEFAULT '1.0.0',
        version_code INTEGER DEFAULT 1,
        development INTEGER DEFAULT 0,
        output_name TEXT,
        pre_script TEXT,
        mid_script TEXT,
        post_script TEXT,
        extra_params TEXT DEFAULT '[]',
        retention_days INTEGER DEFAULT 7,
        actions TEXT DEFAULT '[]',
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT,
        progress INTEGER DEFAULT 0,
        params TEXT DEFAULT '{}',
        unity_version TEXT,
        workspace TEXT,
        log_path TEXT,
        artifact_dir TEXT,
        error TEXT,
        created_at TEXT,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        build_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        cleaned INTEGER DEFAULT 0,
        created_at TEXT,
        cleaned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS unity_installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        source TEXT DEFAULT 'host',
        platform TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT,
        version TEXT,
        created_at TEXT,
        last_seen_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_build ON artifacts(build_id);
    `);

    this.addColumn('build_configs', 'keep_debug_symbols', 'keep_debug_symbols INTEGER DEFAULT 0');
    this.addColumn('unity_installations', 'modules', "modules TEXT DEFAULT '[]'");
    this.addColumn('builds', 'phases', "phases TEXT DEFAULT '[]'");
    this.addColumn('build_configs', 'trigger_token', 'trigger_token TEXT');
    this.addColumn('builds', 'runner', 'runner TEXT');
    this.addColumn('build_configs', 'runner', "runner TEXT DEFAULT 'auto'");
    this.addColumn('projects', 'project_path', "project_path TEXT DEFAULT ''");
    this.addColumn('projects', 'git_lfs', 'git_lfs INTEGER DEFAULT 0');
    this.addColumn('projects', 'git_submodules', 'git_submodules INTEGER DEFAULT 0');
    this.addColumn('builds', 'commit_sha', 'commit_sha TEXT');
  }

  /** 轻量迁移：列不存在时补充 */
  private addColumn(table: string, column: string, ddl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  now(): string {
    return new Date().toISOString();
  }
}
