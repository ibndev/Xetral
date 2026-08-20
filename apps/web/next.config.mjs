/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The client package is TypeScript source, not a build artifact — the same
  // arrangement every other workspace uses. Next has to be told to compile it.
  transpilePackages: ['@xetral/client'],

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
