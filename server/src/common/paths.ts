import * as path from 'path';
import * as fs from 'fs';

/** server 包根目录（dev: src/common -> ../.. ，prod: dist/common -> ../..） */
export const serverRoot = path.resolve(__dirname, '..', '..');

function ensure(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataDir(): string {
  const dir = process.env.UCL_DATA_DIR
    ? path.resolve(process.env.UCL_DATA_DIR)
    : path.join(serverRoot, 'data');
  return ensure(dir);
}

export const workspacesDir = () => ensure(path.join(dataDir(), 'workspaces'));
export const artifactsDir = () => ensure(path.join(dataDir(), 'artifacts'));
export const logsDir = () => ensure(path.join(dataDir(), 'logs'));
export const unityInstallDir = () => ensure(path.join(dataDir(), 'unity'));
export const tmpDir = () => ensure(path.join(dataDir(), 'tmp'));
export const reposDir = () => ensure(path.join(dataDir(), 'repos'));
