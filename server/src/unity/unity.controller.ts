import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { UnityService } from './unity.service';

@Controller('unity')
export class UnityController {
  constructor(private unity: UnityService) {}

  @Get('installations')
  list() {
    return this.unity.list();
  }

  @Post('installations')
  add(@Body() body: { path: string }) {
    return this.unity.addInstalled(body?.path);
  }

  @Delete('installations/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    this.unity.remove(id);
    return { ok: true };
  }

  @Get('releases')
  releases(@Query('version') version?: string) {
    return this.unity.searchReleases(version ?? '');
  }

  @Post('download')
  download(@Body() body: { version: string; modules?: string[] }) {
    if (!body?.version?.trim()) throw new BadRequestException('请提供版本号');
    return this.unity.downloadLinux(body.version.trim(), body.modules ?? []);
  }
}
