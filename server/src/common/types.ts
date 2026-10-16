export type BuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export type ScriptType = 'powershell' | 'shell' | 'python';

export interface ScriptConfig {
  enabled: boolean;
  type: ScriptType;
  script: string;
}

export interface ActionConfig {
  id: string;
  name: string;
  type: 'webhook' | 'dingtalk' | 'feishu' | 'script';
  on: 'success' | 'failure' | 'always';
  config: Record<string, any>;
}

export interface BuildParam {
  key: string;
  value: string;
}

export const BUILD_TARGETS = ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'WebGL'] as const;
export type BuildPlatform = (typeof BUILD_TARGETS)[number];

/** 前端平台 -> Unity BuildTarget 枚举名 */
export const UNITY_TARGET_MAP: Record<BuildPlatform, string> = {
  Windows: 'StandaloneWindows64',
  macOS: 'StandaloneOSX',
  Linux: 'StandaloneLinux64',
  Android: 'Android',
  iOS: 'iOS',
  WebGL: 'WebGL',
};

/** 各平台默认输出名（文件或目录） */
export const DEFAULT_OUTPUT: Record<BuildPlatform, string> = {
  Windows: 'App.exe',
  macOS: 'App.app',
  Linux: 'App.x86_64',
  Android: 'app.apk',
  iOS: 'ios-xcode',
  WebGL: 'webgl',
};

export const PHASE_LABELS: Record<string, string> = {
  prepare: '准备工作区',
  resolve: '解析 Unity 编辑器',
  build: 'Unity 构建',
  collect: '产物归档',
  actions: '后置动作',
  done: '完成',
};

export function defaultScript(type?: ScriptType): ScriptConfig {
  return {
    enabled: false,
    type: type ?? (process.platform === 'win32' ? 'powershell' : 'shell'),
    script: '',
  };
}
