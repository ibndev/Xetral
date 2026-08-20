const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);

// The client package is TypeScript source in a sibling workspace, so Metro has
// to be told to watch outside this directory and to resolve from the hoisted
// root node_modules.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// The repo imports with explicit `.js` specifiers — correct for native ESM and
// what every other workspace does. Metro resolves them literally, so the
// mapping to the `.ts` source has to be stated. Changing the imports instead
// would break Node.
config.resolver.sourceExts = [...config.resolver.sourceExts, 'cjs'];
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const rewritten =
    moduleName.startsWith('.') && moduleName.endsWith('.js')
      ? moduleName.slice(0, -3)
      : moduleName;
  return (upstream ?? context.resolveRequest)(context, rewritten, platform);
};

module.exports = config;
