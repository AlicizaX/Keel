import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException,
  Param, ParseIntPipe, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { DatabaseService } from '../db/database.service';
import { AgentRegistry } from '../agent-registry/agent-registry.service';
import { artifactsDir } from '../common/paths';

@Controller('agents')
export class AgentsController {
  constructor(
    private db: DatabaseService,
    private registry: AgentRegistry,
  ) {}

  @Get()
  list() {
    const rows = this.db.db.prepare('SELECT id, name, platform, version, created_at, last_seen_at FROM agents ORDER BY created_at DESC').all() as any[];
    return rows.map((r) => {
      const online = this.registry.get(r.id);
      return { ...r, online: !!online, busy: online?.busy ?? false };
    });
  }

  /** 创建 Agent，token 仅在响应中返回一次 */
  @Post()
  create(@Body() body: { name: string }) {
    if (!body?.name?.trim()) throw new BadRequestException('请提供 Agent 名称');
    const id = randomUUID();
    const token = randomBytes(24).toString('hex');
    this.db.db
      .prepare('INSERT INTO agents(id, name, token, created_at) VALUES(?,?,?,?)')
      .run(id, body.name.trim(), token, this.db.now());
    return { id, token, name: body.name.trim() };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    const row = this.db.db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!row) throw new NotFoundException('Agent 不存在');
    const online = this.registry.unregister(id);
    online?.socket.disconnect(true);
    this.db.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return { ok: true };
  }

  /** Agent 产物回传（tar.gz 流），x-agent-token 鉴权 */
  @Post('artifacts/:buildId')
  async uploadArtifact(
    @Param('buildId', ParseIntPipe) buildId: number,
    @Req() req: Request,
  ) {
    const token = req.headers['x-agent-token'] as string | undefined;
    const agent = token ? (this.db.db.prepare('SELECT * FROM agents WHERE token = ?').get(token) as any) : null;
    if (!agent) throw new UnauthorizedException('Agent 凭证无效');

    const build = this.db.db.prepare('SELECT * FROM builds WHERE id = ?').get(buildId) as any;
    if (!build) throw new NotFoundException('构建不存在');
    if (build.runner !== agent.id) throw new ForbiddenException('该构建不属于此 Agent');

    const tgz = path.join(artifactsDir(), `build-${buildId}.tar.gz`);
    await pipeline(req, fs.createWriteStream(tgz));

    const dest = path.join(artifactsDir(), `build-${buildId}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('tar', ['-xzf', tgz, '-C', dest], { stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`产物解压失败，退出码 ${code}`))));
      p.on('error', reject);
    });
    fs.rmSync(tgz, { force: true });

    let size = 0;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else size += fs.statSync(p).size;
      }
    };
    walk(dest);

    this.db.db.prepare('DELETE FROM artifacts WHERE build_id = ?').run(buildId);
    this.db.db
      .prepare('INSERT INTO artifacts(build_id, path, size, cleaned, created_at) VALUES(?,?,?,0,?)')
      .run(buildId, dest, size, this.db.now());
    this.db.db.prepare('UPDATE builds SET artifact_dir = ? WHERE id = ?').run(dest, buildId);
    return { ok: true, size };
  }
}
