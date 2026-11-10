import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from './auth.types';

/**
 * Single source of truth for data segregation (FR-17, FR-24, NFR-5).
 * Every visit query must merge this into its `where`; never trust client filters.
 */
export function visitScope(user: AuthUser): Prisma.VisitWhereInput {
  switch (user.role) {
    case 'super_admin':
      return {};
    case 'dept_admin':
      if (!user.departmentId) throw new ForbiddenException();
      return { departmentId: user.departmentId };
    case 'host':
      return { hostUserId: user.id };
    case 'guard':
      if (!user.guardRoomId) throw new ForbiddenException();
      return { guardRoomId: user.guardRoomId };
    default:
      throw new ForbiddenException();
  }
}
