import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import { EventsGateway } from '../ws/events.gateway';
import { ExecutorService } from './executor.service';
import { AgentRegistry } from '../agent-registry/agent-registry.service';
import { ActionsService } from '../actions/actions.service';
import { BuildParam } from '../common/types';
import { logsDir } from '../common/paths';

interface RunningEntry {
  abort: () => void;
  agentId?: string;
}

@Injectable()
export class EngineService implements OnModuleInit {
  private queue: number[] = [];
  private running = new Map<number, RunningEntry>();
  private sourceLocks = new Set<string>();
  private localRunning = 0;

  constructor(
    private db: DatabaseService,
    private settings: SettingsService,
    private executor: ExecutorService,
    private gateway: EventsGateway,
    private registry: AgentRegistry,
    private actions: ActionsService,
  ) {}

  onModuleInit() {
    // Agent 上线/空闲时触发调度
    this.registry.onIdle = () => this.pump();
  }

  /** 入队一次构建 */
  enqueue(configId: string, params: BuildParam[] = []) {
    const config = this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(configId) as any;
    if (!config) throw new NotFoundException('构建配置不存在');
    const project = this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(config.project_id) as any;
    if (!project) throw new NotFoundException('项目不存在');
    if (!project.valid) throw new BadRequestException('项目未通过有效性检测，请先在项目页重新检测');
    if (!String(config.execute_method ?? '').trim()) throw new BadRequestException('构建配置必须指定仓库中的 executeMethod');

    const now = this.db.now();
    const result = this.db.db
      .prepare('INSERT INTO builds(config_id, project_id, status, phase, progress, params, created_at) VALUES(?,?,?,?,0,?,?)')
      .run(configId, config.project_id, 'queued', 'prepare', JSON.stringify(params ?? []), now);
    const id = Number(result.lastInsertRowid);
    this.queue.push(id);
    this.broadcastQueue();
    this.gateway.emitBuildUpdate(this.getBuild(id));
    this.pump();
    return this.getBuild(id);
  }

