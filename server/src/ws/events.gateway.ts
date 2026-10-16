import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  path: '/ws',
  cors: { origin: true },
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  /** 构建日志增量推送 */
  emitBuildLog(buildId: number, chunk: string) {
    this.server?.emit('build:log', { buildId, chunk });
  }

  /** 构建状态变化（行记录全量） */
  emitBuildUpdate(build: any) {
    this.server?.emit('build:update', build);
  }

  /** 队列快照 */
  emitQueue(queue: { queued: number[]; running: number[] }) {
    this.server?.emit('queue', queue);
  }
}
