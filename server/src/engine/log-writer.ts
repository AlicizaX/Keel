import * as fs from 'fs';
import * as path from 'path';
import { logsDir } from '../common/paths';

/** 构建日志：写文件 + 回调（控制器为 WS 广播，Agent 为 socket 上报） */
export class LogWriter {
  readonly filePath: string;
  private stream: fs.WriteStream;

  constructor(
    private buildId: number,
    private onChunk: (buildId: number, chunk: string) => void,
  ) {
    this.filePath = path.join(logsDir(), `build-${buildId}.log`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  write(line: string) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.raw(`[${time}] ${line}\n`);
  }

  raw(chunk: string) {
    this.stream.write(chunk);
    this.onChunk(this.buildId, chunk);
  }

  close() {
    this.stream.end();
  }
}
