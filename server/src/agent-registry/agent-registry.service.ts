import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';

export interface OnlineAgent {
  id: string;
  name: string;
  platform: string;
  busy: boolean;
  socket: Socket;
}

/** 在线 Agent 注册中心（内存态，DB 仅存凭证） */
@Injectable()
export class AgentRegistry {
  private agents = new Map<string, OnlineAgent>();

  /** Agent 空闲/上线时的回调（由 EngineService 挂接调度） */
  onIdle: () => void = () => undefined;

  register(agent: { id: string; name: string }, socket: Socket, platform: string, name?: string) {
    this.agents.set(agent.id, {
      id: agent.id,
      name: name || agent.name,
      platform,
      busy: false,
      socket,
    });
    this.onIdle();
  }

  unregister(id: string): OnlineAgent | undefined {
    const a = this.agents.get(id);
    this.agents.delete(id);
    return a;
  }

  get(id: string): OnlineAgent | undefined {
    return this.agents.get(id);
  }

  online(): OnlineAgent[] {
    return [...this.agents.values()];
  }

  setBusy(id: string, busy: boolean) {
    const a = this.agents.get(id);
    if (!a) return;
    a.busy = busy;
    if (!busy) this.onIdle();
  }

  assign(id: string, payload: any) {
    this.agents.get(id)?.socket.emit('build:assign', payload);
  }

  cancel(id: string, buildId: number) {
    this.agents.get(id)?.socket.emit('build:cancel', { buildId });
  }
}
