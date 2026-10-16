import { Global, Module } from '@nestjs/common';
import { AgentRegistry } from './agent-registry.service';

@Global()
@Module({
  providers: [AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentRegistryModule {}
