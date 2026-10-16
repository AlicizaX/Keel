import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import { DatabaseService } from '../db/database.service';

@Injectable()
export class ArtifactsService {
  private logger = new Logger('Artifacts');

  constructor(private db: DatabaseService) {}

  list() {
    return this.db.db
      .prepare(
        `SELECT a.*, b.status AS build_status, p.name AS project_name, c.name AS config_name, c.build_target
         FROM artifacts a
         JOIN builds b ON b.id = a.build_id
         JOIN projects p ON p.id = b.project_id
         JOIN build_configs c ON c.id = b.config_id
         ORDER BY a.id DESC LIMIT 500`,
      )
      .all();
  }

  get(id: number) {
    return this.db.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as any;
  }

  /** 手动清理单份产物（任务记录保留） */
  cleanOne(id: number) {
    const art = this.get(id);
    if (!art) throw new NotFoundException('产物不存在');
    if (!art.cleaned) {
      fs.rmSync(art.path, { recursive: true, force: true });
      this.db.db.prepare('UPDATE artifacts SET cleaned = 1, cleaned_at = ? WHERE id = ?').run(this.db.now(), id);
    }
    return { ok: true };
  }

  /** 每小时执行一次：清理超过保留期的产物（任务记录保留） */
  @Cron(CronExpression.EVERY_HOUR)
  cleanupExpired(): { cleaned: number } {
    const rows = this.db.db
      .prepare(
        `SELECT a.id AS artifact_id, a.path, c.retention_days, b.finished_at
         FROM artifacts a
         JOIN builds b ON b.id = a.build_id
         JOIN build_configs c ON c.id = b.config_id
         WHERE a.cleaned = 0 AND b.finished_at IS NOT NULL`,
      )
      .all() as any[];

    let cleaned = 0;
    const now = Date.now();
    for (const r of rows) {
      const days = Number(r.retention_days ?? 7);
      const ageDays = (now - new Date(r.finished_at).getTime()) / 86400000;
      if (ageDays <= days) continue;
      try {
        fs.rmSync(r.path, { recursive: true, force: true });
        this.db.db.prepare('UPDATE artifacts SET cleaned = 1, cleaned_at = ? WHERE id = ?').run(this.db.now(), r.artifact_id);
        cleaned++;
      } catch (e: any) {
        this.logger.warn(`清理产物失败 ${r.path}: ${e.message}`);
      }
    }
    if (cleaned > 0) this.logger.log(`已清理 ${cleaned} 份过期产物`);
    return { cleaned };
  }
}
