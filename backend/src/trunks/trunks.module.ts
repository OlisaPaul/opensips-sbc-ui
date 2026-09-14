import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MiModule } from '../mi/mi.module';
import { CredentialService } from './credential.service';
import { TrunkPlannerService } from './trunk-planner.service';
import { TrunksController } from './trunks.controller';
import { TrunksService } from './trunks.service';

@Module({
  imports: [AuditModule, MiModule],
  controllers: [TrunksController],
  providers: [CredentialService, TrunkPlannerService, TrunksService],
})
export class TrunksModule {}
