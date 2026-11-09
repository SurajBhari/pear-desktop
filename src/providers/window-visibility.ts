import type { BrowserWindow } from 'electron';

type VisibilityMethod = 'show' | 'showInactive' | 'hide';
interface MethodLease {
  method: VisibilityMethod;
  previous: PropertyDescriptor | undefined;
  installed: PropertyDescriptor;
}

/** Reveal an eligible startup window without waiting indefinitely for remote paint. */
export const setupInitialWindowVisibility = (
  win: BrowserWindow,
  mayShow: () => boolean,
  fallbackDelay = 500,
): (() => void) => {
  if (win.isDestroyed() || win.isVisible()) return () => {};
  let active = true;
  let fallbackSafe = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const methods: MethodLease[] = [];
  const ownsMethod = (lease: MethodLease) => {
    const current = Object.getOwnPropertyDescriptor(win, lease.method);
    return (
      current?.value === lease.installed.value &&
      current?.configurable === lease.installed.configurable &&
      current?.enumerable === lease.installed.enumerable &&
      current?.writable === lease.installed.writable
    );
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    win.removeListener('ready-to-show', reveal);
    win.removeListener('show', dispose);
    win.removeListener('closed', dispose);
    for (const lease of methods.splice(0).reverse()) {
      if (!ownsMethod(lease)) continue;
      if (lease.previous)
        Object.defineProperty(win, lease.method, lease.previous);
      else Reflect.deleteProperty(win, lease.method);
    }
  };
  const reveal = () => {
    if (!active) return;
    try {
      if (
        !win.isDestroyed() &&
        !win.isVisible() &&
        methods.every(ownsMethod) &&
        mayShow() &&
        active &&
        !win.isDestroyed() &&
        !win.isVisible() &&
        methods.every(ownsMethod)
      ) {
        win.show();
      }
    } finally {
      dispose();
    }
  };
  win.once('ready-to-show', reveal);
  win.once('show', dispose);
  win.once('closed', dispose);
  // Some native backends settle visibility without emitting show. Retire the
  // initial request before delegating explicit per-window presentation calls.
  for (const method of ['show', 'showInactive', 'hide'] as const) {
    if (!active) break;
    const previous = Object.getOwnPropertyDescriptor(win, method);
    const native = win[method];
    if (!active) break;
    if (typeof native !== 'function') continue;
    const wrapper = function (this: BrowserWindow, ...args: unknown[]) {
      dispose();
      const result: unknown = Reflect.apply(native, this, args);
      return result;
    };
    const installed: PropertyDescriptor = {
      configurable: previous?.configurable ?? true,
      enumerable: previous?.enumerable ?? false,
      writable: 'value' in (previous ?? {}) ? previous?.writable : true,
      value: wrapper,
    };
    try {
      Object.defineProperty(win, method, installed);
      methods.push({ method, previous, installed });
    } catch {
      // An unreplaceable foreign method cannot be observed safely. Preserve
      // its ownership and the old ready-to-show path, but omit the new timer.
      fallbackSafe = false;
    }
  }
  if (active && fallbackSafe && !win.isDestroyed() && !win.isVisible())
    timer = setTimeout(reveal, fallbackDelay);
  else if (!active || win.isDestroyed() || win.isVisible()) dispose();
  return dispose;
};
