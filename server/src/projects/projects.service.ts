import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { ScmService } from '../scm/scm.service';

@Injectable()
export class ProjectsService {
  constructor(
    private db: DatabaseService,
    private scm: ScmService,
  ) {}

  list() {
    const rows = this.db.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM build_configs c WHERE c.project_id = p.id) AS config_count
         FROM projects p ORDER BY p.created_at DESC`,
      )
      .all();
    return rows;
  }

  get(id: string) {
    const row = this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) throw new NotFoundException('项目不存在');
    return row;
  }

  async create(dto: { name: string; source_type: 'local' | 'git'; path?: string; git_url?: string; git_branch?: string; project_path?: string; git_lfs?: boolean; git_submodules?: boolean }) {
    if (!dto.name?.trim()) throw new BadRequestException('项目名称不能为空');
    if (dto.source_type === 'local' && !dto.path?.trim()) throw new BadRequestException('本地项目必须填写目录路径');
    if (dto.source_type === 'git' && !dto.git_url?.trim()) throw new BadRequestException('Git 项目必须填写仓库地址');

    const id = randomUUID();
    const now = this.db.now();
    this.db.db
      .prepare(
        `INSERT INTO projects(id, name, source_type, path, git_url, git_branch, project_path, git_lfs, git_submodules, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, dto.name.trim(), dto.source_type, dto.path ?? null, dto.git_url ?? null, dto.git_branch ?? null,
        this.normalizeRelativePath(dto.project_path), dto.git_lfs ? 1 : 0, dto.git_submodules ? 1 : 0, now, now,
      );
    await this.check(id).catch(() => undefined);
    return this.get(id);
  }

  async update(id: string, dto: Partial<{ name: string; path: string; git_url: string; git_branch: string; project_path: string; git_lfs: boolean; git_submodules: boolean }>) {
    const p = this.get(id) as any;
    this.db.db
      .prepare('UPDATE projects SET name=?, path=?, git_url=?, git_branch=?, project_path=?, git_lfs=?, git_submodules=?, updated_at=? WHERE id=?')
      .run(
        dto.name ?? p.name,
        dto.path ?? p.path,
        dto.git_url ?? p.git_url,
        dto.git_branch ?? p.git_branch,
        dto.project_path !== undefined ? this.normalizeRelativePath(dto.project_path) : p.project_path,
        dto.git_lfs !== undefined ? (dto.git_lfs ? 1 : 0) : p.git_lfs,
        dto.git_submodules !== undefined ? (dto.git_submodules ? 1 : 0) : p.git_submodules,
        this.db.now(),
        id,
      );
    return this.get(id);
  }

  private normalizeRelativePath(value?: string): string {
    const normalized = (value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalized.split('/').includes('..')) throw new BadRequestException('Unity 工程相对路径不能包含 ..');
    return normalized;
  }

  async remove(id: string) {
    this.get(id);
    const count = this.db.db.prepare('SELECT COUNT(*) AS n FROM builds WHERE project_id = ?').get(id) as any;
    if (count.n > 0) throw new BadRequestException('该项目存在构建记录，不能删除');
    this.db.db.prepare('DELETE FROM build_configs WHERE project_id = ?').run(id);
    this.db.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await this.scm.removeProjectData(id).catch(() => undefined);
    return { ok: true };
  }

  /** 清除长期工作区中的 Unity Library 等缓存，下次构建会重新导入 */
  async clearCache(id: string) {
    this.get(id);
    const assertIdle = () => {
      const busy = this.db.db
        .prepare("SELECT COUNT(*) AS n FROM builds WHERE project_id = ? AND status IN ('queued','running')")
        .get(id) as any;
      if (busy.n > 0) throw new BadRequestException('项目有排队或进行中的构建，请等待结束后再清除缓存');
    };
    assertIdle();
    await this.scm.clearLibraryCache(id, assertIdle);
    return { ok: true };
  }

  /** 重新检测工程有效性与 Unity 版本 */
  async check(id: string) {
    const p = this.get(id) as any;
    const result =
      p.source_type === 'git'
        ? await this.scm.inspectGitProject(p.git_url, p.git_branch, p.project_path, !!p.git_submodules)
        : this.scm.inspectUnityProject(p.path);
    this.db.db
      .prepare('UPDATE projects SET valid=?, unity_version=?, message=?, updated_at=? WHERE id=?')
      .run(result.valid ? 1 : 0, result.version ?? null, result.message ?? null, this.db.now(), id);
    return this.get(id);
  }
}
