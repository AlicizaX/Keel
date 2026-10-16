import { BadRequestException, Body, Controller, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EngineService } from './engine.service';
import { BuildParam } from '../common/types';

/**
 * 构建触发链接：POST /api/hooks/trigger/<token>
 * 免 API Token（链接中的 token 即凭证）。支持三种参数方式：
 *   1. query:  ?params=K=V,K2=V2 或任意 ?K=V
 *   2. JSON:   {"params":[{"key":"K","value":"V"}]} 或直接 {"K":"V"}
 *   3. 钉钉 outgoing 机器人消息：自动解析 text.content 中的 K=V，并按钉钉格式回包
 */
@Controller('hooks')
export class HooksController {
  constructor(
    private db: DatabaseService,
    private engine: EngineService,
  ) {}

  @Post('trigger/:token')
  trigger(@Param('token') token: string, @Query() query: Record<string, any>, @Body() body: any) {
    const config = this.db.db.prepare('SELECT * FROM build_configs WHERE trigger_token = ?').get(token) as any;
    if (!config) throw new NotFoundException('触发链接无效或已重置');

    const params: BuildParam[] = [];
    let dingtalk = false;

    // 钉钉 outgoing 机器人消息体
    const content: unknown = body?.text?.content;
    if (typeof content === 'string') {
      dingtalk = true;
      for (const word of content.trim().split(/\s+/)) {
        const m = word.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
        if (m) params.push({ key: m[1], value: m[2] });
      }
    }

    // JSON body
    if (Array.isArray(body?.params)) {
      for (const p of body.params) if (p?.key) params.push({ key: String(p.key), value: String(p.value ?? '') });
    } else if (body && typeof body === 'object' && !body.msgtype && !body.text) {
      for (const [k, v] of Object.entries(body)) {
        if (v == null || typeof v === 'object') continue;
        params.push({ key: k, value: String(v) });
      }
    }

    // query
    if (typeof query?.params === 'string') {
      for (const pair of query.params.split(',')) {
        const m = pair.match(/^([^=]+)=(.*)$/);
        if (m) params.push({ key: m[1].trim(), value: m[2] });
      }
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (k !== 'params' && typeof v === 'string') params.push({ key: k, value: v });
    }

    try {
      const build: any = this.engine.enqueue(config.id, params);
      if (dingtalk) {
        const suffix = params.length ? `，参数 ${params.map((p) => `${p.key}=${p.value}`).join(' ')}` : '';
        return { msgtype: 'text', text: { content: `已触发构建 #${build.id}（${config.name}）${suffix}` } };
      }
      return { ok: true, build };
    } catch (e: any) {
      if (dingtalk) return { msgtype: 'text', text: { content: `触发失败: ${e.message}` } };
      throw new BadRequestException(e.message);
    }
  }
}
