import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { CreateTrunkDto, PreviewTrunkDto, UpdateTrunkDto } from './dto';
import { TrunkPlannerService } from './trunk-planner.service';
import { TrunksService } from './trunks.service';

@Controller('api/trunks')
export class TrunksController {
  constructor(
    private readonly trunks: TrunksService,
    private readonly planner: TrunkPlannerService,
  ) {}

  @Get()
  list() {
    return this.trunks.list();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.trunks.get(id);
  }

  @Get(':id/status')
  status(@Param('id', ParseIntPipe) id: number) {
    return this.trunks.status(id);
  }

  @Post('preview')
  preview(@Body() input: PreviewTrunkDto) {
    return this.planner.build(input);
  }

  @Post()
  create(@Body() input: CreateTrunkDto) {
    return this.trunks.create(input);
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() input: UpdateTrunkDto) {
    return this.trunks.update(id, input);
  }
}
