import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { DatabaseModule } from './database/database.module';
import { MiModule } from './mi/mi.module';
import { TrunksModule } from './trunks/trunks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    MiModule,
    AuditModule,
    TrunksModule,
  ],
})
export class AppModule {}
