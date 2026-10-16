import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Post()
  create(@Body() body: any) {
    return this.projects.create(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.projects.get(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.projects.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  @Post(':id/check')
  check(@Param('id') id: string) {
    return this.projects.check(id);
  }

  @Post(':id/clear-cache')
  clearCache(@Param('id') id: string) {
    return this.projects.clearCache(id);
  }
}
