import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import * as fs from 'fs';
import { DatabaseService } from '../db/database.service';
import { ScmService } from '../scm/scm.service';

@Controller('builds')
export class BuildsController {
  constructor(
    private db: DatabaseService,
    private scm: ScmService,
  ) {}

  @Get()
  list(@Query('status') status?: string, @Query('limit') limit?: string) {
    const lim = Math.min(Number(limit) || 100, 500);
    const where = status ? 'WHERE b.status = ?' : '';
    const args: any[] = status ? [status, lim] : [lim];
    return this.db.db
      .prepare(
        `SELECT b.id, b.config_id, b.project_id, b.status, b.phase, b.progress, b.unity_version,
                b.error, b.created_at, b.started_at, b.finished_at, b.artifact_dir, b.runner,
                p.name AS project_name, c.name AS config_name, c.build_target,
                a.name AS runner_name
         FROM builds b
         JOIN projects p ON p.id = b.project_id
         JOIN build_configs c ON c.id = b.config_id
         LEFT JOIN agents a ON a.id = b.runner
         ${where}
         ORDER BY b.id DESC LIMIT ?`,
      )
      .all(...args);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    const row = this.db.db
      .prepare(
        `SELECT b.*, p.name AS project_name, c.name AS config_name, c.build_target, a.name AS runner_name
         FROM builds b
         JOIN projects p ON p.id = b.project_id
         JOIN build_configs c ON c.id = b.config_id
         LEFT JOIN agents a ON a.id = b.runner
         WHERE b.id = ?`,
      )
      .get(id);
    if (!row) throw new NotFoundException('构建不存在');
    return row;
  }

  /** 删除历史构建：连同产物文件、日志、残留工作区一并清理 */
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const build = this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as any;
    if (!build) throw new NotFoundException('构建不存在');
    if (build.status === 'queued' || build.status === 'running') {
      throw new BadRequestException('构建排队或进行中，请先取消');
    }

    // 产物文件与记录
    const arts = this.db.db.prepare('SELECT * FROM artifacts WHERE build_id = ?').all(id) as any[];
    for (const a of arts) fs.rmSync(a.path, { recursive: true, force: true });
    this.db.db.prepare('DELETE FROM artifacts WHERE build_id = ?').run(id);

    // 日志文件
    if (build.log_path) fs.rmSync(build.log_path, { force: true });

    // 残留工作区（含 git worktree 元数据）
    const project = this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(build.project_id) as any;
    if (project) await this.scm.cleanupWorkspace(id, project).catch(() => undefined);

    this.db.db.prepare('DELETE FROM builds WHERE id = ?').run(id);
    return { ok: true };
  }

  /** 读取构建日志（支持 offset 增量） */
  @Get(':id/log')
  log(@Param('id', ParseIntPipe) id: number, @Query('offset') offset?: string) {
    const build = this.db.db.prepare('SELECT log_path FROM builds WHERE id = ?').get(id) as any;
    if (!build?.log_path || !fs.existsSync(build.log_path)) return { content: '', size: 0 };
    const size = fs.statSync(build.log_path).size;
    const from = Math.max(0, Math.min(Number(offset) || 0, size));
    const fd = fs.openSync(build.log_path, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return { content: buf.toString('utf8'), size };
  }
}
