import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth.types';

export interface UserTarget {
  role: Role;
  departmentId?: string | null;
  guardRoomId?: string | null;
}

/** Which role/department may `actor` create or manage? (FR-3, FR-5) */
export function assertCanManage(actor: AuthUser, target: UserTarget): void {
  if (actor.role === 'super_admin') return;
  if (actor.role === 'dept_admin') {
    if (target.role === 'host' && target.departmentId && target.departmentId === actor.departmentId) return;
  }
  throw new ForbiddenException('You cannot manage this user');
}

/** Role <-> assignment consistency: guards need a guard room, staff need a department. */
export function assertValidAssignment(t: UserTarget): void {
  const { role, departmentId, guardRoomId } = t;
  if (role === 'guard') {
    if (!guardRoomId) throw new BadRequestException('A guard must be assigned to a guard room');
    if (departmentId) throw new BadRequestException('A guard cannot belong to a department');
  } else if (role === 'host' || role === 'dept_admin') {
    if (!departmentId) throw new BadRequestException('This role requires a department');
    if (guardRoomId) throw new BadRequestException('Only guards can be assigned to a guard room');
  } else if (departmentId || guardRoomId) {
    throw new BadRequestException('A super administrator has no department or guard room');
  }
}

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
export function assertStrongPassword(pw: string): void {
  if (!PASSWORD_RULE.test(pw)) {
    throw new BadRequestException('Password must be 10-128 characters with at least one letter and one digit');
  }
}
