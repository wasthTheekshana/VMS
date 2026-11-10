import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { mapPrismaError } from '../common/prisma-errors';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateGuardRoomDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) location: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) description?: string;
}
export class UpdateGuardRoomDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) location?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class GuardRoomsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list() {
    return this.prisma.guardRoom.findMany({ orderBy: { name: 'asc' } });
  }

  async create(actor: AuthUser, dto: CreateGuardRoomDto) {
    try {
      const g = await this.prisma.guardRoom.create({ data: dto });
      await this.audit.record({ userId: actor.id, action: 'create', entity: 'guard_room', entityId: g.id, after: g });
      return g;
    } catch (e) {
      mapPrismaError(e, 'Guard room');
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateGuardRoomDto) {
    const before = await this.prisma.guardRoom.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Guard room not found');
    // UC-1 alternate flow: cannot deactivate while visitors are still on premises.
    if (dto.isActive === false && before.isActive) {
      const onPremises = await this.prisma.visit.count({ where: { guardRoomId: id, status: 'on_premises' } });
      if (onPremises > 0) {
        throw new BadRequestException(`Cannot deactivate: ${onPremises} visitor(s) still on premises`);
      }
    }
    try {
      const after = await this.prisma.guardRoom.update({ where: { id }, data: dto });
      await this.audit.record({ userId: actor.id, action: 'update', entity: 'guard_room', entityId: id, before, after });
      return after;
    } catch (e) {
      mapPrismaError(e, 'Guard room');
    }
  }
}

@Controller('guard-rooms')
export class GuardRoomsController {
  constructor(private readonly svc: GuardRoomsService) {}

  @Get() list() {
    return this.svc.list();
  }
  @Roles('super_admin') @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateGuardRoomDto) {
    return this.svc.create(u, dto);
  }
  @Roles('super_admin') @Patch(':id') update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGuardRoomDto,
  ) {
    return this.svc.update(u, id, dto);
  }
}

@Module({ controllers: [GuardRoomsController], providers: [GuardRoomsService] })
export class GuardRoomsModule {}
