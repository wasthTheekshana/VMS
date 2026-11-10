import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { assertCanManage, assertStrongPassword, assertValidAssignment } from './user-rules';
import { visitScope } from '../common/scope';

const admin: AuthUser = { id: '1', role: 'super_admin', departmentId: null, guardRoomId: null };
const deptAdmin: AuthUser = { id: '2', role: 'dept_admin', departmentId: 'hr', guardRoomId: null };
const guard: AuthUser = { id: '3', role: 'guard', departmentId: null, guardRoomId: 'gate-1' };
const host: AuthUser = { id: '4', role: 'host', departmentId: 'hr', guardRoomId: null };

describe('assertCanManage', () => {
  it('lets a super admin manage anyone', () => {
    expect(() => assertCanManage(admin, { role: 'guard', guardRoomId: 'g' })).not.toThrow();
  });
  it('lets a dept admin manage hosts in their own department only', () => {
    expect(() => assertCanManage(deptAdmin, { role: 'host', departmentId: 'hr' })).not.toThrow();
    expect(() => assertCanManage(deptAdmin, { role: 'host', departmentId: 'it' })).toThrow(ForbiddenException);
    expect(() => assertCanManage(deptAdmin, { role: 'dept_admin', departmentId: 'hr' })).toThrow(ForbiddenException);
    expect(() => assertCanManage(deptAdmin, { role: 'guard', guardRoomId: 'g' })).toThrow(ForbiddenException);
  });
  it('denies hosts and guards', () => {
    expect(() => assertCanManage(host, { role: 'host', departmentId: 'hr' })).toThrow(ForbiddenException);
    expect(() => assertCanManage(guard, { role: 'host', departmentId: 'hr' })).toThrow(ForbiddenException);
  });
});

describe('assertValidAssignment', () => {
  it('requires a guard room for guards, a department for staff', () => {
    expect(() => assertValidAssignment({ role: 'guard' })).toThrow(BadRequestException);
    expect(() => assertValidAssignment({ role: 'guard', guardRoomId: 'g' })).not.toThrow();
    expect(() => assertValidAssignment({ role: 'host' })).toThrow(BadRequestException);
    expect(() => assertValidAssignment({ role: 'host', departmentId: 'd' })).not.toThrow();
    expect(() => assertValidAssignment({ role: 'host', departmentId: 'd', guardRoomId: 'g' })).toThrow(BadRequestException);
    expect(() => assertValidAssignment({ role: 'super_admin', departmentId: 'd' })).toThrow(BadRequestException);
  });
});

describe('assertStrongPassword', () => {
  it.each(['short1', 'alllettersnodigit', '1234567890123'])('rejects %s', (p) => {
    expect(() => assertStrongPassword(p)).toThrow(BadRequestException);
  });
  it('accepts a long mixed password', () => {
    expect(() => assertStrongPassword('correct-horse-42')).not.toThrow();
  });
});

describe('visitScope (data segregation, FR-17 / FR-24)', () => {
  it('confines a guard to their own guard room', () => {
    expect(visitScope(guard)).toEqual({ guardRoomId: 'gate-1' });
  });
  it('confines a dept admin to their department and a host to their own visits', () => {
    expect(visitScope(deptAdmin)).toEqual({ departmentId: 'hr' });
    expect(visitScope(host)).toEqual({ hostUserId: '4' });
  });
  it('gives a super admin everything', () => {
    expect(visitScope(admin)).toEqual({});
  });
  it('fails closed when a guard has no guard room', () => {
    expect(() => visitScope({ ...guard, guardRoomId: null })).toThrow(ForbiddenException);
  });
});
