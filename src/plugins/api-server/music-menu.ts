import { parseRemoteMusicResource } from './backend/music-http-policy';

import type { MusicGrantStore } from './backend/music-grant-store';
import type { APIServerConfig } from './config';
import type { MusicScope } from './music-types';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';
import type { MessageBoxOptions } from 'electron';

export interface NativeGrantOwner {
  current(): boolean;
}
export interface NativeGrantService {
  transport?: 'rest' | 'mcp';
  resource: string;
  grants: MusicGrantStore;
  captureNativeOwner(resource?: string): NativeGrantOwner;
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
  transport: 'rest' | 'mcp' = 'rest',
) {
  const config = await context.getConfig();
  return [
    {
      label:
        transport === 'mcp'
          ? 'Enable MCP music access'
          : 'Enable expanded music API',
      type: 'checkbox' as const,
      checked:
        transport === 'mcp' ? !!config.mcpEnabled : !!config.musicApiEnabled,
      async click(item: { checked: boolean }) {
        await context.setConfig(
          transport === 'mcp'
            ? { mcpEnabled: item.checked }
            : { musicApiEnabled: item.checked },
        );
        await context.refresh();
      },
    },
    ...createGrantActions(
      resolveService,
      native,
      transport,
      !!config.enabled &&
        (transport === 'mcp' ? !!config.mcpEnabled : !!config.musicApiEnabled),
    ),
  ];
}

