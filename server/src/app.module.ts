import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DbModule } from './db/database.module';
import { WsModule } from './ws/ws.module';
import { SettingsModule } from './settings/settings.module';
import { AgentRegistryModule } from './agent-registry/agent-registry.module';
import { AgentsModule } from './agents/agents.module';
import { ScmModule } from './scm/scm.module';
import { ProjectsModule } from './projects/projects.module';
import { UnityModule } from './unity/unity.module';
import { ConfigsModule } from './configs/configs.module';
import { ActionsModule } from './actions/actions.module';
import { EngineModule } from './engine/engine.module';
import { BuildsModule } from './builds/builds.module';
import { ArtifactsModule } from './artifacts/artifacts.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DbModule,
    WsModule,
    SettingsModule,
    AgentRegistryModule,
    AgentsModule,
    ScmModule,
    ProjectsModule,
    UnityModule,
    ConfigsModule,
    ActionsModule,
    EngineModule,
    BuildsModule,
    ArtifactsModule,
  ],
})
export class AppModule {}
