import { Body, Controller, Get, HttpCode, Module, Post, Res } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { COOKIE_NAME } from '../common/guards';
import { loadEnv } from '../config/env';
import { ms } from './ms';

export class LoginDto {
  @IsString() @MinLength(1) @MaxLength(64) username: string;
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword: string;
  @IsString() @MaxLength(128) newPassword: string;
}

@Controller('auth')
export class AuthController {
  private readonly env = loadEnv();
  constructor(private readonly auth: AuthService) {}

  private setCookie(res: Response, token: string) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'strict',
      maxAge: ms(this.env.jwtExpiresIn),
      path: '/',
    });
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // brute-force protection
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(dto.username, dto.password);
    this.setCookie(res, token);
    return { id: user.id, name: user.name, username: user.username, role: user.role, departmentId: user.departmentId, guardRoomId: user.guardRoomId };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  /** Sliding session: the web app calls this on activity to extend the idle window. */
  @Post('refresh')
  @HttpCode(204)
  async refresh(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    this.setCookie(res, await this.auth.refresh(user.id));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: loadEnv().jwtSecret,
      signOptions: { expiresIn: loadEnv().jwtExpiresIn as any, algorithm: 'HS256' },
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
