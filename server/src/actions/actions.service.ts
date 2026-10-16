import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { ActionConfig } from '../common/types';
import { ScriptRunner } from '../engine/script-runner';

export interface ActionContext {
  build: any;
  config: any;
  project: any;
  status: 'success' | 'failed' | 'canceled';
  artifactDir?: string;
  error?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

@Injectable()
export class ActionsService {
  constructor(private scripts: ScriptRunner) {}

  /** 按 on 条件依次执行后置动作，单个失败不影响其他动作与构建结果 */
  async run(actions: ActionConfig[] | undefined, ctx: ActionContext, log: (l: string) => void) {
    if (!actions?.length) return;
    for (const action of actions) {
      const match = action.on === 'always' || (action.on === 'success' && ctx.status === 'success') || (action.on === 'failure' && ctx.status !== 'success');
      if (!match) continue;
      log(`执行动作 [${action.name || action.type}]`);
      try {
        await this.execute(action, ctx, log);
        log(`动作 [${action.name || action.type}] 完成`);
      } catch (e: any) {
        log(`动作 [${action.name || action.type}] 失败: ${e.message}`);
      }
    }
  }

  private async execute(action: ActionConfig, ctx: ActionContext, log: (l: string) => void) {
    const c = action.config ?? {};
    switch (action.type) {
      case 'webhook':
        return this.webhook(c, ctx);
      case 'dingtalk':
        return this.dingtalk(c, ctx);
      case 'feishu':
        return this.feishu(c, ctx);
      case 'script':
        return this.scripts.run(`action:${action.name || 'script'}`, { enabled: true, type: c.scriptType ?? 'shell', script: c.script ?? '' }, {
          cwd: ctx.cwd,
          env: ctx.env,
          log,
          timeoutSec: Number(c.timeout) || 600,
        });
      default:
        throw new Error(`未知动作类型: ${action.type}`);
    }
  }

  private summaryText(ctx: ActionContext): string {
    const statusText = ctx.status === 'success' ? '构建成功' : ctx.status === 'failed' ? '构建失败' : '已取消';
    const lines = [
      `项目: ${ctx.project?.name}`,
      `配置: ${ctx.config?.name}`,
      `任务: #${ctx.build?.id}`,
      `平台: ${ctx.config?.build_target}`,
      `结果: ${statusText}`,
    ];
    if (ctx.error) lines.push(`错误: ${ctx.error}`);
    return lines.join('\n');
  }

  private async webhook(c: any, ctx: ActionContext) {
    if (!c.url) throw new Error('Webhook 缺少 url');
    const res = await fetch(c.url, {
      method: c.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.headers ?? {}) },
      body: JSON.stringify({
        event: 'build.finished',
        status: ctx.status,
        build: ctx.build,
        config: { id: ctx.config?.id, name: ctx.config?.name, build_target: ctx.config?.build_target },
        project: { id: ctx.project?.id, name: ctx.project?.name },
        error: ctx.error ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Webhook 返回 HTTP ${res.status}`);
  }

  private async dingtalk(c: any, ctx: ActionContext) {
    if (!c.token) throw new Error('钉钉机器人缺少 access_token');
    let url = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(c.token)}`;
    if (c.secret) {
      const ts = Date.now().toString();
      const sign = encodeURIComponent(createHmac('sha256', c.secret).update(`${ts}\n${c.secret}`).digest('base64'));
      url += `&timestamp=${ts}&sign=${sign}`;
    }
    const statusText = ctx.status === 'success' ? '构建成功' : '构建失败';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: `Unity ${statusText} #${ctx.build?.id}`, text: `### Unity ${statusText}\n\n${this.summaryText(ctx).replace(/\n/g, '  \n')}` },
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.errcode) throw new Error(`钉钉返回错误: ${data.errmsg ?? res.status}`);
  }

  private async feishu(c: any, ctx: ActionContext) {
    if (!c.token) throw new Error('飞书机器人缺少 token');
    const url = c.token.startsWith('http') ? c.token : `https://open.feishu.cn/open-apis/bot/v2/hook/${encodeURIComponent(c.token)}`;
    const body: any = {
      msg_type: 'text',
      content: { text: this.summaryText(ctx) },
    };
    if (c.secret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      body.timestamp = ts;
      body.sign = createHmac('sha256', `${ts}\n${c.secret}`).update('').digest('base64');
    }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(`飞书返回错误: ${data.msg ?? res.status}`);
  }
}
