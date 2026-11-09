import type { BetterSession } from '@jellybrick/electron-better-web-request';

/** Give Ghostery native teardown semantics for only this engine's listeners. */
export const scopeBlockingSession = (
  session: Electron.Session,
): Electron.Session => {
  const webRequest = (session as BetterSession).webRequest;
  if (
    typeof webRequest.addListener !== 'function' ||
    typeof webRequest.removeListener !== 'function'
  ) {
    throw new Error(
      'Blocklists require the application enhanced webRequest session',
    );
  }
  type Method = 'onHeadersReceived' | 'onBeforeRequest';
  // BetterWebRequest 2.0 passes a URL array when rebinding after removeListener.
  // Electron 42 requires { urls }. Adapt its native delegate only for this
  // invocation; never mutate the session, the library or another listener.
  const nativeRequests = Reflect.get(
    webRequest,
    'webRequest',
  ) as Electron.WebRequest;
  if (!nativeRequests)
    throw new Error('Unsupported enhanced webRequest native delegate');
  const nativeDelegate = new Proxy({} as Electron.WebRequest, {
    get(_, property) {
      const value: unknown = Reflect.get(
        nativeRequests,
        property,
        nativeRequests,
      );
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (
          (property === 'onHeadersReceived' ||
            property === 'onBeforeRequest') &&
          Array.isArray(args[0])
        ) {
          args[0] = { urls: args[0] };
        }
        return Reflect.apply(value, nativeRequests, args) as unknown;
      };
    },
  });
  const removalReceiver = new Proxy(webRequest, {
    get(target, property) {
      if (property === 'webRequest') return nativeDelegate;
      return Reflect.get(target, property, target) as unknown;
    },
  });
  const owned = new Map<Method, Set<string>>();
  const method =
    (event: Method) =>
    (...args: unknown[]) => {
      if (args.length === 0 || args[0] === null) {
        const ids = owned.get(event);
        if (ids)
          for (const id of ids) {
            webRequest.removeListener.call(removalReceiver, event, id);
            ids.delete(id);
          }
        return;
      }
      const listener = typeof args[0] === 'function' ? args[0] : args[1];
      if (typeof listener !== 'function')
        throw new Error(`Missing ${event} blocker listener`);
      const filter =
        typeof args[0] === 'function'
          ? { urls: ['<all_urls>'] }
          : (args[0] as Electron.WebRequestFilter);
      const entry = webRequest.addListener(
        event,
        filter,
        listener as Parameters<typeof webRequest.addListener>[2],
      );
      const ids = owned.get(event) ?? new Set<string>();
      ids.add(entry.id);
      owned.set(event, ids);
    };
  const scopedRequests = new Proxy(webRequest, {
    get(target, property) {
      if (property === 'onHeadersReceived' || property === 'onBeforeRequest')
        return method(property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value.bind(target) as unknown)
        : value;
    },
  });
  // enhanceWebRequest installs a nonconfigurable, readonly webRequest property.
  // A separate facade avoids violating Proxy invariants on the native session.
  return new Proxy({} as Electron.Session, {
    get(_, property) {
      if (property === 'webRequest') return scopedRequests;
      const value: unknown = Reflect.get(session, property, session);
      // Electron's native Session methods require their original receiver.
      return typeof value === 'function'
        ? (value.bind(session) as unknown)
        : value;
    },
  });
};
