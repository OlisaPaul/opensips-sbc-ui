import { Module } from '@nestjs/common';
import { CredentialService } from './credential.service';
import { TrunkPlannerService } from './trunk-planner.service';
import { TrunksController } from './trunks.controller';
import { TrunksService } from './trunks.service';

@Module({
  controllers: [TrunksController],
  providers: [CredentialService, TrunkPlannerService, TrunksService],
})
export class TrunksModule {}
