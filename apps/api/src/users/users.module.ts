import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { mapPrismaError } from '../common/prisma-errors';
import { BCRYPT_COST } from '../auth/auth.service';
import { assertCanManage, assertStrongPassword, assertValidAssignment } from './user-rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PHONE = /^\+?[0-9]{9,15}$/;

/** Never expose password_hash. */
const PUBLIC_USER = {
  id: true, name: true, username: true, email: true, phone: true, role: true,
  departmentId: true, guardRoomId: true, isActive: true, createdAt: true,
} as const;

export class CreateUserDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name: string;
  @Transform(lower) @Matches(USERNAME, { message: 'username must be 3-32 characters: letters, digits, dot, dash or underscore' }) username: string;
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : lower({ value }))) @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Transform(trim) @Matches(PHONE, { message: 'phone must be 9-15 digits, optional leading +' }) phone?: string;
  @IsEnum(Role) role: Role;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() guardRoomId?: string;
  @IsString() @MaxLength(128) password: string;
}

export class UpdateUserDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @Transform(trim) @Matches(PHONE, { message: 'phone must be 9-15 digits, optional leading +' }) phone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(128) password?: string;
  // Re-assignment of guards between rooms (FR-5); super admin only.
  @IsOptional() @IsUUID() guardRoomId?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(actor: AuthUser, role?: Role) {
    const where =
      actor.role === 'super_admin'
        ? { ...(role ? { role } : {}) }
        : { departmentId: actor.departmentId, role: 'host' as Role }; // dept admin: own hosts only
    return this.prisma.user.findMany({ where, select: PUBLIC_USER, orderBy: { name: 'asc' } });
  }

  async create(actor: AuthUser, dto: CreateUserDto) {
    assertCanManage(actor, dto);
    assertValidAssignment(dto);
    assertStrongPassword(dto.password);
    if (dto.departmentId) {
      const d = await this.prisma.department.findUnique({ where: { id: dto.departmentId } });
      if (!d?.isActive) throw new BadRequestException('Department not found or inactive');
    }
    if (dto.guardRoomId) {
      const g = await this.prisma.guardRoom.findUnique({ where: { id: dto.guardRoomId } });
      if (!g?.isActive) throw new BadRequestException('Guard room not found or inactive');
    }
    try {
      const { password, ...rest } = dto;
      const user = await this.prisma.user.create({
        data: { ...rest, passwordHash: await bcrypt.hash(password, BCRYPT_COST) },
        select: PUBLIC_USER,
      });
      await this.audit.record({ userId: actor.id, action: 'create', entity: 'user', entityId: user.id, after: user });
      return user;
    } catch (e) {
      mapPrismaError(e, 'User with this username or email');
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_USER });
    if (!before) throw new NotFoundException('User not found');
    assertCanManage(actor, before);
    if (dto.isActive === false && id === actor.id) throw new BadRequestException('You cannot deactivate yourself');
    if (dto.guardRoomId !== undefined) {
      if (actor.role !== 'super_admin') throw new ForbiddenException();
      assertValidAssignment({ ...before, guardRoomId: dto.guardRoomId });
      const g = await this.prisma.guardRoom.findUnique({ where: { id: dto.guardRoomId } });
      if (!g?.isActive) throw new BadRequestException('Guard room not found or inactive');
    }
    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password !== undefined) {
      assertStrongPassword(password);
      data.passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    }
    const after = await this.prisma.user.update({ where: { id }, data, select: PUBLIC_USER });
    await this.audit.record({
      userId: actor.id, action: password ? 'update_password' : 'update', entity: 'user', entityId: id, before, after,
    });
    return after;
  }
}

@Controller('users')
@Roles('super_admin', 'dept_admin')
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query('role') role?: Role) {
    return this.svc.list(u, role && Object.values(Role).includes(role) ? role : undefined);
  }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto) {
    return this.svc.create(u, dto);
  }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.svc.update(u, id, dto);
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
