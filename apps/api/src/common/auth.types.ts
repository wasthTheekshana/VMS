import { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  name?: string;
  role: Role;
  departmentId: string | null;
  guardRoomId: string | null;
}
