import type { NativeGrantService } from '../music-menu';
import type { BrowserWindow } from 'electron';
const targets = new WeakMap<BrowserWindow, NativeGrantService>();
/** Main-only, token-free native target registry. Importing this never loads the SDK. */
export function getMcpGrantTarget(window: BrowserWindow) {
  return targets.get(window);
}
export function publishMcpGrantTarget(
  window: BrowserWindow,
  target: NativeGrantService,
) {
  targets.set(window, target);
}
export function retireMcpGrantTarget(
  window: BrowserWindow,
  target: NativeGrantService,
) {
  if (targets.get(window) === target) targets.delete(window);
}
