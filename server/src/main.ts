import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { serverRoot } from './common/paths';
import { SettingsService } from './settings/settings.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.setGlobalPrefix('api');
  app.enableCors();
  app.use(express.json({ limit: '20mb' }));

  // 可选 API Token：仅保护写操作
  const settings = app.get(SettingsService);
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = settings.get('api_token', '');
    if (!token) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    // 触发链接自带 token 凭证，豁免 API Token
    if (req.path.startsWith('/api/hooks/')) return next();
    // Agent 产物回传使用 x-agent-token 鉴权
    if (req.path.startsWith('/api/agents/artifacts')) return next();
    if (req.headers['x-api-token'] === token) return next();
    res.status(401).json({ message: 'API Token 无效' });
  });

  // 生产模式：托管前端构建产物 + SPA 回退
  const webDist = path.resolve(serverRoot, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 7850);
  await app.listen(port, '0.0.0.0');
  console.log(`[ucl] 服务已启动: http://localhost:${port}`);
}

bootstrap();
