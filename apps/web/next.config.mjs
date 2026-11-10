const api = process.env.API_URL ?? 'http://localhost:4000';
const dev = process.env.NODE_ENV !== 'production';

// Everything is same-origin (API and Socket.IO go through the /api and /ws paths), so nothing external is allowed.
// 'unsafe-inline' scripts are required by Next's bootstrap; 'unsafe-eval' only for the dev server's hot reload.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? ' ws: http://localhost:4000' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  // Same-origin /api keeps the HttpOnly SameSite=Strict session cookie working in dev and behind nginx.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};
