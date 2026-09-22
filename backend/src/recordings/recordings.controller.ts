import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { RecordingsService } from './recordings.service';

type AudioResponse = {
  setHeader(name: string, value: string | number): void;
  send(body: Buffer): void;
};

@Controller('api/recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  list() {
    return this.recordings.list();
  }

  @Get(':id/audio')
  async audio(@Param('id') id: string, @Query('download') download: string | undefined, @Res() response: AudioResponse) {
    const wav = await this.recordings.audio(id);
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Content-Length', wav.length);
    response.setHeader('Content-Disposition', `${download === '1' ? 'attachment' : 'inline'}; filename="recording.wav"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(wav);
  }
}
