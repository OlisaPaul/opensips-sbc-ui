import { Module } from '@nestjs/common';
import { MiService } from './mi.service';

@Module({
  providers: [MiService],
  exports: [MiService],
})
export class MiModule {}
