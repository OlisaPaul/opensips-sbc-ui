import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class TrunkInputDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  providerIp!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  providerPort!: number;

  @IsString()
  @MaxLength(20)
  username!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsBoolean()
  registrationEnabled!: boolean;

  @IsOptional()
  @IsString()
  registrationServer?: string;

  @IsString()
  applicationName!: string;

  @IsString()
  applicationIp!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  applicationPort!: number;

  @IsString()
  @MaxLength(32)
  accessPrefix!: string;

  @IsBoolean()
  stripPrefix!: boolean;

  @IsString()
  pilotCli!: string;

  @IsOptional()
  @IsInt()
  providerDispatcherSet?: number;

  @IsOptional()
  @IsInt()
  applicationDispatcherSet?: number;
}

export class PreviewTrunkDto extends TrunkInputDto {}
export class CreateTrunkDto extends TrunkInputDto {}
export class UpdateTrunkDto extends TrunkInputDto {}
