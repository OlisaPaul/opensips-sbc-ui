import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MiModule } from '../mi/mi.module';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

@Module({
  imports: [AuditModule, MiModule],
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class RoutingModule {}
