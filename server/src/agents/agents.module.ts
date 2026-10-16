import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { AgentsController } from './agents.controller';
import { AgentGateway } from './agent.gateway';

@Module({
  imports: [EngineModule],
  controllers: [AgentsController],
  providers: [AgentGateway],
})
export class AgentsModule {}
