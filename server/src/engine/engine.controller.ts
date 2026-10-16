import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { EngineService } from './engine.service';
import { BuildParam } from '../common/types';

@Controller('engine')
export class EngineController {
  constructor(private engine: EngineService) {}

  @Get('queue')
  queue() {
    return this.engine.queueSnapshot();
  }

  @Post('configs/:id/build')
  build(@Param('id') id: string, @Body() body: { params?: BuildParam[] }) {
    return this.engine.enqueue(id, body?.params ?? []);
  }

  @Post('builds/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.engine.cancel(id);
  }
}
