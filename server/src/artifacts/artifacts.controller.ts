import { Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import archiver from 'archiver';
import { ArtifactsService } from './artifacts.service';

@Controller('artifacts')
export class ArtifactsController {
  constructor(private artifacts: ArtifactsService) {}

  @Get()
  list() {
    return this.artifacts.list();
  }

  @Post('cleanup')
  cleanup() {
    return this.artifacts.cleanupExpired();
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.artifacts.cleanOne(id);
  }

  @Get(':id/download')
  async download(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const art = this.artifacts.get(id);
    if (!art || art.cleaned || !fs.existsSync(art.path)) throw new NotFoundException('产物不存在或已清理');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="build-${art.build_id}.zip"`);
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', () => res.end());
    archive.pipe(res);
    archive.directory(art.path, false);
    await archive.finalize();
  }
}
