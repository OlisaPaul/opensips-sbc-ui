import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

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

  @ValidateIf((input: TrunkInputDto) => input.registrationEnabled)
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86400)
  registrationExpiry?: number;

  @ValidateIf((_input: TrunkInputDto, value: unknown) => value !== undefined && value !== null && value !== '')
  @IsString()
  registrationServer?: string;

  @ValidateIf((_input: TrunkInputDto, value: unknown) => value !== undefined && value !== null && value !== '')
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bindingUri?: string;

  @ValidateIf((_input: TrunkInputDto, value: unknown) => value !== undefined && value !== null && value !== '')
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^(?:tel:\+?[0-9][0-9.-]*(?:;[A-Za-z0-9._-]+(?:=[A-Za-z0-9._+-]+)?)*|sips?:[^\s<>]+)$/i, {
    message: 'customPaiUri must be a complete tel: or sip: URI, for example tel:+2348139856030;user=phone.',
  })
  customPaiUri?: string;

  @IsInt()
  @Min(1)
  providerDispatcherSet!: number;
}

export class PreviewTrunkDto extends TrunkInputDto {}
export class CreateTrunkDto extends TrunkInputDto {}
export class UpdateTrunkDto extends TrunkInputDto {}

export class SetTrunkEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
