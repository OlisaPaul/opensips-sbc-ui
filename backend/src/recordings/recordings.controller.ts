import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { RecordingsService } from './recordings.service';

@Controller('api/recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  list() {
    return this.recordings.list();
  }

  @Get(':id/audio')
  async audio(@Param('id') id: string, @Query('download') download: string | undefined, @Res() response: Response) {
    const wav = await this.recordings.audio(id);
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Content-Length', wav.length);
    response.setHeader('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename="recording.wav"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(wav);
  }
}
