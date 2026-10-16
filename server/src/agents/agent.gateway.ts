import { OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../db/database.service';
import { EventsGateway } from '../ws/events.gateway';
import { AgentRegistry } from '../agent-registry/agent-registry.service';
import { EngineService } from '../engine/engine.service';
import { logsDir } from '../common/paths';

/** Agent 专用通道：注册、日志回流、状态回流 */
@WebSocketGateway({ namespace: '/agent', path: '/ws', cors: { origin: true } })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private logStreams = new Map<number, fs.WriteStream>();

  constructor(
    private db: DatabaseService,
    private registry: AgentRegistry,
    private events: EventsGateway,
    private engine: EngineService,
  ) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    const agent = token
      ? (this.db.db.prepare('SELECT * FROM agents WHERE token = ?').get(token) as any)
      : null;
    if (!agent) {
      client.disconnect(true);
      return;
    }
    (client as any).agentId = agent.id;
    const { platform, name } = client.handshake.auth as any;
    this.registry.register(agent, client, platform ?? '', name);
  }

  handleDisconnect(client: Socket) {
    const agentId = (client as any).agentId as string | undefined;
    if (!agentId) return;
    const was = this.registry.unregister(agentId);
    if (was?.busy) {
      // Agent 断线：其正在执行的构建标记失败
      const rows = this.db.db
        .prepare("SELECT id FROM builds WHERE runner = ? AND status = 'running'")
        .all(agentId) as any[];
      for (const b of rows) {
        this.engine.applyAgentUpdate(b.id, {
          status: 'failed',
          error: 'Agent 连接中断',
          phase: 'done',
          finished_at: this.db.now(),
        });
      }
    }
  }

  @SubscribeMessage('agent:hello')
  hello(client: Socket, payload: { name?: string; platform?: string; version?: string }) {
    const agentId = (client as any).agentId;
    if (!agentId) return;
    this.db.db
      .prepare('UPDATE agents SET platform = ?, version = ?, last_seen_at = ? WHERE id = ?')
      .run(payload?.platform ?? null, payload?.version ?? null, this.db.now(), agentId);
  }

  @SubscribeMessage('build:log')
  log(_client: Socket, msg: { buildId: number; chunk: string }) {
    if (!msg?.buildId || typeof msg.chunk !== 'string') return;
    let stream = this.logStreams.get(msg.buildId);
    if (!stream) {
      stream = fs.createWriteStream(path.join(logsDir(), `build-${msg.buildId}.log`), { flags: 'a' });
      this.logStreams.set(msg.buildId, stream);
    }
    stream.write(msg.chunk);
    this.events.emitBuildLog(msg.buildId, msg.chunk);
  }

  @SubscribeMessage('build:update')
  update(_client: Socket, msg: { buildId: number; patch: Record<string, any> }) {
    if (!msg?.buildId || !msg.patch) return;
    this.engine.applyAgentUpdate(msg.buildId, msg.patch);
    const status = msg.patch.status;
    if (status === 'success' || status === 'failed' || status === 'canceled') {
      this.logStreams.get(msg.buildId)?.end();
      this.logStreams.delete(msg.buildId);
    }
  }
}
