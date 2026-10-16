import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { EventsGateway } from '../ws/events.gateway';

export const EXECUTOR_SINK = 'EXECUTOR_SINK';

/** 执行器状态/日志出口：控制器实现落库+广播，Agent 实现走 socket 上报 */
export interface ExecutorSink {
  applyState(build: any, patch: Record<string, any>): void;
  emitLog(buildId: number, chunk: string): void;
}

@Injectable()
export class ControllerExecutorSink implements ExecutorSink {
  constructor(
    private db: DatabaseService,
    private gateway: EventsGateway,
  ) {}

  applyState(build: any, patch: Record<string, any>): void {
    const keys = Object.keys(patch);
    if (keys.length) {
      this.db.db
        .prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), build.id);
    }
    Object.assign(build, patch);
    this.gateway.emitBuildUpdate({ ...build });
  }

  emitLog(buildId: number, chunk: string): void {
    this.gateway.emitBuildLog(buildId, chunk);
  }
}
