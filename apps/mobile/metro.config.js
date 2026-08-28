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

// AND HIERARCHICAL LOOKUP STAYS ON, which is the opposite of what the Expo
// monorepo recipe used to say. `disableHierarchicalLookup` was set here and
// broke the bundle the first time a package brought a NESTED copy of one of
// its own dependencies: npm hoists what it can and leaves a duplicate under
// the dependent, and with the walk disabled Metro looks only in the two
// directories listed above and reports `Unable to resolve module
// webidl-conversions`, from a file nothing in this repository imports.
//
// The two settings are not a pair. `nodeModulesPaths` is what lets a workspace
// package reach the hoisted root; the walk is what lets a hoisted package
// reach its own nested duplicate. Turning the second off to get the first is
// how a bundle fails on a transitive dependency's version conflict.

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
