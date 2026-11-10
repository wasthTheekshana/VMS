import { Prisma, VisitStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { isValidNic } from '../visits/visit-rules';

const COLOMBO_OFFSET_MS = 5.5 * 3600_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const SORT_FIELDS = [
  'timeIn', 'expectedAt', 'createdAt', 'referenceNo', 'status', 'visitor', 'company', 'guardRoom', 'department', 'passCategory',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

/** Filters shared by the records list, the exports and (later) any report (FR-23, FR-26). */
export class RecordsQuery {
  /** Inclusive calendar dates in Sri Lanka time, "YYYY-MM-DD". */
  @IsOptional() @Matches(YMD) from?: string;
  @IsOptional() @Matches(YMD) to?: string;
  @IsOptional() @IsUUID() guardRoomId?: string;
  @IsOptional() @IsUUID() passCategoryId?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() hostUserId?: string;
  @IsOptional() @IsEnum(VisitStatus) status?: VisitStatus;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) company?: string;
  /** NIC / licence (exact), or part of a name / reference number. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(SORT_FIELDS) sortBy?: SortField;
  @IsOptional() @IsEnum(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

/** Start of a Colombo calendar day as a UTC instant. */
export function colomboDayStart(ymd: string): Date {
  const t = Date.parse(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date ${ymd}`);
  return new Date(t - COLOMBO_OFFSET_MS);
}

/** A visit's "date" is its arrival time, or its expected time if it has not arrived (yet / ever). */
export function dateRangeClause(from?: string, to?: string): Prisma.VisitWhereInput | undefined {
  if (!from && !to) return undefined;
  const range: Prisma.DateTimeFilter = {};
  if (from) range.gte = colomboDayStart(from);
  if (to) range.lt = new Date(colomboDayStart(to).getTime() + 86_400_000); // `to` is inclusive
  return { OR: [{ timeIn: range }, { timeIn: null, expectedAt: range }] };
}

export function buildWhere(f: RecordsQuery, hashNic: (nic: string) => string): Prisma.VisitWhereInput {
  const and: Prisma.VisitWhereInput[] = [];
  const range = dateRangeClause(f.from, f.to);
  if (range) and.push(range);
  if (f.guardRoomId) and.push({ guardRoomId: f.guardRoomId });
  if (f.passCategoryId) and.push({ passCategoryId: f.passCategoryId });
  if (f.departmentId) and.push({ departmentId: f.departmentId });
  if (f.hostUserId) and.push({ hostUserId: f.hostUserId });
  if (f.status) and.push({ status: f.status });
  if (f.company) and.push({ visitor: { company: { contains: f.company, mode: 'insensitive' } } });
  if (f.q) {
    const or: Prisma.VisitWhereInput[] = [
      { referenceNo: { contains: f.q.toUpperCase() } },
      { visitor: { fullName: { contains: f.q, mode: 'insensitive' } } },
    ];
    if (isValidNic(f.q)) or.push({ visitor: { nicHash: hashNic(f.q) } });
    and.push({ OR: or });
  }
  return and.length ? { AND: and } : {};
}

export function buildOrderBy(sortBy: SortField = 'timeIn', order: 'asc' | 'desc' = 'desc'): Prisma.VisitOrderByWithRelationInput[] {
  const primary: Prisma.VisitOrderByWithRelationInput = (() => {
    switch (sortBy) {
      case 'visitor': return { visitor: { fullName: order } };
      case 'company': return { visitor: { company: order } };
      case 'guardRoom': return { guardRoom: { name: order } };
      case 'department': return { department: { name: order } };
      case 'passCategory': return { passCategory: { name: order } };
      default: return { [sortBy]: order };
    }
  })();
  return [primary, { id: 'asc' }]; // id tiebreak keeps pagination stable
}
