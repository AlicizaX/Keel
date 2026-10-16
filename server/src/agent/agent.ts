/**
 * UCL Remote Agent
 * 在构建机（如 Mac）上运行，主动外连主实例，接收构建任务并回流日志/状态/产物。
 *
 * 用法:
 *   node dist/agent/agent.js --server http://<主实例地址>:7850 --token <agentToken> --name mac-mini
 * 环境变量: UCL_SERVER / UCL_AGENT_TOKEN / UCL_AGENT_NAME / UCL_DATA_DIR
 */
import 'reflect-metadata';
import { io, Socket } from 'socket.io-client';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import { ScmService } from '../scm/scm.service';
import { UnityService } from '../unity/unity.service';
import { ExecutorService } from '../engine/executor.service';
import { ExecutorSink } from '../engine/executor-sink';
import { tmpDir } from '../common/paths';

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const SERVER = (arg('server') ?? process.env.UCL_SERVER ?? 'http://localhost:7850').replace(/\/+$/, '');
const TOKEN = arg('token') ?? process.env.UCL_AGENT_TOKEN ?? '';
const NAME = arg('name') ?? process.env.UCL_AGENT_NAME ?? os.hostname();

if (!TOKEN) {
  console.error('[agent] 缺少 --token（在主实例设置页创建 Agent 获取）');
  process.exit(1);
}

/** Agent 侧状态出口：走 socket 上报；终态补丁暂存，待产物上传后再发出 */
class AgentSink implements ExecutorSink {
  private pendingFinal: { buildId: number; patch: Record<string, any> } | null = null;

  constructor(private socket: Socket) {}

  applyState(build: any, patch: Record<string, any>): void {
    Object.assign(build, patch);
    const p = { ...patch };
    delete p.log_path;
    delete p.workspace;
    const status = p.status;
    if (status === 'success' || status === 'failed' || status === 'canceled') {
      this.pendingFinal = { buildId: build.id, patch: p };
      return;
    }
    this.socket.emit('build:update', { buildId: build.id, patch: p });
  }

  flushFinal() {
    if (this.pendingFinal) {
      this.socket.emit('build:update', this.pendingFinal);
      this.pendingFinal = null;
    }
  }

  emitLog(buildId: number, chunk: string): void {
    this.socket.emit('build:log', { buildId, chunk });
  }
}

async function main() {
  const db = new DatabaseService();
  db.onModuleInit();
  const settings = new SettingsService(db);
  const scm = new ScmService();
  const unity = new UnityService(db, settings);
  // 后置动作由主实例统一执行，Agent 侧为空实现
  const noopActions: any = { run: async () => undefined };

  const socket = io(`${SERVER}/agent`, {
    path: '/ws',
    auth: { token: TOKEN, name: NAME, platform: process.platform },
    reconnection: true,
    reconnectionDelay: 3000,
  });

  const sink = new AgentSink(socket);
  const executor = new ExecutorService(db, settings, scm, unity, noopActions, sink);

  let busy = false;
  const cancels = new Map<number, AbortController>();

  socket.on('connect', () => {
    console.log(`[agent] 已连接主实例 ${SERVER}（${NAME} / ${process.platform}）`);
    socket.emit('agent:hello', { name: NAME, platform: process.platform, version: '0.1.0' });
  });
  socket.on('disconnect', (reason) => console.log(`[agent] 连接断开: ${reason}`));
  socket.on('connect_error', (e) => console.log(`[agent] 连接失败: ${e.message}（3s 后重试）`));

  socket.on('build:cancel', ({ buildId }: { buildId: number }) => {
    console.log(`[agent] 收到取消指令: 构建 #${buildId}`);
    cancels.get(buildId)?.abort();
  });

  socket.on('build:assign', async (payload: any) => {
    if (busy) {
      console.log('[agent] 忙碌中，忽略分配（主实例应避免重复派发）');
      return;
    }
    busy = true;
    const buildId = payload.build.id;
    console.log(`[agent] 接收构建 #${buildId} | ${payload.project.name} / ${payload.config.name} / ${payload.config.build_target}`);

    // 应用主实例下发的设置（授权、超时等）
    for (const [k, v] of Object.entries(payload.settings ?? {})) {
      settings.set(k, String(v ?? ''));
    }

    const controller = new AbortController();
    cancels.set(buildId, controller);
    try {
      await executor.run(buildId, controller.signal, {
        build: payload.build,
        config: payload.config,
        project: payload.project,
      });

      // 产物回传（在终态上报之前完成，保证主实例后置动作能拿到产物）
      const art = db.db.prepare('SELECT * FROM artifacts WHERE build_id = ? ORDER BY id DESC LIMIT 1').get(buildId) as any;
      if (art && fs.existsSync(art.path)) {
        try {
          console.log('[agent] 打包并上传产物...');
          await uploadArtifact(buildId, art.path);
          console.log('[agent] 产物上传完成');
        } catch (e: any) {
          sink.emitLog(buildId, `[agent] 产物上传失败: ${e.message}\n`);
        }
        db.db.prepare('DELETE FROM artifacts WHERE build_id = ?').run(buildId);
      }
    } catch (e: any) {
      console.error(`[agent] 构建异常: ${e.message}`);
    } finally {
      sink.flushFinal();
      cancels.delete(buildId);
      busy = false;
      console.log(`[agent] 构建 #${buildId} 结束，待命中`);
    }
  });

  async function uploadArtifact(buildId: number, dir: string): Promise<void> {
    const tgz = path.join(tmpDir(), `artifact-${buildId}.tar.gz`);
    fs.rmSync(tgz, { force: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('tar', ['-czf', tgz, '-C', dir, '.'], { stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 打包失败，退出码 ${code}`))));
      p.on('error', reject);
    });
    try {
      const res = await fetch(`${SERVER}/api/agents/artifacts/${buildId}`, {
        method: 'POST',
        headers: { 'x-agent-token': TOKEN },
        body: fs.createReadStream(tgz),
        duplex: 'half',
      } as any);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      fs.rmSync(tgz, { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('[agent] 启动失败:', e);
  process.exit(1);
});
