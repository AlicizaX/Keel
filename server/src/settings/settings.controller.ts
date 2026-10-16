import { Body, Controller, Get, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.all();
  }

  @Put()
  update(@Body() body: Record<string, string>) {
    this.settings.updateMany(body ?? {});
    return this.settings.all();
  }
}
