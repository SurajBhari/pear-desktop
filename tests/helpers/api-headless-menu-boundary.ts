import path from 'node:path';

/**
 * These backend fixtures leave MCP disabled and do not own application menus.
 * Keep only that backend edge outside their bundles; real menu/readiness
 * fixtures must continue to resolve the actual application menu module.
 */
export function headlessApiMenuBoundary(root: string) {
  const backend = path
    .join(root, 'src/plugins/api-server/backend/main.ts')
    .replaceAll('\\', '/');
  const virtualId = '\0headless-api-native-menu';
  return {
    name: 'headless-api-native-menu-boundary',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (id === '@/menu' && importer?.replaceAll('\\', '/') === backend)
        return virtualId;
    },
    load(id: string) {
      if (id === virtualId)
        // The backend catches refresh failures, so this is an explicit scope
        // boundary, not an assertion that detects unexpected MCP activation.
        return 'export function refreshMenu(){throw Error("Native application menus are outside this headless API fixture");}';
    },
  };
}