  /** 取消构建：排队中直接移除；本机中断子进程；远程通知 Agent 中断 */
  cancel(buildId: number) {
    const build = this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as any;
    if (!build) throw new NotFoundException('构建不存在');
    if (build.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== buildId);
      this.db.db.prepare("UPDATE builds SET status='canceled', phase='done', finished_at=? WHERE id=?").run(this.db.now(), buildId);
      this.broadcastQueue();
      this.gateway.emitBuildUpdate(this.getBuild(buildId));
      return { ok: true };
    }
    if (build.status === 'running') {
      this.running.get(buildId)?.abort();
      return { ok: true };
    }
    throw new BadRequestException('该构建已结束，无法取消');
  }

  queueSnapshot() {
    return { queued: [...this.queue], running: [...this.running.keys()] };
  }

  getBuild(id: number) {
    return this.db.db
      .prepare(
        `SELECT b.*, p.name AS project_name, c.name AS config_name, a.name AS runner_name
         FROM builds b
         JOIN projects p ON p.id = b.project_id
         JOIN build_configs c ON c.id = b.config_id
         LEFT JOIN agents a ON a.id = b.runner
         WHERE b.id = ?`,
      )
      .get(id);
  }

  /** 调度循环：本机并发槽位 + 源目录互斥 + 按平台路由到 Agent */
  private pump() {
    let localFree = this.settings.getNumber('concurrency', 1) - this.localRunning;
    for (const id of [...this.queue]) {
      const target = this.place(id, localFree);
      if (!target) continue;
      this.queue = this.queue.filter((x) => x !== id);
      if (target === 'local') {
        localFree--;
        this.startLocal(id);
      } else {
        this.startOnAgent(id, target);
      }
    }
    this.broadcastQueue();
  }

  /** 决定构建运行位置：'local' 或 agentId；null 表示暂时无法调度（保持排队） */
  private place(buildId: number, localFree: number): 'local' | string | null {
    const info = this.db.db
      .prepare(
        `SELECT b.id, b.project_id, c.build_target, c.runner AS config_runner, p.source_type, p.path
         FROM builds b
         JOIN build_configs c ON c.id = b.config_id
         JOIN projects p ON p.id = b.project_id
         WHERE b.id = ?`,
      )
      .get(buildId) as any;
    if (!info) return null;

    const pref = info.config_runner ?? 'auto';
    const localOk = localFree > 0 && !this.isLocked(buildId);

    if (pref === 'local') return localOk ? 'local' : null;
    if (pref !== 'auto') {
      const a = this.registry.get(pref);
      return a && !a.busy ? a.id : null;
    }

    // 自动路由：iOS 必须 macOS；macOS 优先 mac agent；其余优先本机，溢出到任意空闲 agent
    const idleDarwin = this.registry.online().find((a) => a.platform === 'darwin' && !a.busy);
    if (info.build_target === 'iOS') {
      if (process.platform === 'darwin' && localOk) return 'local';
      return idleDarwin?.id ?? null;
    }
    if (info.build_target === 'macOS' && process.platform !== 'darwin' && idleDarwin) {
      return idleDarwin.id;
    }
    if (localOk) return 'local';
    const idleAny = this.registry.online().find((a) => !a.busy);
    return idleAny?.id ?? null;
  }

  /**
   * 源互斥锁（仅本机构建；Agent 有独立工作区）。
   * 复用 Library 时同一项目共用长期工作区，Git / 本地都按 projectId 互斥。
   * 关闭复用时维持原逻辑：仅同一本地目录互斥，Git 可并行。
   */
  private lockKey(buildId: number): string | null {
    const build = this.db.db.prepare('SELECT b.*, p.source_type, p.path FROM builds b JOIN projects p ON p.id = b.project_id WHERE b.id = ?').get(buildId) as any;
    if (!build) return null;
    if (this.settings.getBool('reuse_unity_library', true)) return `project:${build.project_id}:${build.build_target}`;
    if (build.source_type === 'local' && build.path) return `local:${build.path}`;
    return null;
  }

  private isLocked(buildId: number): boolean {
    const key = this.lockKey(buildId);
    return key != null && this.sourceLocks.has(key);
  }

  private startLocal(buildId: number) {
    const controller = new AbortController();
    this.running.set(buildId, { abort: () => controller.abort() });
    this.localRunning++;
    const key = this.lockKey(buildId);
    if (key) this.sourceLocks.add(key);
    this.broadcastQueue();

    this.executor
      .run(buildId, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(buildId);
        this.localRunning--;
        if (key) this.sourceLocks.delete(key);
        this.broadcastQueue();
        this.pump();
      });
  }

  private startOnAgent(buildId: number, agentId: string) {
    const build = this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as any;
    const config = this.decodeConfig(this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(build.config_id));
    const project = this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(build.project_id) as any;

    const logPath = path.join(logsDir(), `build-${buildId}.log`);
    this.db.db.prepare('UPDATE builds SET runner = ?, log_path = ? WHERE id = ?').run(agentId, logPath, buildId);

    this.running.set(buildId, { abort: () => this.registry.cancel(agentId, buildId), agentId });
    this.registry.setBusy(agentId, true);
    this.registry.assign(agentId, {
      build: { ...build, runner: agentId },
      config,
      project,
      settings: {
        license_username: this.settings.get('license_username'),
        license_password: this.settings.get('license_password'),
        license_serial: this.settings.get('license_serial'),
        license_ulf_path: this.settings.get('license_ulf_path'),
        script_timeout: this.settings.get('script_timeout', '1800'),
        unity_timeout: this.settings.get('unity_timeout', String(4 * 3600)),
        reuse_unity_library: this.settings.get('reuse_unity_library', 'true'),
        keep_failed_workspace: this.settings.get('keep_failed_workspace', 'false'),
      },
    });
    this.gateway.emitBuildUpdate(this.getBuild(buildId));
    this.broadcastQueue();
  }

  /** Agent 上报的状态补丁：落库、广播、终态时执行后置动作并释放调度资源 */
  applyAgentUpdate(buildId: number, patch: Record<string, any>) {
    const build = this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as any;
    if (!build) return;
    delete patch.id;
    delete patch.log_path;
    delete patch.workspace;
    delete patch.runner;
    const keys = Object.keys(patch);
    if (keys.length) {
      this.db.db.prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), buildId);
    }
    const updated = this.getBuild(buildId);
    this.gateway.emitBuildUpdate(updated);

    const status = patch.status;
    if (status === 'success' || status === 'failed' || status === 'canceled') {
      this.finishAgentBuild(buildId, status, updated);
    }
  }

  private async finishAgentBuild(buildId: number, status: string, build: any) {
    if (status !== 'canceled') {
      const config = this.decodeConfig(this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(build.config_id));
      const project = this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(build.project_id) as any;
      const art = this.db.db.prepare('SELECT * FROM artifacts WHERE build_id = ? ORDER BY id DESC LIMIT 1').get(buildId) as any;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        UCL_BUILD_ID: String(buildId),
        UCL_BUILD_STATUS: status,
        UCL_BUILD_TARGET: config.build_target ?? '',
        UCL_ARTIFACT_DIR: art?.path ?? '',
        UCL_VERSION_NAME: config.version_name ?? '',
      };
      await this.actions
        .run(config.actions, { build, config, project, status: status as any, artifactDir: art?.path, error: build.error, env, cwd: process.cwd() },
          (l) => this.gateway.emitBuildLog(buildId, `[后置动作] ${l}\n`))
        .catch(() => undefined);
    }
    const entry = this.running.get(buildId);
    if (entry?.agentId) this.registry.setBusy(entry.agentId, false);
    this.running.delete(buildId);
    this.broadcastQueue();
    this.pump();
  }

  private broadcastQueue() {
    this.gateway.emitQueue(this.queueSnapshot());
  }

  private decodeConfig(row: any): any {
    const out = { ...row };
    for (const f of ['scenes', 'extra_params', 'actions', 'pre_script', 'mid_script', 'post_script']) {
      try {
        out[f] = row[f] ? JSON.parse(row[f]) : f.includes('script') ? { enabled: false } : [];
      } catch {
        out[f] = f.includes('script') ? { enabled: false } : [];
      }
    }
    return out;
  }
}
