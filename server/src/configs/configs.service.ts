import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { BUILD_TARGETS, defaultScript } from '../common/types';

const JSON_FIELDS = ['scenes', 'extra_params', 'actions', 'pre_script', 'mid_script', 'post_script'];

@Injectable()
export class ConfigsService {
  constructor(private db: DatabaseService) {}

  private decode(row: any) {
    if (!row) return row;
    const out = { ...row };
    for (const f of JSON_FIELDS) {
      try {
        out[f] = row[f] ? JSON.parse(row[f]) : f.includes('script') ? defaultScript() : [];
      } catch {
        out[f] = f.includes('script') ? defaultScript() : [];
      }
    }
    out.development = !!row.development;
    out.keep_debug_symbols = !!row.keep_debug_symbols;
    return out;
  }

  private encode(dto: any) {
    const out = { ...dto };
    for (const f of JSON_FIELDS) {
      if (out[f] !== undefined && typeof out[f] !== 'string') out[f] = JSON.stringify(out[f] ?? null);
    }
    if (out.development !== undefined) out.development = out.development ? 1 : 0;
    if (out.keep_debug_symbols !== undefined) out.keep_debug_symbols = out.keep_debug_symbols ? 1 : 0;
    return out;
  }

  private validate(dto: any) {
    if (dto.build_target && !BUILD_TARGETS.includes(dto.build_target)) {
      throw new BadRequestException(`不支持的构建平台: ${dto.build_target}`);
    }
    if (dto.retention_days !== undefined && Number(dto.retention_days) < 0) {
      throw new BadRequestException('保留天数不能为负数');
    }
    if (!String(dto.execute_method ?? '').trim()) {
      throw new BadRequestException('必须指定仓库中的 executeMethod');
    }
  }

  listByProject(projectId: string) {
    const rows = this.db.db
      .prepare('SELECT * FROM build_configs WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId);
    return rows.map((r) => this.decode(r));
  }

  get(id: string) {
    const row = this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(id);
    if (!row) throw new NotFoundException('构建配置不存在');
    return this.decode(row);
  }

  create(dto: any) {
    if (!dto.project_id) throw new BadRequestException('缺少 project_id');
    if (!dto.name?.trim()) throw new BadRequestException('配置名称不能为空');
    this.validate({ execute_method: '', ...dto });
    const p = this.db.db.prepare('SELECT id FROM projects WHERE id = ?').get(dto.project_id);
    if (!p) throw new BadRequestException('所属项目不存在');

    const id = randomUUID();
    const now = this.db.now();
    const d = this.encode({
      build_target: 'Windows',
      scenes: [],
      defines: '',
      version_name: '1.0.0',
      version_code: 1,
      development: 0,
      extra_params: [],
      retention_days: 7,
      actions: [],
      pre_script: defaultScript(),
      mid_script: defaultScript(),
      post_script: defaultScript(),
      ...dto,
    });
    this.db.db
      .prepare(
        `INSERT INTO build_configs(id, project_id, name, build_target, unity_version, unity_path, execute_method,
          scenes, defines, version_name, version_code, development, output_name,
          pre_script, mid_script, post_script, extra_params, retention_days, actions, keep_debug_symbols, runner, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, d.project_id, d.name.trim(), d.build_target, d.unity_version ?? null, d.unity_path ?? null,
        d.execute_method ?? null, d.scenes, d.defines, d.version_name, d.version_code, d.development,
        d.output_name ?? null, d.pre_script, d.mid_script, d.post_script, d.extra_params,
        d.retention_days, d.actions, d.keep_debug_symbols ?? 0, d.runner ?? 'auto', now, now,
      );
    return this.get(id);
  }

  update(id: string, dto: any) {
    const cur = this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(id) as any;
    if (!cur) throw new NotFoundException('构建配置不存在');
    const merged = { ...this.decode(cur), ...dto };
    this.validate(merged);
    const d = this.encode({ ...merged, id: undefined, project_id: undefined });
    this.db.db
      .prepare(
        `UPDATE build_configs SET name=?, build_target=?, unity_version=?, unity_path=?, execute_method=?,
          scenes=?, defines=?, version_name=?, version_code=?, development=?, output_name=?,
          pre_script=?, mid_script=?, post_script=?, extra_params=?, retention_days=?, actions=?, keep_debug_symbols=?, runner=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        d.name, d.build_target, d.unity_version ?? null, d.unity_path ?? null, d.execute_method ?? null,
        d.scenes, d.defines, d.version_name, d.version_code, d.development, d.output_name ?? null,
        d.pre_script, d.mid_script, d.post_script, d.extra_params, d.retention_days, d.actions,
        d.keep_debug_symbols ?? 0, d.runner ?? 'auto', this.db.now(), id,
      );
    return this.get(id);
  }

  remove(id: string) {
    this.get(id);
    const count = this.db.db.prepare('SELECT COUNT(*) AS n FROM builds WHERE config_id = ?').get(id) as any;
    if (count.n > 0) throw new BadRequestException('该配置存在构建记录，不能删除');
    this.db.db.prepare('DELETE FROM build_configs WHERE id = ?').run(id);
    return { ok: true };
  }

  /** 读取触发 token（可能为空） */
  getTriggerToken(id: string): string | null {
    const row = this.db.db.prepare('SELECT trigger_token FROM build_configs WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundException('构建配置不存在');
    return row.trigger_token ?? null;
  }

  /** 生成或重置触发 token（重置后旧链接立即失效） */
  rotateTriggerToken(id: string): string {
    this.get(id);
    const token = randomBytes(24).toString('hex');
    this.db.db.prepare('UPDATE build_configs SET trigger_token = ? WHERE id = ?').run(token, id);
    return token;
  }
}
