/** Clean-room, reversible page-realm response pruning. Serialized into preload. */
export function setPlayerAdBlocking(owner: string, enabled: boolean): void {
  const key = Symbol.for('pear-desktop.player-ad-blocking');
  type State = {
    owners: Set<string>;
    parse: typeof JSON.parse;
    wrappedParse: typeof JSON.parse;
    json: typeof Response.prototype.json;
    wrappedJson: typeof Response.prototype.json;
    restoreGlobals: () => void;
  };
  const scope = window as unknown as Record<symbol, State | undefined>;
  let state = scope[key];
  if (!enabled) {
    if (!state) return;
    state.owners.delete(owner);
    if (state.owners.size) return;
    // Never remove hooks installed by another plugin after ours.
    if (JSON.parse === state.wrappedParse) JSON.parse = state.parse;
    if (Response.prototype.json === state.wrappedJson)
      Response.prototype.json = state.json;
    state.restoreGlobals();
    delete scope[key];
    return;
  }
  if (state) {
    state.owners.add(owner);
    return;
  }
  const owners = new Set([owner]);
  const prune = (value: unknown): unknown => {
    if (owners.size === 0) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value;
    const response = value as Record<string, unknown>;
    for (const item of [
      response,
      response.playerResponse,
      response.ytInitialPlayerResponse,
    ]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const player = item as Record<string, unknown>;
      Reflect.deleteProperty(player, 'playerAds');
      Reflect.deleteProperty(player, 'adPlacements');
      Reflect.deleteProperty(player, 'adSlots');
    }
    return value;
  };
  const parse = JSON.parse;
  // Preserve identity for restoration; invocation below explicitly supplies this.
  // oxlint-disable-next-line typescript/unbound-method
  const json = Response.prototype.json;
  const wrappedParse: typeof JSON.parse = (...args) => prune(parse(...args));
  const wrappedJson: typeof Response.prototype.json = function (
    this: Response,
  ) {
    return json.call(this).then(prune);
  };
  const globals = window as unknown as Record<string, unknown>;
  const restorers: (() => void)[] = [];
  for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
    const original = Object.getOwnPropertyDescriptor(window, name);
    // Preserve native/third-party accessors and nonconfigurable properties.
    if (original && (!original.configurable || original.get || original.set)) {
      prune(globals[name]);
      continue;
    }
    let value = prune(globals[name]);
    const get = () => value;
    const set = (next: unknown) => {
      value = prune(next);
    };
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: original?.enumerable ?? true,
      get,
      set,
    });
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(window, name)?.get !== get) return;
      if (original) Object.defineProperty(window, name, { ...original, value });
      else {
        Reflect.deleteProperty(window, name);
        if (value !== undefined)
          Object.defineProperty(window, name, {
            value,
            configurable: true,
            enumerable: true,
            writable: true,
          });
      }
    });
  }
  const restoreGlobals = () => {
    for (const restore of restorers) restore();
  };
  state = { owners, parse, json, wrappedParse, wrappedJson, restoreGlobals };
  scope[key] = state;
  JSON.parse = wrappedParse;
  Response.prototype.json = wrappedJson;
}

export const playerAdBlockingScript = (
  owner: string,
  enabled: boolean,
): string =>
  `(${setPlayerAdBlocking.toString()})(${JSON.stringify(owner)}, ${enabled}); 0`;
