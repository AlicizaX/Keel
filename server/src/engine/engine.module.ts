import { Module } from '@nestjs/common';
import { ScmModule } from '../scm/scm.module';
import { UnityModule } from '../unity/unity.module';
import { ActionsModule } from '../actions/actions.module';
import { EngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { EngineController } from './engine.controller';
import { HooksController } from './hooks.controller';
import { EXECUTOR_SINK, ControllerExecutorSink } from './executor-sink';

@Module({
  imports: [ScmModule, UnityModule, ActionsModule],
  providers: [EngineService, ExecutorService, { provide: EXECUTOR_SINK, useClass: ControllerExecutorSink }],
  controllers: [EngineController, HooksController],
  exports: [EngineService],
})
export class EngineModule {}
