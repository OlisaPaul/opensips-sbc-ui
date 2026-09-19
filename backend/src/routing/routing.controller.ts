import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApplicationDestinationInputDto, InboundRouteInputDto, OutboundRouteInputDto } from './dto';
import { RoutingService } from './routing.service';

@Controller('api')
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get('application-destinations')
  listApplicationDestinations() {
    return this.routing.listApplicationDestinations();
  }

  @Post('application-destinations')
  createApplicationDestination(@Body() input: ApplicationDestinationInputDto) {
    return this.routing.createApplicationDestination(input);
  }

  @Get('inbound-routes')
  listInbound() {
    return this.routing.listInbound();
  }

  @Get('inbound-routes/:id')
  getInbound(@Param('id', ParseIntPipe) id: number) {
    return this.routing.getInbound(id);
  }

  @Post('inbound-routes')
  createInbound(@Body() input: InboundRouteInputDto) {
    return this.routing.createInbound(input);
  }

  @Put('inbound-routes/:id')
  updateInbound(@Param('id', ParseIntPipe) id: number, @Body() input: InboundRouteInputDto) {
    return this.routing.updateInbound(id, input);
  }

  @Get('outbound-routes')
  listOutbound() {
    return this.routing.listOutbound();
  }

  @Get('outbound-routes/:id')
  getOutbound(@Param('id', ParseIntPipe) id: number) {
    return this.routing.getOutbound(id);
  }

  @Post('outbound-routes')
  createOutbound(@Body() input: OutboundRouteInputDto) {
    return this.routing.createOutbound(input);
  }

  @Put('outbound-routes/:id')
  updateOutbound(@Param('id', ParseIntPipe) id: number, @Body() input: OutboundRouteInputDto) {
    return this.routing.updateOutbound(id, input);
  }
}
