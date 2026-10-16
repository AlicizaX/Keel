import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { ScmModule } from '../scm/scm.module';
import { BuildsController } from './builds.controller';

@Module({
  imports: [EngineModule, ScmModule],
  controllers: [BuildsController],
})
export class BuildsModule {}
