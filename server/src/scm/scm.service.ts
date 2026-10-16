import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { reposDir, tmpDir, workspacesDir } from '../common/paths';

export interface ProjectRow {
  id: string;
  name: string;
  source_type: 'local' | 'git';
  path?: string;
  git_url?: string;
  git_branch?: string;
  project_path?: string;
  git_lfs?: number;
  git_submodules?: number;
}

/** 本地目录复制时排除的目录 */
const LOCAL_EXCLUDES = new Set(['Library', 'Temp', 'obj', 'Obj', 'Logs', '.git', '.vs', '.idea', 'ucl-output', 'node_modules']);

/** 长期工作区中由 Unity / 构建产生、同步与 git clean 时必须保留的目录。
 * HybridCLRData 由构建机 Install 生成，不入库；清掉会导致每次构建重新安装。 */
const PROTECTED_DIRS = ['Library', 'Temp', 'Logs', 'obj', 'Obj', 'ucl-output', 'HybridCLRData'] as const;
const PROTECTED_SET = new Set<string>(PROTECTED_DIRS);

@Injectable()
export class ScmService {
  /** 同一项目仓库缓存的串行锁（fetch / worktree 操作互斥） */
  private locks = new Map<string, Promise<unknown>>();

  persistentWorkspace(projectId: string, buildTarget: string): string {
    return path.join(workspacesDir(), `project-${projectId}-${this.workspaceSlug(buildTarget)}`);
  }

