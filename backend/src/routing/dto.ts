import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class InboundRouteInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  startDid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  endDid?: string;

  @IsInt()
  @Min(1)
  trunkId!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  applicationName!: string;

  @IsString()
  @MaxLength(64)
  applicationIp!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  applicationPort!: number;

  @IsInt()
  @Min(1)
  destinationSetId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string;
}

export class OutboundRouteInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  prefix!: string;

  @IsInt()
  @Min(1)
  trunkId!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  pilotCli!: string;

  @IsBoolean()
  stripPrefix!: boolean;

  @IsOptional()
  @IsIn(['dial_prefix'])
  routingMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  description?: string;
}
