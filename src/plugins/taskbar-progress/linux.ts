import { Message, Variant, sessionBus } from '@jellybrick/dbus-next';

/** Compatibility for desktops supporting the Unity launcher progress protocol. */
export function createLinuxProgress(desktopName: string) {
  let bus: ReturnType<typeof sessionBus> | undefined;
  let failed = false,
    disposed = false;
  const error = () => {
    failed = true;
  };
  const update = (progress: number) => {
    if (disposed || failed) return;
    try {
      if (!bus) {
        bus = sessionBus();
        bus.on('error', error);
      }
      bus.send(
        Message.newSignal(
          '/com/canonical/Unity/LauncherEntry',
          'com.canonical.Unity.LauncherEntry',
          'Update',
          'sa{sv}',
          [
            `application://${desktopName}.desktop`,
            {
              'progress': new Variant('d', Math.max(0, progress)),
              'progress-visible': new Variant('b', progress >= 0),
            },
          ],
        ),
      );
    } catch {
      failed = true;
    }
  };
  return {
    update,
    dispose(clear = true) {
      if (disposed) return;
      if (clear && bus) update(-1);
      disposed = true;
      if (bus) {
        try {
          bus.disconnect();
        } catch {
          /* Already disconnected. */
        }
        bus.removeListener('error', error);
        bus = undefined;
      }
    },
  };
}
