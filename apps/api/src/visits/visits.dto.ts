import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDate, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength,
  MinLength, ValidateNested,
} from 'class-validator';
import { PiiCrypto } from '../common/pii-crypto';
import { NIC_PATTERN } from './visit-rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const nic = ({ value }: { value: unknown }) => (typeof value === 'string' ? PiiCrypto.normaliseNic(value) : value);
const PHONE = /^\+?[0-9]{9,15}$/;
const NIC_MSG = 'must be a valid NIC (9 digits + V/X, or 12 digits) or driving licence (letter + 7 digits)';

export class VisitorInputDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) fullName: string;
  @Transform(nic) @Matches(NIC_PATTERN, { message: `nic ${NIC_MSG}` }) nic: string;
  @IsOptional() @Transform(trim) @Matches(PHONE, { message: 'phone must be 9-15 digits, optional leading +' }) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) company?: string;
}

export class PreRegisterDto {
  // FR-9: one or many visitors under a single pre-registration.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => VisitorInputDto)
  visitors: VisitorInputDto[];
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(300) purpose: string;
  @Type(() => Date) @IsDate() expectedAt: Date;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(160) areaVisited: string;
  @IsUUID() guardRoomId: string;
}

export class UpdatePreRegistrationDto {
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(300) purpose?: string;
  @IsOptional() @Type(() => Date) @IsDate() expectedAt?: Date;
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(160) areaVisited?: string;
  @IsOptional() @IsUUID() guardRoomId?: string;
}

export class CheckInDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) fullName?: string;
  @IsOptional() @Transform(nic) @Matches(NIC_PATTERN, { message: `nic ${NIC_MSG}` }) nic?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) address?: string;
  @IsOptional() @Transform(trim) @Matches(PHONE, { message: 'phone must be 9-15 digits, optional leading +' }) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) company?: string;
  @IsUUID() passCategoryId: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) areaVisited?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) remarks?: string;
  /** Approved blacklist override (single use). */
  @IsOptional() @IsUUID() overrideId?: string;
}

export class WalkInDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) fullName: string;
  @Transform(nic) @Matches(NIC_PATTERN, { message: `nic ${NIC_MSG}` }) nic: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) address?: string;
  @IsOptional() @Transform(trim) @Matches(PHONE, { message: 'phone must be 9-15 digits, optional leading +' }) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) company?: string;
  @IsUUID() hostDepartmentId: string;
  @IsOptional() @IsUUID() hostUserId?: string; // "if the host is unknown, the guard selects the department only"
  @IsUUID() passCategoryId: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) purpose?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) areaVisited?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) remarks?: string;
  @IsOptional() @IsUUID() overrideId?: string;
}

export class CheckOutDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) remarks?: string;
}
