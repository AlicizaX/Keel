import { Injectable } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScriptConfig } from '../common/types';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  logRaw?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutSec?: number;
}

/** 跨平台结束进程树 */
export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

@Injectable()
export class ScriptRunner {
  /** 执行一段用户脚本（PowerShell / Shell / Python），非零退出即抛错 */
  async run(name: string, cfg: ScriptConfig, opts: RunOptions): Promise<void> {
    if (!cfg?.enabled || !cfg.script?.trim()) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucl-script-'));
    let file: string;
    let cmd: string;
    let args: string[];

    if (cfg.type === 'powershell') {
      file = path.join(dir, 'script.ps1');
      cmd = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
    } else if (cfg.type === 'python') {
      file = path.join(dir, 'script.py');
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      args = [file];
    } else {
      file = path.join(dir, 'script.sh');
      cmd = process.platform === 'win32' ? 'bash' : 'sh';
      args = [file];
    }

    fs.writeFileSync(file, cfg.script.replace(/\r\n/g, '\n'), 'utf8');
    opts.log(`[${name}] 开始执行 (${cfg.type})`);

    try {
      await this.spawn(name, cmd, args, opts);
      opts.log(`[${name}] 执行完成`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 通用子进程执行：流式输出日志、超时与取消支持 */
  spawn(name: string, cmd: string, args: string[], opts: RunOptions): Promise<void> {
    const timeoutSec = opts.timeoutSec ?? 1800;
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      let stderrTail = '';
      let settled = false;
      const emit = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (opts.logRaw) opts.logRaw(text);
        else for (const line of text.split(/\r?\n/)) if (line.trim()) opts.log(`[${name}] ${line}`);
      };
      child.stdout?.on('data', emit);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
        emit(chunk);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child);
        reject(new Error(`[${name}] 执行超时（${timeoutSec}s）`));
      }, timeoutSec * 1000);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child);
        reject(new Error('canceled'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[${name}] 无法启动 ${cmd}: ${err.message}`));
      });

      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`[${name}] 退出码 ${code}${stderrTail ? `，stderr: ${stderrTail.slice(-500)}` : ''}`));
      });
    });
  }
}
