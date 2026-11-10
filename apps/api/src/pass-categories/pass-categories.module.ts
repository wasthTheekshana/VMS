import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { mapPrismaError } from '../common/prisma-errors';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreatePassCategoryDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(50) name: string;
}
export class UpdatePassCategoryDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(50) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class PassCategoriesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list() {
    return this.prisma.passCategory.findMany({ orderBy: { name: 'asc' } });
  }

  async create(actor: AuthUser, dto: CreatePassCategoryDto) {
    try {
      const c = await this.prisma.passCategory.create({ data: { name: dto.name } });
      await this.audit.record({ userId: actor.id, action: 'create', entity: 'pass_category', entityId: c.id, after: c });
      return c;
    } catch (e) {
      mapPrismaError(e, 'Pass category');
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdatePassCategoryDto) {
    const before = await this.prisma.passCategory.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Pass category not found');
    try {
      const after = await this.prisma.passCategory.update({ where: { id }, data: dto });
      await this.audit.record({ userId: actor.id, action: 'update', entity: 'pass_category', entityId: id, before, after });
      return after;
    } catch (e) {
      mapPrismaError(e, 'Pass category');
    }
  }
}

@Controller('pass-categories')
export class PassCategoriesController {
  constructor(private readonly svc: PassCategoriesService) {}

  @Get() list() {
    return this.svc.list();
  }
  @Roles('super_admin') @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreatePassCategoryDto) {
    return this.svc.create(u, dto);
  }
  @Roles('super_admin') @Patch(':id') update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePassCategoryDto,
  ) {
    return this.svc.update(u, id, dto);
  }
}

@Module({ controllers: [PassCategoriesController], providers: [PassCategoriesService] })
export class PassCategoriesModule {}
