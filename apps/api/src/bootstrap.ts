import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/** Shared by main.ts and the e2e tests so tests exercise the real pipeline. */
export function configureApp(app: INestApplication, webOrigin: string) {
  app.setGlobalPrefix('api');
  // Behind the shared nginx every request arrives from nginx's address. Trust exactly that many proxy hops so the
  // rate limiter sees the real client IP (otherwise one person's failed logins lock everyone out). 0 = no proxy.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0) app.getHttpAdapter().getInstance().set('trust proxy', hops);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: webOrigin, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
