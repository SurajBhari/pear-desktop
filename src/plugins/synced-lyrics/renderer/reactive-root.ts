import { createRoot, getOwner } from 'solid-js';

let dispose: (() => void) | undefined;

export let reactiveOwner = createRoot((disposeRoot) => {
  dispose = disposeRoot;
  return getOwner()!;
});

export const ensureReactiveRoot = () => {
  if (!dispose)
    reactiveOwner = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return getOwner()!;
    });
  return reactiveOwner;
};

export const disposeReactiveRoot = () => {
  dispose?.();
  dispose = undefined;
};