function createGrantActions(
  resolveService: () => NativeGrantService | undefined,
  native: MusicNativeActions,
  transport: 'rest' | 'mcp',
  canCreate: boolean,
  remoteResource?: string,
) {
  const policy = (resource: string) =>
    remoteResource === undefined
      ? `${transport === 'mcp' ? 'MCP' : 'REST'} at ${resource}\nLocal peers only (127.0.0.0/8 / ::1), exact Host, no browser Origin or forwarded-host access. Grants expire after 24 hours.`
      : `REST at ${resource}\nDirect valid-IP peers including loopback, exact raw Host. No Origin, Forwarded or X-Forwarded-* headers. Grants expire after 24 hours.`;
  const safeOwner = (service: NativeGrantService) => {
    try {
      return remoteResource === undefined
        ? service.captureNativeOwner()
        : service.captureNativeOwner(remoteResource);
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
      label: 'Create client grant…',
      enabled: canCreate && !!resolveService(),
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
            detail: `${policy(remoteResource ?? service.resource)}\n\nSelected: ${scopes.join(', ') || 'none'}`,
            buttons: [
              `${scopes.includes('playback.read') ? 'Remove' : 'Add'} playback read`,
              `${scopes.includes('catalog.read') ? 'Remove' : 'Add'} catalog read`,
              'Create grant',
              'Cancel',
              `${scopes.includes('personalized.read') ? 'Remove' : 'Add'} Home read`,
              `${scopes.includes('library.read') ? 'Remove' : 'Add'} library playlists read`,
              ...(transport === 'rest'
                ? [
                    `${scopes.includes('playback.control') ? 'Remove' : 'Add'} playback control`,
                    `${scopes.includes('queue.write') ? 'Remove' : 'Add'} queue write`,
                  ]
                : []),
              `${scopes.includes('comments.read') ? 'Remove' : 'Add'} public comments read`,
              ...(transport === 'mcp'
                ? [
                    `${scopes.includes('playback.control') ? 'Remove' : 'Add'} playback control`,
                    `${scopes.includes('queue.write') ? 'Remove' : 'Add'} queue write`,
                  ]
                : []),
            ],
            defaultId: 3,
            cancelId: 3,
          });
          if (!current() || !choice || choice.response === 3) return;
          if (
            transport === 'mcp' &&
            ![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(choice.response)
          )
            return;
          if (choice.response === 2) break;
          const scope =
            transport === 'mcp' && choice.response >= 6
              ? (
                  {
                    6: 'comments.read',
                    7: 'playback.control',
                    8: 'queue.write',
                  } as const
                )[choice.response as 6 | 7 | 8]
              : (
                  {
                    0: 'playback.read',
                    1: 'catalog.read',
                    4: 'personalized.read',
                    5: 'library.read',
                    6: 'playback.control',
                    7: 'queue.write',
                    8: 'comments.read',
                  } as const
                )[choice.response as 0 | 1 | 4 | 5 | 6 | 7 | 8];
          if (!scope) return;
          const index = scopes.indexOf(scope);
          if (index < 0) scopes.push(scope);
          else scopes.splice(index, 1);
        }
        let grant: Awaited<ReturnType<MusicGrantStore['issue']>>;
        try {
          grant = await service.grants.issue(
            name,
            transport,
            remoteResource ?? service.resource,
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
            detail: `${policy(remoteResource ?? service.resource)}\n\nCopy the credential now. It cannot be shown again.`,
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
          if (remoteResource !== undefined)
            records = records.filter(
              (record) =>
                record.transport === 'rest' &&
                record.resource === remoteResource,
            );
        } catch {
          return;
        }
        if (!current() || !records.length) return;
        const choice = await show({
          type: 'question',
          title: 'Revoke music API client grant',
          message: 'Choose a grant to revoke',
          detail: policy(remoteResource ?? service.resource),
          buttons: [
            ...records.map((r) =>
              remoteResource === undefined
                ? `${r.name} (${r.transport}, ${r.scopes.join(', ') || 'no permissions'})`
                : `${r.name} (${r.transport} at ${r.resource}, ${r.scopes.join(', ') || 'no permissions'})`,
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

function captureConfigUi(context: MenuContext<APIServerConfig>) {
  try {
    const window = context.window,
      contents = window.webContents;
    return () => {
      try {
        return (
          context.window === window &&
          !window.isDestroyed() &&
          window.webContents === contents &&
          !contents.isDestroyed()
        );
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

export async function createRemoteMusicGrantMenu(
  context: MenuContext<APIServerConfig>,
  resolveService: (resource: string) => NativeGrantService | undefined,
  native: MusicNativeActions & {
    promptResource(value: string): Promise<string | null>;
  },
): Promise<MenuTemplate> {
  const config = await context.getConfig();
  const resource = parseRemoteMusicResource(config.musicApiRemoteResource);
  const invalid = async (current: () => boolean) => {
    await native.show({
      type: 'error',
      title: 'Remote REST resource',
      message: 'Enter a canonical remote REST resource URL.',
      detail:
        'Use an exact http:// or https:// URL ending /api/v1/music, without credentials, query or fragment. A loopback or unspecified audience is not allowed.',
      buttons: ['OK'],
    });
    return current();
  };
  return [
    {
      label: 'Enable remote REST access',
      type: 'checkbox',
      checked: config.musicApiRemoteEnabled === true,
      async click(item: { checked: boolean }) {
        const current = captureConfigUi(context);
        const checked = item.checked;
        if (!current()) return;
        try {
          const latest = await context.getConfig();
          if (!current()) return;
          if (
            checked &&
            !parseRemoteMusicResource(latest.musicApiRemoteResource)
          ) {
            await invalid(current);
            return;
          }
          await context.setConfig({ musicApiRemoteEnabled: checked });
          if (current()) await context.refresh();
        } catch {
          /* Retired native UI cannot continue configuration work. */
        }
      },
    },
    {
      label: 'Remote resource URL…',
      async click() {
        const current = captureConfigUi(context);
        if (!current()) return;
        try {
          const before = await context.getConfig();
          if (!current()) return;
          const present = Object.hasOwn(before, 'musicApiRemoteResource'),
            value: unknown = before.musicApiRemoteResource;
          if (value !== undefined && typeof value !== 'string') {
            if (!current()) return;
            await invalid(current);
            return;
          }
          const input = await native.promptResource(value ?? '');
          if (!current() || input === null) return;
          const validated = parseRemoteMusicResource(input);
          if (!validated) {
            await invalid(current);
            return;
          }
          const latest = await context.getConfig();
          if (
            !current() ||
            Object.hasOwn(latest, 'musicApiRemoteResource') !== present ||
            latest.musicApiRemoteResource !== value
          )
            return;
          await context.setConfig({ musicApiRemoteResource: validated });
          if (current()) await context.refresh();
        } catch {
          /* An invoked asynchronous patch is not a compare-and-swap transaction. */
        }
      },
    },
    ...createGrantActions(
      () => (resource === undefined ? undefined : resolveService(resource)),
      native,
      'rest',
      config.enabled === true &&
        config.musicApiEnabled === true &&
        config.musicApiRemoteEnabled === true &&
        resource !== undefined,
      resource,
    ),
  ];
}
