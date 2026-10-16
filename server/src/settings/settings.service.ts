import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

export const DEFAULT_SETTINGS: Record<string, string> = {
  concurrency: '1',
  script_timeout: '1800',
  keep_failed_workspace: 'false',
  reuse_unity_library: 'true',
  unity_install_root: '',
  license_username: '',
  license_password: '',
  license_serial: '',
  license_ulf_path: '',
  api_token: '',
};

@Injectable()
export class SettingsService {
  constructor(private db: DatabaseService) {}

  get(key: string, fallback = ''): string {
    const row = this.db.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    if (row?.value != null) return row.value;
    return DEFAULT_SETTINGS[key] ?? fallback;
  }

  getNumber(key: string, fallback: number): number {
    const v = Number(this.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  getBool(key: string, fallback = false): boolean {
    const v = this.get(key);
    if (v === '') return fallback;
    return v === 'true' || v === '1';
  }

  getJson<T>(key: string, fallback: T): T {
    try {
      const v = this.get(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: string) {
    this.db.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value ?? '');
  }

  all(): Record<string, string> {
    const rows = this.db.db.prepare('SELECT key, value FROM settings').all() as any[];
    const result: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const r of rows) result[r.key] = r.value;
    // 敏感字段不下发明文
    if (result.license_password) result.license_password = '******';
    return result;
  }

  updateMany(patch: Record<string, string>) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'license_password' && v === '******') continue;
      if (k in DEFAULT_SETTINGS) this.set(k, String(v ?? ''));
    }
  }
}
