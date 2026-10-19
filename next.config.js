/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The interface is a static page served from /public.
  async rewrites() {
    return [{ source: '/', destination: '/page.html' }];
  },
  async headers() {
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ];
    const csp =
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    return [
      { source: '/:path*', headers: security },
      { source: '/', headers: [{ key: 'Content-Security-Policy', value: csp }] },
      { source: '/page.html', headers: [{ key: 'Content-Security-Policy', value: csp }] },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

module.exports = nextConfig;
