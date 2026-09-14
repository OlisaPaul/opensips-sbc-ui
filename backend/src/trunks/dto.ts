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

  @IsInt()
  @Min(1)
  providerDispatcherSet!: number;
}

export class PreviewTrunkDto extends TrunkInputDto {}
export class CreateTrunkDto extends TrunkInputDto {}
export class UpdateTrunkDto extends TrunkInputDto {}