  /** 新工作区按平台分开；同时认旧的 project-<id>，清除和删除时不留下孤儿目录。 */
  listPersistentWorkspaces(projectId: string): string[] {
    const root = workspacesDir();
    const legacy = path.join(root, `project-${projectId}`);
    const prefix = `project-${projectId}-`;
    const dirs = fs.existsSync(legacy) ? [legacy] : [];
    if (!fs.existsSync(root)) return dirs;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(prefix)) dirs.push(path.join(root, name));
    }
    return dirs;
  }

  private workspaceSlug(buildTarget: string): string {
    const slug = buildTarget.trim().replace(/[^A-Za-z0-9._-]/g, '-');
    if (!slug) throw new Error('构建平台不能为空');
    return slug;
  }

  ephemeralWorkspace(buildId: number): string {
    return path.join(workspacesDir(), `build-${buildId}`);
  }

  /** 检测目录是否为有效 Unity 工程，并读取 Unity 版本 */
  inspectUnityProject(dir: string): { valid: boolean; version?: string; message?: string } {
    if (!fs.existsSync(dir)) return { valid: false, message: `目录不存在: ${dir}` };
    const hasAssets = fs.existsSync(path.join(dir, 'Assets'));
    const hasSettings = fs.existsSync(path.join(dir, 'ProjectSettings'));
    if (!hasAssets || !hasSettings) {
      return { valid: false, message: '缺少 Assets 或 ProjectSettings 目录，不是有效的 Unity 工程' };
    }
    const versionFile = path.join(dir, 'ProjectSettings', 'ProjectVersion.txt');
    if (!fs.existsSync(versionFile)) {
      return { valid: true, message: '有效工程，但未找到 ProjectVersion.txt，无法识别版本' };
    }
    const content = fs.readFileSync(versionFile, 'utf8');
    const m = content.match(/m_EditorVersion:\s*(\S+)/);
    if (!m) return { valid: true, message: '有效工程，但无法解析 Unity 版本' };
    return { valid: true, version: m[1], message: '检测成功' };
  }

  /** 浅克隆 Git 仓库到临时目录并检测（用于项目添加时的校验） */
  async inspectGitProject(gitUrl: string, branch?: string, projectPath?: string, submodules = false): Promise<{ valid: boolean; version?: string; message?: string }> {
    const dir = fs.mkdtempSync(path.join(tmpDir(), 'inspect-'));
    try {
      const args = ['--depth', '1', '--single-branch'];
      if (branch) args.push('--branch', branch);
      await simpleGit().clone(gitUrl, dir, args);
      if (submodules) await simpleGit(dir).submoduleUpdate(['--init', '--recursive', '--depth', '1']);
      return this.inspectUnityProject(this.unityProjectDir(dir, projectPath));
    } catch (e: any) {
      return { valid: false, message: `Git 拉取失败: ${e.message}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  unityProjectDir(workspace: string, projectPath?: string): string {
    const relative = (projectPath ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!relative) return workspace;
    if (relative.split('/').includes('..')) throw new Error(`Unity 工程相对路径非法: ${projectPath}`);
    return path.join(workspace, ...relative.split('/'));
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * 为构建准备工作区。
   * reuseLibrary=true：长期工作区 data/workspaces/project-<id>，保留 Library。
   * reuseLibrary=false：每次 data/workspaces/build-<id>，结束后由执行器删除。
   */
  async prepareWorkspace(
    buildId: number,
    project: ProjectRow,
    buildTarget: string,
    log: (line: string) => void,
    opts?: { reuseLibrary?: boolean },
  ): Promise<{ workspace: string; commit?: string }> {
    if (opts?.reuseLibrary) return this.preparePersistent(project, buildTarget, log);
    return this.prepareEphemeral(buildId, project, log);
  }

  private async preparePersistent(project: ProjectRow, buildTarget: string, log: (line: string) => void): Promise<{ workspace: string; commit?: string }> {
    const ws = this.persistentWorkspace(project.id, buildTarget);
    const projectDir = this.unityProjectDir(ws, project.project_path);
    if (project.source_type === 'git') {
      return this.withLock(project.id, async () => {
        const cacheDir = path.join(reposDir(), project.id);
        await this.ensureRepoCache(project, cacheDir, log);
        const git = simpleGit(cacheDir);
        const branch = project.git_branch?.trim();
        log(`同步远端${branch ? `分支 ${branch}` : '更新'}...`);
        if (branch) await git.fetch('origin', [branch]);
        else await git.fetch('origin', ['--prune']);
        const ref = branch ? `origin/${branch}` : 'origin/HEAD';
        await this.ensureGitWorkspace(cacheDir, ws, ref, log);
        await this.finalizeGitCheckout(ws, project, log);
        const commit = await this.headCommit(ws);
        this.syncLibraryCache(projectDir, log);
        this.clearBuildTransient(projectDir);
        log(`工作区已就绪（复用 ${buildTarget} Library）: ${projectDir}`);
        if (commit) log(`提交 ${commit}`);
        return { workspace: projectDir, commit };
      });
    }

    const src = project.path;
    if (!src || !fs.existsSync(src)) throw new Error(`本地项目目录不存在: ${src}`);
    return this.withLock(project.id, async () => {
      log(`同步本地工程 ${src} -> ${ws}（保留 Library）`);
      this.mirrorLocalProject(src, ws);
      this.syncLibraryCache(projectDir, log);
      this.clearBuildTransient(projectDir);
      log('同步完成');
      return { workspace: projectDir };
    });
  }

  private async prepareEphemeral(buildId: number, project: ProjectRow, log: (line: string) => void): Promise<{ workspace: string; commit?: string }> {
    const ws = this.ephemeralWorkspace(buildId);
    fs.rmSync(ws, { recursive: true, force: true });

    if (project.source_type === 'git') {
      return this.withLock(project.id, async () => {
        const cacheDir = path.join(reposDir(), project.id);
        await this.ensureRepoCache(project, cacheDir, log);
        const git = simpleGit(cacheDir);
        const branch = project.git_branch?.trim();
        log(`同步远端${branch ? `分支 ${branch}` : '更新'}...`);
        if (branch) await git.fetch('origin', [branch]);
        else await git.fetch('origin', ['--prune']);
        const ref = branch ? `origin/${branch}` : 'origin/HEAD';
        await git.raw(['worktree', 'add', '--force', '--detach', ws, ref]);
        await this.finalizeGitCheckout(ws, project, log);
        const commit = await this.headCommit(ws);
        log(`已检出 ${ref}${commit ? ` (${commit})` : ''}（git worktree，共享对象库无完整复制）`);
        return { workspace: this.unityProjectDir(ws, project.project_path), commit };
      });
    }

    const src = project.path;
    if (!src || !fs.existsSync(src)) throw new Error(`本地项目目录不存在: ${src}`);
    log(`复制本地工程 ${src} -> ${ws}（排除 Library/Temp/Logs 等目录）`);
    fs.mkdirSync(ws, { recursive: true });
    this.copyProjectTree(src, ws);
    log('复制完成');
    return { workspace: this.unityProjectDir(ws, project.project_path) };
  }

  /** 构建结束后清理临时工作区（Git 项目移除 worktree）。不触碰 project-<id> 长期工作区。 */
  async cleanupWorkspace(buildId: number, project: ProjectRow): Promise<void> {
    const ws = this.ephemeralWorkspace(buildId);
    if (project.source_type === 'git') {
      const cacheDir = path.join(reposDir(), project.id);
      if (fs.existsSync(path.join(cacheDir, '.git'))) {
        await this.withLock(project.id, async () => {
          const git = simpleGit(cacheDir);
          await git.raw(['worktree', 'remove', '--force', ws]).catch(() => undefined);
          await git.raw(['worktree', 'prune']).catch(() => undefined);
        });
        return;
      }
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }

  /** 删除长期工作区中的 Unity 缓存目录（源码 checkout 保留）。guard 在锁内复查，避免与构建准备交错。 */
  async clearLibraryCache(projectId: string, guard?: () => void): Promise<void> {
    await this.withLock(projectId, async () => {
      guard?.();
      for (const ws of this.listPersistentWorkspaces(projectId)) {
        this.removeProtected(ws);
      }
    });
  }

  /** 删除项目时清掉仓库缓存与长期工作区 */
  async removeProjectData(projectId: string): Promise<void> {
    const cacheDir = path.join(reposDir(), projectId);
    const workspaces = this.listPersistentWorkspaces(projectId);
    if (fs.existsSync(path.join(cacheDir, '.git'))) {
      await this.withLock(projectId, async () => {
        const git = simpleGit(cacheDir);
        for (const ws of workspaces) {
          await git.raw(['worktree', 'remove', '--force', ws]).catch(() => undefined);
        }
        await git.raw(['worktree', 'prune']).catch(() => undefined);
      });
    }
    for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  private removeProtected(ws: string): void {
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (PROTECTED_SET.has(name)) {
          fs.rmSync(full, { recursive: true, force: true });
          continue;
        }
        if (name !== '.git') walk(full);
      }
    };
    walk(ws);
  }

  private async headCommit(workspace: string): Promise<string | undefined> {
    const sha = String(await simpleGit(workspace).revparse(['HEAD']).catch(() => '')).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  }

  private async ensureRepoCache(project: ProjectRow, cacheDir: string, log: (line: string) => void): Promise<void> {
    if (!project.git_url?.trim()) throw new Error('Git 项目缺少仓库地址');
    if (fs.existsSync(path.join(cacheDir, '.git'))) {
      const git = simpleGit(cacheDir);
      const origin = String((await git.remote(['get-url', 'origin']).catch(() => '')) ?? '').trim();
      if (this.normalizeGitUrl(origin) !== this.normalizeGitUrl(project.git_url ?? '')) {
        log(`仓库地址已变更，重建缓存: ${project.git_url}`);
        for (const ws of this.listPersistentWorkspaces(project.id)) {
          await git.raw(['worktree', 'remove', '--force', ws]).catch(() => undefined);
          fs.rmSync(ws, { recursive: true, force: true });
        }
        await git.raw(['worktree', 'prune']).catch(() => undefined);
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(path.join(cacheDir, '.git'))) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      log(`首次克隆仓库到缓存: ${project.git_url}`);
      try {
        await simpleGit().clone(project.git_url, cacheDir, ['--no-checkout']);
      } catch (e) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw e;
      }
    }
  }

  private async ensureGitWorkspace(cacheDir: string, ws: string, ref: string, log: (line: string) => void): Promise<void> {
    const git = simpleGit(cacheDir);
    if (await this.isRegisteredWorktree(git, ws) && fs.existsSync(ws)) {
      try {
        log(`复用工作区，检出 ${ref}`);
        const wt = simpleGit(ws);
        await wt.raw(['checkout', '--force', '--detach', ref]);
        await this.cleanWorktree(ws);
        return;
      } catch (e: any) {
        log(`复用工作区失败，将重建: ${e.message}`);
      }
    } else if (await this.isRegisteredWorktree(git, ws)) {
      await git.raw(['worktree', 'prune']).catch(() => undefined);
    }

    const holds = ['Library', 'HybridCLRData']
      .map((name) => ({ name, src: this.findProtected(ws, name) }))
      .filter((item): item is { name: string; src: string } => !!item.src);
    const holdRoot = holds.length ? fs.mkdtempSync(path.join(tmpDir(), 'keep-')) : undefined;
    for (const item of holds) {
      fs.renameSync(item.src, path.join(holdRoot!, item.name));
      log(`已暂存既有 ${item.name}，重建工作区后还原`);
    }
    try {
      await git.raw(['worktree', 'remove', '--force', ws]).catch(() => undefined);
      fs.rmSync(ws, { recursive: true, force: true });
      await git.raw(['worktree', 'add', '--force', '--detach', ws, ref]);
    } finally {
      if (holdRoot) {
        for (const item of holds) {
          const held = path.join(holdRoot, item.name);
          if (!fs.existsSync(held)) continue;
          fs.mkdirSync(path.dirname(item.src), { recursive: true });
          fs.rmSync(item.src, { recursive: true, force: true });
          fs.renameSync(held, item.src);
        }
        fs.rmSync(holdRoot, { recursive: true, force: true });
      }
    }
    log(`已检出 ${ref}（长期 worktree，保留 Library）`);
    await this.cleanWorktree(ws);
  }

  private async finalizeGitCheckout(workspace: string, project: ProjectRow, log: (line: string) => void): Promise<void> {
    const git = simpleGit(workspace);
    if (project.git_submodules) {
      log('更新子模块...');
      await git.submoduleUpdate(['--init', '--recursive']);
    }
    if (project.git_lfs) {
      log('拉取 Git LFS 文件...');
      await git.raw(['lfs', 'install', '--local']);
      await git.raw(['lfs', 'pull']);
    }
  }

  private findProtected(root: string, name: string): string | undefined {
    const walk = (dir: string): string | undefined => {
      if (!fs.existsSync(dir)) return undefined;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (entry === name) return full;
        if (entry !== '.git' && !PROTECTED_SET.has(entry)) {
          const found = walk(full);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(root);
  }

  /** git clean 的排除只匹配仓库根。Unity 工程可能在子目录，先挪走再还原。 */
  private async cleanWorktree(ws: string): Promise<void> {
    const holds: { src: string; hold: string }[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const src = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(src);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (PROTECTED_SET.has(name)) {
          const hold = fs.mkdtempSync(path.join(tmpDir(), 'keep-'));
          fs.renameSync(src, path.join(hold, name));
          holds.push({ src, hold: path.join(hold, name) });
          continue;
        }
        if (name !== '.git') walk(src);
      }
    };
    walk(ws);
    try {
      await simpleGit(ws).raw(['clean', '-fd']);
    } finally {
      for (const { src, hold } of holds) {
        fs.mkdirSync(path.dirname(src), { recursive: true });
        if (fs.existsSync(src)) fs.rmSync(src, { recursive: true, force: true });
        fs.renameSync(hold, src);
        fs.rmSync(path.dirname(hold), { recursive: true, force: true });
      }
    }
  }

  private async isRegisteredWorktree(git: ReturnType<typeof simpleGit>, ws: string): Promise<boolean> {
    const out = await git.raw(['worktree', 'list', '--porcelain']).catch(() => '');
    for (const line of String(out).split(/\r?\n/)) {
      if (!line.startsWith('worktree ')) continue;
      if (this.samePath(line.slice('worktree '.length).trim(), ws)) return true;
    }
    return false;
  }

  private samePath(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  private normalizeGitUrl(url: string): string {
    return url.trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  }

  private copyProjectTree(src: string, dest: string): void {
    fs.cpSync(src, dest, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source, destination) => {
        const base = path.basename(source);
        if (LOCAL_EXCLUDES.has(base)) {
          const rel = path.relative(src, source);
          if (!rel.includes(path.sep)) return false;
        }
        try {
          const s = fs.statSync(source);
          if (s.isFile() && destination && fs.existsSync(destination)) {
            const d = fs.statSync(destination);
            if (d.isFile() && d.size === s.size && d.mtimeMs === s.mtimeMs) return false;
          }
        } catch {
          // 无法比较则继续复制
        }
        return true;
      },
    });
  }

  /** 把本地工程增量同步到长期工作区：不覆盖 / 不删除 Library 等缓存目录 */
  private mirrorLocalProject(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    this.copyProjectTree(src, dest);
    this.pruneDest(src, dest);
  }

  private pruneDest(src: string, dest: string): void {
    const walk = (rel: string) => {
      const destDir = rel ? path.join(dest, rel) : dest;
      if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) return;
      for (const name of fs.readdirSync(destDir)) {
        if (!rel && PROTECTED_SET.has(name)) continue;
        const childRel = rel ? path.join(rel, name) : name;
        const destPath = path.join(dest, childRel);
        const srcPath = path.join(src, childRel);
        if (!fs.existsSync(srcPath)) {
          fs.rmSync(destPath, { recursive: true, force: true });
          continue;
        }
        try {
          if (fs.statSync(destPath).isDirectory() && fs.statSync(srcPath).isDirectory()) walk(childRel);
        } catch {
          // 竞态或无权限时跳过
        }
      }
    };
    walk('');
  }

  /** Library 按 Unity 版本和工程依赖哈希隔离；依赖变化时弃用旧缓存，而不是继续复用。 */
  private syncLibraryCache(projectDir: string, log: (line: string) => void): void {
    const key = this.libraryCacheKey(projectDir);
    const libraryDir = path.join(projectDir, 'Library');
    const marker = path.join(libraryDir, '.ucl-cache-key');
    if (fs.existsSync(libraryDir)) {
      const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
      if (current === key) return;
      fs.rmSync(libraryDir, { recursive: true, force: true });
      log(`工程依赖或 Unity 版本已变化，重建 Library 缓存: ${key.slice(0, 12)}`);
    }
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(marker, key, 'utf8');
  }

  private libraryCacheKey(projectDir: string): string {
    const hash = createHash('sha256');
    const versionFile = path.join(projectDir, 'ProjectSettings', 'ProjectVersion.txt');
    hash.update(fs.existsSync(versionFile) ? fs.readFileSync(versionFile) : 'missing-project-version');
    for (const relative of ['Packages/manifest.json', 'Packages/packages-lock.json', 'ProjectSettings/ProjectSettings.asset']) {
      const file = path.join(projectDir, ...relative.split('/'));
      hash.update(`\n${relative}\n`);
      hash.update(fs.existsSync(file) ? fs.readFileSync(file) : 'missing');
    }
    return hash.digest('hex');
  }

  private clearBuildTransient(ws: string): void {
    fs.rmSync(path.join(ws, 'ucl-output'), { recursive: true, force: true });
    fs.rmSync(path.join(ws, 'Temp'), { recursive: true, force: true });
  }
}
