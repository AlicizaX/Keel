import { Module } from '@nestjs/common';
import { ScmService } from './scm.service';

@Module({
  providers: [ScmService],
  exports: [ScmService],
})
export class ScmModule {}
