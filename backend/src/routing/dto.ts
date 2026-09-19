import { IsBoolean, IsIn, IsInt, IsIP, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class InboundRouteInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(/^\+?\d+$/, { message: 'startDid must contain only digits with an optional leading +' })
  startDid!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\+?\d+$/, { message: 'endDid must contain only digits with an optional leading +' })
  endDid?: string;

  @IsInt()
  @Min(1)
  trunkId!: number;

  @IsInt()
  @Min(1)
  destinationGroupId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string;
}

export class ApplicationDestinationInputDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsIP()
  ip!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;
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
