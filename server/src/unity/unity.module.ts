import { Module } from '@nestjs/common';
import { UnityService } from './unity.service';
import { UnityController } from './unity.controller';

@Module({
  providers: [UnityService],
  controllers: [UnityController],
  exports: [UnityService],
})
export class UnityModule {}
