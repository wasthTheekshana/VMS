import { Body, Controller, Get, HttpCode, Module, Post, Req, Res } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
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
  // bcrypt only reads the first 72 bytes; a longer password would silently be truncated, so it is refused instead
  @IsString() @MaxLength(72) newPassword: string;
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

  /** Public so an expired session can still clear its cookie; a valid one is also revoked server-side. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  /** Sliding idle window: the web app calls this on activity. It can never extend the absolute session limit. */
  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.setCookie(res, await this.auth.refresh(req.cookies?.[COOKIE_NAME]));
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    // Every other session of this user ends; this browser receives a fresh token and stays signed in.
    this.setCookie(res, await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword));
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
