import { BadRequestException, Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { DatabaseService } from '../db/database.service';
import { SettingsService } from '../settings/settings.service';
import { tmpDir, unityInstallDir } from '../common/paths';
import { BuildPlatform } from '../common/types';

interface Installation {
  version: string;
  path: string;
  source: string;
  platform: string;
}

/** 目标平台 -> PlaybackEngine 目录名（位于 Editor/Data/PlaybackEngines 下） */
const ENGINE_DIR: Record<BuildPlatform, string> = {
  Windows: 'WindowsStandaloneSupport',
  macOS: 'MacStandaloneSupport',
  Linux: 'LinuxStandaloneSupport',
  Android: 'AndroidPlayer',
  iOS: 'iOSSupport',
  WebGL: 'WebGLSupport',
};

/** 常见构建模块（下载时按需勾选） */
export const KNOWN_MODULES = [
  { id: 'windows-mono', name: 'Windows 构建支持 (Mono)' },
  { id: 'windows-il2cpp', name: 'Windows 构建支持 (IL2CPP)' },
  { id: 'mac-mono', name: 'macOS 构建支持 (Mono)' },
  { id: 'mac-il2cpp', name: 'macOS 构建支持 (IL2CPP)' },
  { id: 'linux-mono', name: 'Linux 构建支持 (Mono)' },
  { id: 'linux-il2cpp', name: 'Linux 构建支持 (IL2CPP)' },
  { id: 'android', name: 'Android 构建支持' },
  { id: 'android-sdk-ndk-tools', name: 'Android SDK & NDK Tools' },
  { id: 'openjdk', name: 'OpenJDK' },
  { id: 'ios', name: 'iOS 构建支持' },
  { id: 'webgl', name: 'WebGL 构建支持' },
  { id: 'documentation', name: '离线文档' },
  { id: 'language-zh-hans', name: '简体中文语言包' },
];

@Injectable()
export class UnityService {
  constructor(
    private db: DatabaseService,
    private settings: SettingsService,
  ) {}

  list(): Installation[] {
    return this.db.db.prepare('SELECT * FROM unity_installations ORDER BY version DESC').all() as Installation[];
  }

  /** 编辑器可执行文件相对路径 */
  private editorBin(dir: string): string {
    if (process.platform === 'win32') return path.join(dir, 'Editor', 'Unity.exe');
    if (process.platform === 'darwin') return path.join(dir, 'Unity.app', 'Contents', 'MacOS', 'Unity');
    return path.join(dir, 'Editor', 'Unity');
  }

  /** PlaybackEngines / il2cpp 所在的基础目录（win/linux: Editor/Data，macOS: Unity.app/Contents） */
  private playbackBase(editorPath: string): string {
    if (process.platform === 'darwin') {
      // .../Unity.app/Contents/MacOS/Unity -> .../Unity.app/Contents
      return path.resolve(path.dirname(editorPath), '..');
    }
    return path.join(path.dirname(editorPath), 'Data');
  }

  /**
   * 构建前校验：目标平台的 Build Support 模块（及 IL2CPP 支持）是否已安装。
   * 缺失时抛出明确错误，避免 Unity 构建到一半才失败。
   */
  verifyBuildSupport(editorPath: string, target: BuildPlatform, il2cpp: boolean): void {
    const base = this.playbackBase(editorPath);
    const missing: string[] = [];
    const engine = ENGINE_DIR[target];
    if (engine && !fs.existsSync(path.join(base, 'PlaybackEngines', engine))) {
      missing.push(`${engine}（${target} 平台构建支持）`);
    }
    if (il2cpp && !fs.existsSync(path.join(base, 'il2cpp'))) {
      missing.push('IL2CPP 构建支持');
    }
    if (missing.length) {
      throw new Error(
        `当前 Unity 缺少构建模块: ${missing.join('、')}。\n` +
          (process.platform === 'linux'
            ? `请在「设置 → Unity 安装」中搜索该版本并勾选对应模块下载补充，或通过 Unity Hub 安装。`
            : `请在 Unity Hub 为该版本安装对应 Build Support 模块。`),
      );
    }
  }

  /** 本机 Unity Hub 的 Editor 约定目录 */
  private hubEditorDir(): string | null {
    if (process.platform === 'win32') return path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Unity', 'Hub', 'Editor');
    if (process.platform === 'darwin') return '/Applications/Unity/Hub/Editor';
    return path.join(process.env.HOME ?? '/root', 'Unity', 'Hub', 'Editor');
  }

  /**
   * 下载安装根目录：优先用户设置；留空则自动检测本机目录
   * （Hub Editor 目录存在则用之，否则回退到工具数据目录），三平台通用。
   */
  installRoot(): string {
    const custom = this.settings.get('unity_install_root', '').trim();
    if (custom) {
      fs.mkdirSync(custom, { recursive: true });
      return custom;
    }
    const hub = this.hubEditorDir();
    if (hub && fs.existsSync(hub)) return hub;
    return unityInstallDir();
  }

  /** 登记一个已安装的 Unity。只接受用户给出的单个目录，不扫描 Hub 或其他目录。 */
  addInstalled(dir: string): Installation {
    const input = dir?.trim();
    if (!input) throw new BadRequestException('请填写 Unity 安装目录');
    const editor = this.normalizeEditorPath(input);
    if (!editor) throw new BadRequestException(`不是有效的 Unity 安装: ${input}`);
    const version = this.editorVersion(input, editor);
    this.db.db
      .prepare(
        `INSERT INTO unity_installations(version, path, source, platform, created_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET version=excluded.version, source=excluded.source`,
      )
      .run(version, input, 'installed', process.platform, this.db.now());
    return this.list().find((r) => this.samePath(r.path, input))!;
  }

  remove(id: number): void {
    const row = this.db.db.prepare('SELECT * FROM unity_installations WHERE id = ?').get(id) as any;
    if (!row) throw new BadRequestException('Unity 安装记录不存在');
    this.db.db.prepare('DELETE FROM unity_installations WHERE id = ?').run(id);
  }

  private editorVersion(input: string, editor: string): string {
    const trimmed = input.replace(/[\\/]+$/, '');
    for (const name of [path.basename(trimmed), path.basename(path.dirname(trimmed))]) {
      if (/^\d+\.\d+\.\d+/.test(name)) return name;
    }
    const installRoot = path.basename(path.dirname(editor)) === 'Editor' ? path.dirname(path.dirname(editor)) : path.dirname(editor);
    const info = path.join(installRoot, 'modules.json');
    if (fs.existsSync(info)) {
      const version = JSON.parse(fs.readFileSync(info, 'utf8'))?.unityVersion;
      if (typeof version === 'string' && version) return version;
    }
    throw new BadRequestException(`无法从目录识别 Unity 版本: ${input}。请指向版本目录，例如 D:\\Unity\\2022.3.7f1`);
  }

  private samePath(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  }

  /**
   * 解析某次构建要使用的编辑器路径。
   * 优先自定义路径 -> 精确版本 -> 宿主扫描；Linux 下允许自动下载。
   */
  /** 将用户填写的路径规范化为编辑器可执行文件：支持 exe 完整路径 / 安装根目录 / Editor 子目录 */
  private normalizeEditorPath(p: string): string | null {
    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).isFile()) return p;
    const exe = process.platform === 'win32' ? 'Unity.exe' : 'Unity';
    const candidates = [
      path.join(p, exe), // 形如 .../2022.3.7f1/Editor
      this.editorBin(p), // 形如 .../2022.3.7f1（安装根目录）
    ];
    if (process.platform === 'darwin') candidates.push(path.join(p, 'Contents', 'MacOS', 'Unity')); // Unity.app
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }

  async resolve(version: string | undefined, overridePath: string | undefined, log: (l: string) => void): Promise<string> {
    if (overridePath?.trim()) {
      const p = this.normalizeEditorPath(overridePath.trim());
      if (p) return p;
      throw new Error(`自定义 Unity 路径无效: ${overridePath}（请指向 Unity.exe 完整路径，或安装目录）`);
    }
    if (!version) throw new Error('未指定 Unity 版本，且项目未能识别出版本号');

    const hit = this.list().find((r) => r.version === version);
    if (hit) {
      const bin = this.normalizeEditorPath(hit.path);
      if (bin) return bin;
      throw new Error(`已登记的 Unity ${version} 不可用: ${hit.path}`);
    }

    throw new Error(
      `未找到 Unity ${version}。请在「设置 → Unity 安装」中添加该版本${process.platform === 'linux' ? '，或搜索并下载' : ''}。`,
    );
  }

  /** 搜索 Unity 发布版本（供设置页选择下载） */
  async searchReleases(query: string) {
    const api = `https://services.api.unity.com/unity/editor/release/v1/releases?version=${encodeURIComponent(query ?? '')}&limit=25&order=RELEASE_DATE_DESC`;
    const res = await fetch(api);
    if (!res.ok) throw new BadRequestException(`查询 Unity 发布信息失败: HTTP ${res.status}`);
    const data: any = await res.json();
    const releases: any[] = data.results ?? [];
    return releases.map((r) => {
      const available = new Set<string>((r.modules ?? []).map((m: any) => m.id));
      return {
        version: r.version as string,
        releaseDate: (r.releaseDate ?? '').slice(0, 10),
        stream: r.stream ?? '',
        modules: KNOWN_MODULES.map((m) => ({ ...m, available: available.size === 0 || available.has(m.id) })),
      };
    });
  }

  /** 查询指定版本的发布信息 */
  private async fetchRelease(version: string): Promise<any> {
    const api = `https://services.api.unity.com/unity/editor/release/v1/releases?version=${encodeURIComponent(version)}&limit=25&order=RELEASE_DATE_DESC`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`查询 Unity 发布信息失败: HTTP ${res.status}`);
    const data: any = await res.json();
    const releases: any[] = data.results ?? data.releases ?? [];
    const release = releases.find((r) => r.version === version) ?? releases[0];
    if (!release) throw new Error(`未找到 Unity ${version} 的发布信息`);
    return release;
  }

  /** 定位安装目录内 Editor/Unity 所在层级 */
  private locateEditorDir(dest: string): string | null {
    if (fs.existsSync(this.editorBin(dest))) return dest;
    if (!fs.existsSync(dest)) return null;
    for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(this.editorBin(path.join(dest, e.name)))) {
        return path.join(dest, e.name);
      }
    }
    return null;
  }

  /**
   * 下载并安装 Linux 版 Unity Editor（已安装则跳过编辑器本体），
   * 并按本次勾选的模块列表安装构建模块。返回安装目录。
   */
  async downloadLinux(version: string, modules: string[] = [], log: (l: string) => void = () => undefined): Promise<string> {
    if (process.platform !== 'linux') throw new BadRequestException('仅 Linux 环境支持下载 Unity');
    const dest = path.join(this.installRoot(), version);

    log(`查询 Unity ${version} 发布信息...`);
    const release = await this.fetchRelease(version);

    let finalDir = this.locateEditorDir(dest);
    if (finalDir) {
      log(`Unity ${version} 编辑器已存在，跳过本体下载`);
    } else {
      const download = release?.downloads?.find((d: any) => d.platform === 'LINUX_EDITOR');
      const url: string | undefined = download?.url ?? release?.downloadUrl;
      if (!url) throw new Error(`未找到 Unity ${version} 的 Linux 下载地址，请手动安装后在设置中登记路径`);

      log(`下载 ${url} -> ${dest}`);
      const pkg = path.join(tmpDir(), `unity-${version}.tar.xz`);
      try {
        const dl = await fetch(url);
        if (!dl.ok || !dl.body) throw new Error(`下载失败: HTTP ${dl.status}`);
        await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(pkg));
        log('下载完成，解压中...');

        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xf', pkg, '-C', dest], { stdio: 'inherit' });
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败，退出码 ${code}`))));
          p.on('error', reject);
        });
      } finally {
        // 下载缓存包无论成败都清理
        fs.rmSync(pkg, { force: true });
      }

      finalDir = this.locateEditorDir(dest);
      if (!finalDir) throw new Error('解压后未找到 Editor/Unity，安装包结构异常');
      fs.chmodSync(this.editorBin(finalDir), 0o755);
      log(`Unity ${version} 安装完成: ${finalDir}`);
    }

    // 安装本次勾选的构建模块
    if (modules.length) await this.installModules(finalDir, release, modules, log);

    // 入库（合并历史已装模块）
    const existing = this.db.db.prepare('SELECT modules FROM unity_installations WHERE path = ?').get(finalDir) as any;
    let merged: string[] = [];
    try {
      merged = JSON.parse(existing?.modules ?? '[]');
    } catch { /* 忽略 */ }
    merged = [...new Set([...merged, ...modules])];
    this.db.db
      .prepare(
        `INSERT INTO unity_installations(version, path, source, platform, modules, created_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET version=excluded.version, source=excluded.source, modules=excluded.modules`,
      )
      .run(version, finalDir, 'downloaded', 'linux', JSON.stringify(merged), this.db.now());

    return finalDir;
  }

  /** 从发布信息中解析并安装构建模块（模块包为 tar.xz，覆盖解压到编辑器目录） */
  private async installModules(editorDir: string, release: any, ids: string[], log: (l: string) => void): Promise<void> {
    const available: any[] = release?.modules ?? [];
    for (const id of ids) {
      const mod = available.find((m: any) => m.id === id);
      const url: string | undefined = mod?.url ?? mod?.downloadUrl;
      if (!url) {
        log(
          `模块 ${id} 未在发布信息中找到下载地址，请改用 Unity Hub 命令行安装: ` +
            `unity-hub --headless install-modules --version <版本> -m ${id}`,
        );
        continue;
      }
      const pkg = path.join(tmpDir(), `unity-module-${id}.tar.xz`);
      try {
        log(`下载构建模块 ${id}: ${mod?.name ?? ''}`);
        const dl = await fetch(url);
        if (!dl.ok || !dl.body) throw new Error(`HTTP ${dl.status}`);
        await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(pkg));
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xf', pkg, '-C', editorDir], { stdio: 'inherit' });
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压退出码 ${code}`))));
          p.on('error', reject);
        });
        log(`模块 ${id} 安装完成`);
      } catch (e: any) {
        log(`模块 ${id} 安装失败: ${e.message}，请通过 Unity Hub 手动安装`);
      } finally {
        fs.rmSync(pkg, { force: true });
      }
    }
  }
}
