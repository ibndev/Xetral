/**
 * Security headers are part of this app's job.
 *
 * The API is same-origin behind `/api/x/*`, so the browser never makes a
 * cross-origin request and there is no CORS policy to soften. What is left is
 * everything an injected script could do with a live session.
 *
 * The headers here are the ones that are the same for every request. The
 * Content-Security-Policy is not one of them — it carries a per-request nonce
 * and lives in `src/middleware.ts`.
 */

/** @type {import('next').NextConfig} */

export default {
  reactStrictMode: true,
  // The client package is TypeScript source, not a build artifact — the same
  // arrangement every other workspace uses. Next has to be told to compile it.
  transpilePackages: ['@xetral/client'],

  // The version is a free hint to anyone deciding which exploit to try.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The Content-Security-Policy is NOT here. It needs a per-request
          // nonce, which a build-time config cannot produce — see
          // src/middleware.ts, and the failure that put it there.
          //
          // Belt to the CSP's braces: `frame-ancestors` is the modern rule and
          // this is what older browsers understand. Clickjacking a transfer
          // form is a real attack and both lines cost nothing.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Full URLs are not sent to other origins. A path like
          // /admin/users/<uuid> in a Referer header is a customer identifier
          // handed to whatever they clicked through to.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          // Two years, subdomains included. HSTS is what stops a first request
          // over plaintext on a hostile network, which is where a session
          // cookie would be readable — `Secure` alone does not prevent the
          // request being made.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      {
        // Nothing under the API proxy or the auth routes may be cached, by the
        // browser or by anything between. A cached balance is one customer's
        // money shown to the next person on a shared machine.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },

  webpack(config) {
    // The repo imports with explicit `.js` specifiers, which is what native
    // ESM requires and what every other workspace does. Next's webpack
    // resolves those literally and cannot find the `.ts` source, so it needs
    // the mapping stated. Changing the imports instead would break Node.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
