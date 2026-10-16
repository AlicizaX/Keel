const BASE = '/api';

function token(): string {
  return localStorage.getItem('ucl_token') ?? '';
}

async function req<T = any>(method: string, url: string, body?: any): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { 'x-api-token': token() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(data.message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return null as T;
  return res.json();
}

export const api = {
  get: <T = any>(url: string) => req<T>('GET', url),
  post: <T = any>(url: string, body?: any) => req<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: any) => req<T>('PUT', url, body ?? {}),
  del: <T = any>(url: string) => req<T>('DELETE', url),
};

export function setToken(t: string) {
  if (t) localStorage.setItem('ucl_token', t);
  else localStorage.removeItem('ucl_token');
}

export const PHASE_LABELS: Record<string, string> = {
  prepare: '准备工作区',
  resolve: '解析 Unity',
  build: 'Unity 构建',
  collect: '产物归档',
  actions: '后置动作',
  done: '完成',
};

export const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '构建中',
  success: '成功',
  failed: '失败',
  canceled: '已取消',
};

export const STATUS_COLORS: Record<string, string> = {
  queued: 'yellow',
  running: 'blue',
  success: 'green',
  failed: 'red',
  canceled: 'gray',
};

export function fmtTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function fmtDuration(start?: string | null, end?: string | null): string {
  if (!start) return '-';
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtSize(bytes?: number | null): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
