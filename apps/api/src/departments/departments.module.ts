import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { mapPrismaError } from '../common/prisma-errors';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateDepartmentDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
}
export class UpdateDepartmentDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list() {
    return this.prisma.department.findMany({ orderBy: { name: 'asc' } });
  }

  async create(actor: AuthUser, dto: CreateDepartmentDto) {
    try {
      const d = await this.prisma.department.create({ data: { name: dto.name } });
      await this.audit.record({ userId: actor.id, action: 'create', entity: 'department', entityId: d.id, after: d });
      return d;
    } catch (e) {
      mapPrismaError(e, 'Department');
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateDepartmentDto) {
    const before = await this.prisma.department.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Department not found');
    try {
      const after = await this.prisma.department.update({ where: { id }, data: dto });
      await this.audit.record({ userId: actor.id, action: 'update', entity: 'department', entityId: id, before, after });
      return after;
    } catch (e) {
      mapPrismaError(e, 'Department');
    }
  }
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly svc: DepartmentsService) {}

  @Get() list() {
    return this.svc.list();
  }
  @Roles('super_admin') @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateDepartmentDto) {
    return this.svc.create(u, dto);
  }
  @Roles('super_admin') @Patch(':id') update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.svc.update(u, id, dto);
  }
}

@Module({ controllers: [DepartmentsController], providers: [DepartmentsService] })
export class DepartmentsModule {}
