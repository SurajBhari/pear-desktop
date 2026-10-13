import type { DeviceStatus } from './index';

type Sink = string | { type: 'none' };
export type OutputAudioContext = AudioContext & {
  readonly sinkId?: Sink;
  setSinkId?: (sink: Sink) => Promise<void>;
};

type Intent = {
  owner: object | null;
  sink: Sink;
  settled?: (status?: DeviceStatus) => void;
};
type Route = {
  original: Sink;
  applied: Sink;
  desired: Intent;
  running: boolean;
};

// A weak canonical-context slot survives pending stop/restart sink calls.
const routes = new WeakMap<OutputAudioContext, Route>();

export const failureStatus = (error: unknown): DeviceStatus => {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'permission';
  if (name === 'NotFoundError') return 'unavailable';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'failed';
};

const run = async (context: OutputAudioContext, route: Route) => {
  if (route.running) return;
  route.running = true;
  try {
    while (context.state !== 'closed') {
      const intent = route.desired;
      if (route.applied !== intent.sink) {
        try {
          if (typeof context.setSinkId !== 'function')
            throw new DOMException(
              'Sink routing unavailable',
              'NotSupportedError',
            );
          await context.setSinkId(intent.sink);
          route.applied = intent.sink;
          if (route.desired === intent) intent.settled?.();
        } catch (error) {
          if (route.desired === intent) intent.settled?.(failureStatus(error));
        }
      }
      if (route.desired !== intent) continue;
      if (!intent.owner) routes.delete(context);
      break;
    }
  } finally {
    route.running = false;
    if (context.state === 'closed') routes.delete(context);
  }
};

export const routeTo = (
  context: OutputAudioContext,
  owner: object,
  sink: string,
  settled: (status?: DeviceStatus) => void,
) => {
  if (context.state === 'closed') return;
  if (typeof context.setSinkId !== 'function') return settled('unsupported');
  let route = routes.get(context);
  if (!route) {
    const sinkId = context.sinkId;
    const original =
      typeof sinkId === 'string'
        ? sinkId
        : sinkId?.type === 'none'
          ? sinkId
          : '';
    route = {
      original,
      applied: original,
      desired: { owner, sink, settled },
      running: false,
    };
    routes.set(context, route);
  } else {
    if (route.desired.owner === owner && route.desired.sink === sink) return;
    route.desired = { owner, sink, settled };
  }
  run(context, route).catch(() => {});
};

export const releaseRoute = (context: OutputAudioContext, owner: object) => {
  const route = routes.get(context);
  if (!route || route.desired.owner !== owner) return;
  route.desired = { owner: null, sink: route.original };
  // The uncancellable in-flight drain restores the route or applies the next session.
  run(context, route).catch(() => {});
};
