import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Translate known Prisma errors into HTTP errors; rethrow everything else. */
export function mapPrismaError(e: unknown, what: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') throw new ConflictException(`${what} already exists`);
    if (e.code === 'P2025') throw new NotFoundException(`${what} not found`);
  }
  throw e;
}
