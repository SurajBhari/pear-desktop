import type { MusicGrantStore } from './backend/music-grant-store';
import type { APIServerConfig } from './config';
import type { MusicScope } from './music-types';
import type { MenuContext } from '@/types/contexts';
import type { MessageBoxOptions } from 'electron';

export interface NativeGrantOwner {
  current(): boolean;
}
export interface NativeGrantService {
  resource: string;
  grants: MusicGrantStore;
  captureNativeOwner(): NativeGrantOwner;
}
export interface MusicNativeActions {
  prompt(): Promise<string | null>;
  show(options: MessageBoxOptions): Promise<{ response: number }>;
  copy(token: string): void;
}
/** Native-only create/copy/revoke flow. The bearer never enters a dialog renderer, settings, or IPC. */
export async function createMusicGrantMenu(
  context: MenuContext<APIServerConfig>,
  resolveService: () => NativeGrantService | undefined,
  native: MusicNativeActions,
) {
  const config = await context.getConfig();
  const policy = (resource: string) =>
    `REST at ${resource}\nLocal peers only (127.0.0.0/8 / ::1), exact Host, no browser Origin or forwarded-host access. Grants expire after 24 hours.`;
  const safeOwner = (service: NativeGrantService) => {
    try {
      return service.captureNativeOwner();
    } catch {
      return;
    }
  };
  const show = async (options: MessageBoxOptions) => {
    try {
      return await native.show(options);
    } catch {
      return;
    }
  };
  return [
    {
      label: 'Enable expanded music API',
      type: 'checkbox' as const,
      checked: !!config.musicApiEnabled,
      async click(item: { checked: boolean }) {
        await context.setConfig({ musicApiEnabled: item.checked });
      },
    },
    {
      label: 'Create client grant…',
      enabled:
        !!config.enabled && !!config.musicApiEnabled && !!resolveService(),
      async click() {
        const service = resolveService();
        if (!service) return;
        const owner = safeOwner(service);
        if (!owner?.current()) return;
        const current = () => resolveService() === service && owner.current();
        let name: string | null;
        try {
          name = await native.prompt();
        } catch {
          return;
        }
        if (!name || !current()) return;
        const scopes: MusicScope[] = [];
        for (;;) {
          const choice = await show({
            type: 'question',
            title: 'Music API client permissions',
            message: `Grant for ${name}`,
            detail: `${policy(service.resource)}\n\nSelected: ${scopes.join(', ') || 'none'}`,
            buttons: [
              `${scopes.includes('playback.read') ? 'Remove' : 'Add'} playback read`,
              `${scopes.includes('catalog.read') ? 'Remove' : 'Add'} catalog read`,
              'Create grant',
              'Cancel',
            ],
            defaultId: 3,
            cancelId: 3,
          });
          if (!current() || !choice || choice.response === 3) return;
          if (choice.response === 2) break;
          if (choice.response !== 0 && choice.response !== 1) return;
          const scope =
            choice.response === 0 ? 'playback.read' : 'catalog.read';
          const index = scopes.indexOf(scope);
          if (index < 0) scopes.push(scope);
          else scopes.splice(index, 1);
        }
        let grant: Awaited<ReturnType<MusicGrantStore['issue']>>;
        try {
          grant = await service.grants.issue(
            name,
            'rest',
            service.resource,
            scopes,
            current,
          );
        } catch {
          return;
        }
        const retireIssued = () =>
          service.grants.revoke(grant.record.id, () => true).catch(() => {});
        if (!current()) {
          await retireIssued();
          return;
        }
        try {
          const result = await show({
            type: 'question',
            title: 'Music API client grant',
            message: 'Client grant created',
            detail: `${policy(service.resource)}\n\nCopy the credential now. It cannot be shown again.`,
            buttons: ['Copy token', 'Cancel and revoke'],
            defaultId: 1,
            cancelId: 1,
          });
          if (result?.response !== 0 || !current()) {
            await retireIssued();
            return;
          }
          native.copy(grant.token);
        } catch {
          await retireIssued();
        }
      },
    },
    {
      label: 'Revoke client grants…',
      enabled: !!resolveService(),
      async click() {
        const service = resolveService();
        if (!service) return;
        const owner = safeOwner(service);
        if (!owner?.current()) return;
        const current = () => resolveService() === service && owner.current();
        let records: Awaited<ReturnType<MusicGrantStore['list']>>;
        try {
          records = await service.grants.list();
        } catch {
          return;
        }
        if (!current() || !records.length) return;
        const choice = await show({
          type: 'question',
          title: 'Revoke music API client grant',
          message: 'Choose a grant to revoke',
          detail: policy(service.resource),
          buttons: [
            ...records.map(
              (r) =>
                `${r.name} (${r.transport}, ${r.scopes.join(', ') || 'no permissions'})`,
            ),
            'Cancel',
          ],
          defaultId: records.length,
          cancelId: records.length,
        });
        if (
          !current() ||
          !choice ||
          choice.response < 0 ||
          choice.response >= records.length
        )
          return;
        try {
          await service.grants.revoke(records[choice.response].id, current);
        } catch {
          /* A retired native action cannot mutate the ledger. */
        }
      },
    },
  ];
}
