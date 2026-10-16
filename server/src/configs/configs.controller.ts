import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ConfigsService } from './configs.service';

@Controller('configs')
export class ConfigsController {
  constructor(private configs: ConfigsService) {}

  @Get()
  list(@Query('projectId') projectId: string) {
    return this.configs.listByProject(projectId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.configs.get(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.configs.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.configs.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.configs.remove(id);
  }

  @Get(':id/trigger')
  getTrigger(@Param('id') id: string) {
    return { token: this.configs.getTriggerToken(id) };
  }

  @Post(':id/trigger')
  rotateTrigger(@Param('id') id: string) {
    return { token: this.configs.rotateTriggerToken(id) };
  }
}
