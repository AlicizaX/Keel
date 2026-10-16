import { Inject, Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { artifactsDir } from '../common/paths';
import { DEFAULT_OUTPUT, UNITY_TARGET_MAP, BuildPlatform, BuildParam } from '../common/types';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import { ScmService } from '../scm/scm.service';
import { UnityService } from '../unity/unity.service';
import { ActionsService } from '../actions/actions.service';
import { LogWriter } from './log-writer';
import { killTree } from './script-runner';
import { EXECUTOR_SINK, ExecutorSink } from './executor-sink';

/** Agent 执行时由主实例下发的上下文（Agent 本地库无这些行） */
export interface ExecutorContext {
  build: any;
  config: any;
  project: any;
}

@Injectable()
export class ExecutorService {
  constructor(
    private db: DatabaseService,
    private settings: SettingsService,
    private scm: ScmService,
    private unity: UnityService,
    private actions: ActionsService,
    @Inject(EXECUTOR_SINK) private sink: ExecutorSink,
  ) {}

  /** 执行一次构建（由引擎调度调用，永不向上抛异常）。Agent 模式传入 ctx 跳过本地库读取 */
  async run(buildId: number, signal: AbortSignal, ctx?: ExecutorContext): Promise<void> {
    const build = ctx?.build ?? (this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as any);
    const config = ctx?.config ?? this.decodeConfig(this.db.db.prepare('SELECT * FROM build_configs WHERE id = ?').get(build.config_id));
    const project = ctx?.project ?? (this.db.db.prepare('SELECT * FROM projects WHERE id = ?').get(build.project_id) as any);
    build.project_name = project.name;
    build.config_name = config.name;

    const logger = new LogWriter(buildId, (bid, chunk) => this.sink.emitLog(bid, chunk));
    const log = (l: string) => logger.write(l);
    const phaseTrail: { phase: string; at: string }[] = [{ phase: 'prepare', at: this.db.now() }];
    const setState = (patch: Record<string, any>) => {
      if (patch.phase && patch.phase !== build.phase) {
        phaseTrail.push({ phase: patch.phase, at: this.db.now() });
      }
      patch.phases = JSON.stringify(phaseTrail);
      this.sink.applyState(build, patch);
    };

    setState({ status: 'running', started_at: this.db.now(), phase: 'prepare', progress: 2, log_path: logger.filePath });
    log(`构建 #${buildId} 开始 | 项目 ${project.name} | 配置 ${config.name} | 平台 ${config.build_target}`);

    let workspace: string | undefined;
    let status: 'success' | 'failed' | 'canceled' = 'failed';
    let error: string | undefined;
    let artifactDir: string | undefined;
    let env: NodeJS.ProcessEnv = { ...process.env };

    try {
      // 1. 工作区
      const reuseLibrary = this.settings.getBool('reuse_unity_library', true);
      const prepared = await this.scm.prepareWorkspace(buildId, project, config.build_target, log, { reuseLibrary });
      workspace = prepared.workspace;
      this.requireDiskSpace(workspace, log);
      setState({ workspace, commit_sha: prepared.commit ?? null, phase: 'resolve', progress: 12 });

      // 3. 平台/编辑器解析
      const target = config.build_target as BuildPlatform;
      if (target === 'iOS' && process.platform !== 'darwin') {
        throw new Error('iOS 构建仅支持 macOS 宿主（依赖 Xcode），请在 Mac 上部署本工具后重试');
      }
      const unityVersion = this.requiredProjectVersion(workspace, project.unity_version);
      const editorPath = await this.unity.resolve(unityVersion, config.unity_path, log);
      log(`使用 Unity: ${editorPath}${unityVersion ? ` (${unityVersion})` : ''}`);
      setState({ unity_version: unityVersion ?? null });

      // 校验平台构建支持模块（含 IL2CPP 检测），缺失则立即失败并给出安装指引
      const il2cpp = this.detectIl2Cpp(workspace);
      if (il2cpp) log('检测到项目使用 IL2CPP 脚本后端');
      this.unity.verifyBuildSupport(editorPath, target, il2cpp);

      // 构建环境变量
      const runtimeParams: BuildParam[] = JSON.parse(build.params || '[]');
      const outDir = path.join(workspace, 'ucl-output');
      artifactDir = path.join(artifactsDir(), `build-${buildId}`);
      env = {
        ...process.env,
        UCL_BUILD_ID: String(buildId),
        UCL_PROJECT: project.name,
        UCL_CONFIG: config.name,
        UCL_WORKSPACE: workspace,
        UCL_OUTPUT_DIR: outDir,
        UCL_ARTIFACT_DIR: artifactDir,
        UCL_BUILD_TARGET: target,
        UCL_UNITY_TARGET: UNITY_TARGET_MAP[target],
        UCL_VERSION_NAME: config.version_name ?? '',
        UCL_VERSION_CODE: String(config.version_code ?? ''),
      };
      for (const p of [...(config.extra_params ?? []), ...runtimeParams]) {
        if (p?.key) env[`UCL_PARAM_${p.key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`] = p.value ?? '';
      }

      // 4. Unity 构建
      setState({ phase: 'build', progress: 30 });
      await this.runUnity(buildId, editorPath, workspace, config, target, outDir, env, logger, signal);
      setState({ progress: 85 });

      // 5. 产物归档
      setState({ phase: 'collect', progress: 90 });
      if (!fs.existsSync(outDir)) throw new Error(`构建未产出 ucl-output: ${outDir}`);
      fs.rmSync(artifactDir, { recursive: true, force: true });
        fs.cpSync(outDir, artifactDir, { recursive: true });
        if (!config.keep_debug_symbols) {
          const pruned = this.pruneDebugDirs(artifactDir);
          if (pruned > 0) log(`已剔除 ${pruned} 个 Unity 调试目录（BackUpThisFolder / BurstDebugInformation）`);
        }
        const size = this.dirSize(artifactDir);
        this.db.db
          .prepare('INSERT INTO artifacts(build_id, path, size, cleaned, created_at) VALUES(?,?,?,0,?)')
          .run(buildId, artifactDir, size, this.db.now());
        setState({ artifact_dir: artifactDir });
      log(`产物已归档: ${artifactDir} (${this.humanSize(size)})`);

      status = 'success';
      setState({ phase: 'actions', progress: 96 });
    } catch (e: any) {
      if (e?.message === 'canceled' || signal.aborted) {
        status = 'canceled';
        log('构建已取消');
      } else {
        status = 'failed';
        error = e?.message ?? String(e);
        log(`构建失败: ${error}`);
      }
    }

    // 后置动作（成功/失败均可触发）
    env.UCL_BUILD_STATUS = status;
    if (status !== 'canceled') {
      await this.actions.run(config.actions, { build, config, project, status, artifactDir, error, env, cwd: workspace ?? process.cwd() }, log);
    }

    // 复用 Library 时保留长期工作区；否则成功总是清理，失败按设置决定是否保留
    const reuseLibrary = this.settings.getBool('reuse_unity_library', true);
    if (reuseLibrary) {
      if (workspace) {
        const outDir = path.join(workspace, 'ucl-output');
        fs.rmSync(outDir, { recursive: true, force: true });
        log(`工作区已保留（复用 Library）: ${workspace}`);
      }
    } else {
      const keepFailed = this.settings.getBool('keep_failed_workspace', false);
      if (workspace && (status === 'success' || !keepFailed)) {
        await this.scm.cleanupWorkspace(buildId, project).catch(() => undefined);
      } else if (workspace) {
        log(`工作区已保留（可在设置中关闭）: ${workspace}`);
      }
    }

    setState({ status, error: error ?? null, phase: 'done', progress: status === 'success' ? 100 : build.progress, finished_at: this.db.now() });
    log(`构建 #${buildId} 结束: ${status}`);
    logger.close();
  }

  /** 调用 Unity 批处理构建，日志实时汇入构建日志 */
  private async runUnity(
    buildId: number,
    editorPath: string,
    workspace: string,
    config: any,
    target: BuildPlatform,
    outDir: string,
    env: NodeJS.ProcessEnv,
    logger: LogWriter,
    signal: AbortSignal,
  ): Promise<void> {
    const outputName = config.output_name?.trim() || DEFAULT_OUTPUT[target];
    const paramsFile = path.join(workspace, 'ucl_build_params.json');
    fs.writeFileSync(
      paramsFile,
      JSON.stringify({
        buildTarget: UNITY_TARGET_MAP[target],
        outputPath: path.join(outDir, outputName),
        scenes: config.scenes ?? [],
        defines: config.defines ?? '',
        versionName: config.version_name ?? '',
        versionCode: Number(config.version_code ?? 0),
        development: !!config.development,
      }),
      'utf8',
    );

    const method = config.execute_method?.trim();
    if (!method) throw new Error('构建配置未指定 executeMethod');
    const editorLog = path.join(workspace, 'ucl-editor.log');
    const args = ['-batchmode', '-quit', '-projectPath', workspace, '-executeMethod', method, '-uclParams', paramsFile, '-logFile', editorLog];
    if (process.platform === 'linux') args.push('-nographics');

    // 授权参数
    const user = this.settings.get('license_username');
    const pass = this.settings.get('license_password');
    const serial = this.settings.get('license_serial');
    const ulf = this.settings.get('license_ulf_path');
    if (ulf) args.push('-manualLicenseFile', ulf);
    else if (user && pass && serial) args.push('-username', user, '-password', pass, '-serial', serial);

    logger.write(`调用 Unity: ${method}`);
    const timeoutSec = this.settings.getNumber('unity_timeout', 4 * 3600);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(editorPath, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let settled = false;

      // Windows 下 Unity 不输出到 stdout，tail 编辑器日志文件；其他平台直接读 stdout
      let stopTail: (() => void) | undefined;
      if (process.platform === 'win32') {
        stopTail = this.tailFile(editorLog, (chunk) => logger.raw(chunk));
      } else {
        child.stdout?.on('data', (d) => logger.raw(d.toString('utf8')));
      }
      child.stderr?.on('data', (d) => logger.raw(d.toString('utf8')));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stopTail?.();
        killTree(child);
        reject(new Error(`Unity 构建超时（${Math.round(timeoutSec / 3600)}h）`));
      }, timeoutSec * 1000);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopTail?.();
        killTree(child);
        reject(new Error('canceled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopTail?.();
        reject(new Error(`无法启动 Unity: ${err.message}`));
      });

      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        // 最终补读一次日志文件
        try {
          if (process.platform === 'win32' && fs.existsSync(editorLog)) {
            // tail 已在读，这里仅停顿一拍后关闭
          }
        } catch { /* 忽略 */ }
        setTimeout(() => {
          stopTail?.();
          if (code === 0) resolve();
          else reject(new Error(`Unity 构建失败，退出码 ${code}（详见上方编辑器日志）`));
        }, 1200);
      });
    });
  }

  /** 轮询 tail 文件增量内容，返回停止函数 */
  private tailFile(file: string, emit: (chunk: string) => void): () => void {
    let offset = 0;
    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(file)) return;
        const size = fs.statSync(file).size;
        if (size <= offset) return;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        emit(buf.toString('utf8'));
      } catch { /* 文件暂不可读 */ }
    }, 800);
    return () => {
      clearInterval(timer);
      try {
        if (fs.existsSync(file)) {
          const size = fs.statSync(file).size;
          if (size > offset) {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            emit(buf.toString('utf8'));
          }
        }
      } catch { /* 忽略 */ }
    };
  }

  /** 磁盘满时 Unity 的报错不可用。这里只检查，不清理。 */
  private requireDiskSpace(workspace: string, log: (line: string) => void): void {
    const root = path.parse(workspace).root;
    let free = 0;
    try {
      const stat = fs.statfsSync(root);
      free = stat.bavail * stat.bsize;
    } catch (e: any) {
      throw new Error(`无法读取工作区磁盘剩余空间: ${e.message}`);
    }
    const min = 20 * 1024 ** 3;
    log(`工作区磁盘剩余 ${this.humanSize(free)}`);
    if (free < min) throw new Error(`工作区磁盘剩余 ${this.humanSize(free)}，构建至少需要 ${this.humanSize(min)}`);
  }

  /** 编辑器必须精确匹配工程 ProjectVersion.txt，不允许用其他已安装版本代替。 */
  private requiredProjectVersion(workspace: string, detectedVersion?: string): string {
    const versionFile = path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt');
    if (!fs.existsSync(versionFile)) throw new Error(`缺少 ProjectSettings/ProjectVersion.txt: ${workspace}`);
    const match = fs.readFileSync(versionFile, 'utf8').match(/m_EditorVersion:\s*(\S+)/);
    const version = match?.[1];
    if (!version) throw new Error('无法从 ProjectVersion.txt 解析 Unity 版本');
    if (detectedVersion && detectedVersion !== version) {
      throw new Error(`项目记录的 Unity 版本 ${detectedVersion} 与 ProjectVersion.txt 的 ${version} 不一致，请重新检测项目`);
    }
    return version;
  }

  /** 检测工程是否使用 IL2CPP 脚本后端（ProjectSettings.asset 中 scriptingBackend: 1） */
  private detectIl2Cpp(workspace: string): boolean {
    try {
      const file = path.join(workspace, 'ProjectSettings', 'ProjectSettings.asset');
      if (!fs.existsSync(file)) return false;
      const content = fs.readFileSync(file, 'utf8');
      const section = content.match(/scriptingBackend:([\s\S]*?)(?=\n {2}\w|$)/m);
      return section ? /:\s*1\s*$/m.test(section[1]) : false;
    } catch {
      return false;
    }
  }

  /** 递归删除 Unity 构建附带的调试目录（ *_BackUpThisFolder_ButDontShipItWithYourGame / *_BurstDebugInformation_DoNotShip ），返回删除数量 */
  private pruneDebugDirs(dir: string): number {
    let removed = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.endsWith('_BackUpThisFolder_ButDontShipItWithYourGame') || e.name.endsWith('_BurstDebugInformation_DoNotShip')) {
        fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
        removed++;
      } else {
        removed += this.pruneDebugDirs(path.join(dir, e.name));
      }
    }
    return removed;
  }

  private dirSize(dir: string): number {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += this.dirSize(p);
      else total += fs.statSync(p).size;
    }
    return total;
  }

  private humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
