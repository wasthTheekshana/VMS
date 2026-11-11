import {
  Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Global } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MaxLength, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { PiiCrypto } from '../common/pii-crypto';
import { OverrideRequestDto, OverridesService } from '../blacklist/blacklist.module';
import { VisitsService } from './visits.service';
import { CheckInDto, CheckOutDto, PreRegisterDto, UpdatePreRegistrationDto, WalkInDto } from './visits.dto';

class SearchQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}
class LogQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to?: string;
}
class LookupQuery {
  @IsString() @MaxLength(30) nic: string;
}

/** Host portal API (Module 4). */
@Controller('visits')
@Roles('host', 'dept_admin')
export class HostVisitsController {
  constructor(private readonly svc: VisitsService) {}

  @Post() preRegister(@CurrentUser() u: AuthUser, @Body() dto: PreRegisterDto) {
    return this.svc.preRegister(u, dto);
  }
  @Get('mine') mine(@CurrentUser() u: AuthUser) {
    return this.svc.listMine(u);
  }
  @Get(':id') one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getOne(u, id);
  }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePreRegistrationDto) {
    return this.svc.updatePreRegistration(u, id, dto);
  }
  @Post(':id/cancel') @HttpCode(200) cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.cancel(u, id);
  }
}

/** Guard console API (Module 5). Every handler is scoped to the guard's own guard room by the service. */
@Controller('guard')
@Roles('guard')
export class GuardController {
  constructor(private readonly svc: VisitsService, private readonly overrides: OverridesService) {}

  @Post('overrides') requestOverride(@CurrentUser() u: AuthUser, @Body() dto: OverrideRequestDto) {
    return this.overrides.request(u, dto);
  }
  @Get('overrides/:id') overrideStatus(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.overrides.status(u, id);
  }
  @Get('hosts') hosts(@Query('departmentId', ParseUUIDPipe) departmentId: string) {
    return this.svc.hosts(departmentId);
  }
  @Get('visits/:id/slip') slip(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.slip(u, id);
  }

  @Get('expected') expected(@CurrentUser() u: AuthUser, @Query() q: SearchQuery) {
    return this.svc.expectedToday(u, q.q);
  }
  @Get('on-premises') onPremises(@CurrentUser() u: AuthUser, @Query() q: SearchQuery) {
    return this.svc.onPremises(u, q.q);
  }
  @Get('room-log') roomLog(@CurrentUser() u: AuthUser, @Query() q: LogQuery) {
    return this.svc.roomLog(u, q.from, q.to);
  }
  // Returns stored personal details for any NIC, so it is rate-limited well below the global limit (no enumeration) and audited.
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Get('lookup') lookup(@CurrentUser() u: AuthUser, @Query() q: LookupQuery) {
    return this.svc.lookup(u, q.nic);
  }
  @Get('visits/:id') one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getOne(u, id);
  }
  @Post('visits/:id/check-in') @HttpCode(200) checkIn(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckInDto) {
    return this.svc.checkIn(u, id, dto);
  }
  @Post('visits/:id/check-out') @HttpCode(200) checkOut(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckOutDto) {
    return this.svc.checkOut(u, id, dto);
  }
  @Post('walk-ins') walkIn(@CurrentUser() u: AuthUser, @Body() dto: WalkInDto) {
    return this.svc.walkIn(u, dto);
  }
}

@Global()
@Module({
  controllers: [HostVisitsController, GuardController],
  providers: [
    VisitsService,
    {
      provide: PiiCrypto,
      useFactory: () => new PiiCrypto(process.env.DATA_ENCRYPTION_KEY!, process.env.NIC_HASH_KEY!),
    },
  ],
  exports: [PiiCrypto],
})
export class VisitsModule {}

