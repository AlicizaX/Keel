import { Module } from '@nestjs/common';
import { ActionsService } from './actions.service';
import { ScriptRunner } from '../engine/script-runner';

@Module({
  providers: [ActionsService, ScriptRunner],
  exports: [ActionsService, ScriptRunner],
})
export class ActionsModule {}
