import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { test, expect } from '@playwright/test';

// Evaluate only selected production declarations. No project entry, Hono, HTTP
// helper, socket, server, Electron, dependency build or real timer is imported.
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const section = (source: string, start: string, end: string) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last <= first)
    throw Error(`Missing source boundary: ${start}`);
  return source.slice(first, last);
};
const service = read('src/plugins/api-server/backend/music-service.ts');
const policy = read('src/plugins/api-server/backend/music-http-policy.ts');
const routes = read('src/plugins/api-server/backend/routes/music.ts');
const types = read('src/plugins/api-server/music-types.ts');
const grants = read('src/plugins/api-server/backend/music-grants.ts');
const fixture = read('tests/helpers/api-music-remote-http.ts');
const methods = [
  section(service, '  get enabled() {', '  get resource() {'),
  section(service, '  get resource() {', '  restAvailable('),
  section(service, '  restAvailable(', '  captureNativeOwner('),
  section(service, '  captureNativeOwner(', '  /** Exact main-owned session'),
  section(service, '  configure(config:', '  stop() {'),
  section(
    service,
    '  private sharedAvailable() {',
    '  /** Capture one REST listener',
  ),
  section(service, '  private restAccess(', '  private accessOwner('),
].join('\n');
const program = stripTypeScriptTypes(
  `
${section(types, 'export const MUSIC_LIMITS', 'export const MUSIC_SCOPES')}
${section(types, 'const messages:', 'export const utf8Bytes')}
${section(grants, 'const tokenValid =', 'const digestToken')}
${section(grants, 'export function parseMusicBearer', 'export function parseMusicGrantRecord')}
const policy = (() => {
  ${policy.slice(policy.indexOf('const prefix ='))}
  return {musicHttpResources,musicHttpListenerSupports,musicHttpPolicy,isMusicHttpNamespace,localMusicHttpResource,MusicHttpFailure};
})();
const {musicHttpResources,musicHttpListenerSupports,musicHttpPolicy,isMusicHttpNamespace,localMusicHttpResource,MusicHttpFailure}=policy;
const localMusicResource=config=>localMusicHttpResource(config);
class IsolatedService {
  constructor(config,runtime,broker,grants){
    this.config={...config};this.runtime=runtime;this.broker=broker;this.grants=grants;
    this.stopped=false;this.revision=0;this.accessIdentity={};this.scope=new AbortController();
    this.cursors=new Map();this.references=new Map();this.operations={retire(){}};
  }
  ${methods}
}
const registerMusicRoutes = (() => {
  ${routes.slice(routes.indexOf('const prefix ='))}
  return registerMusicRoutes;
})();
globalThis.createModel = (bindAddress,tls) => {
  const port=32123,address={address:bindAddress},membership=new WeakSet(),server={listening:true};
  let owner,epoch=new AbortController(),selectedService;
  const config={enabled:true,musicApiEnabled:true,hostname:bindAddress,port,useHttps:tls,
    certPath:tls?'inert-cert':'',keyPath:tls?'inert-key':'',musicApiRemoteEnabled:true,
    musicApiRemoteResource:(tls?'https':'http')+'://music-http.fixture.invalid:'+port+'/api/v1/music'};
  const calls={authorize:0,operation:0,subscriptions:0};
  const hooks={};const observers=new Set();let grantActive=true;
  const token='pdm_'+Buffer.alloc(32,1).toString('base64url');
  const principal={scopes:['playback.read']};
  const store={
    async authorize(received,transport,resource,scope){
      calls.authorize++;await hooks.authorize?.();
      if(received!==token)throw new MusicServiceError('unauthorized');
      if(transport!=='rest'||resource!==config.musicApiRemoteResource||scope!=='playback.read')throw new MusicServiceError('forbidden');
      return principal;
    },
    isCurrent(){return grantActive&&(hooks.grantCurrent?.()??true);},
    subscribe(callback){observers.add(callback);calls.subscriptions++;return()=>{observers.delete(callback);calls.subscriptions--;};},
  };
  const admission={};
  const broker={capture:()=>admission,isCurrent:value=>value===admission&&(hooks.brokerCurrent?.()??true)};
  const service=new IsolatedService(config,{restListenerOwner:()=>owner},broker,store);
  selectedService=service;
  ${section(fixture, '  const publish = (reconfigure = true) => {', '  publish();')}
  publish();
  service.currentFor=async(invocation,deadline)=>{
    calls.operation++;
    if(invocation.transport!=='rest'||invocation.resource!==config.musicApiRemoteResource||deadline!==6000)throw Error('Wrong enabled invocation');
    return await hooks.operation?.(invocation)??{version:1,current:null};
  };
  let middleware;
  registerMusicRoutes({use(pattern,handler){if(pattern!=='*'||middleware)throw Error('Unexpected registration');middleware=handler;}},
    ()=>selectedService,incoming=>owner?.ownsSocket(incoming.socket)?owner:undefined);
  return {config,service,calls,hooks,publish,owner:()=>owner,
    revoke(){grantActive=false;for(const observer of observers)observer();},
    removeService(){selectedService=undefined;},
    async request(options={}){
      const socket={remoteAddress:bindAddress,localAddress:bindAddress,localPort:port,encrypted:tls};
      if(options.owned!==false)membership.add(socket);
      const incoming=Object.assign(new EventEmitter(),{url:'/api/v1/music/current',socket,headers:{},
        rawHeaders:['Host','music-http.fixture.invalid:'+port,'Authorization','Bearer '+token,...(options.headers??[])]});
      if(options.token!==undefined)incoming.rawHeaders[3]='Bearer '+options.token;
      const outgoing=Object.assign(new EventEmitter(),{writableFinished:false});
      const headers={};
      const context={env:options.bindings===false?{}:{incoming,outgoing},
        req:{path:incoming.url,method:options.method??'GET'},
        header(name,value){headers[name.toLowerCase()]=value;},
        json(body,status=200){return {status,body,headers};}};
      const response=await middleware(context,()=>{throw Error('Unexpected downstream middleware');});
      if(incoming.listenerCount('aborted')||outgoing.listenerCount('close'))throw Error('Route listeners retained');
      return response;
    },
  };
};
`.replace(/\bexport /g, ''),
  { mode: 'transform', sourceUrl: 'inert-http-availability.ts' },
);

interface InertModel {
  config: {
    enabled: boolean;
    musicApiEnabled: boolean;
    musicApiRemoteEnabled: boolean;
  };
  service: { enabled: boolean; stopped: boolean };
  calls: { authorize: number; operation: number; subscriptions: number };
  hooks: { authorize?: () => void; operation?: () => unknown };
  owner(): { signal: AbortSignal; identity: object; current: () => boolean };
  publish(): void;
  revoke(): void;
  removeService(): void;
  request(options?: {
    bindings?: boolean;
    owned?: boolean;
    headers?: string[];
    token?: string;
    method?: string;
  }): Promise<{
    status: number;
    body: { error?: { code: string }; version?: number; current?: null };
    headers: Record<string, string>;
  }>;
}

function model(address = '192.0.2.10', tls = false) {
  const timers = new Map<object, () => void>();
  const context = vm.createContext(
    {
      URL,
      URLSearchParams,
      Buffer,
      AbortController,
      AbortSignal,
      EventEmitter,
      WebAssembly: undefined,
      Date: class {
        static now() {
          return 1000;
        }
      },
      isIP(value: unknown) {
        if (typeof value !== 'string') return 0;
        const parts = value.split('.');
        return parts.length === 4 &&
          parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && +p <= 255)
          ? 4
          : 0;
      },
      setTimeout(callback: () => void) {
        const timer = { unref() {} };
        timers.set(timer, callback);
        return timer;
      },
      clearTimeout(timer: object) {
        timers.delete(timer);
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  vm.runInContext(program, context, { timeout: 1000 });
  expect(
    vm.runInContext(
      'typeof require+":"+typeof process+":"+typeof fetch+":"+typeof WebAssembly',
      context,
    ),
  ).toBe('undefined:undefined:undefined:undefined');
  const createModel = vm.runInContext('createModel', context) as unknown as (
    address: string,
    tls: boolean,
  ) => InertModel;
  const result = createModel(address, tls);
  return Object.assign(result, {
    assertClean() {
      expect(timers.size).toBe(0);
      expect(result.calls.subscriptions).toBe(0);
    },
  });
}

for (const address of ['127.0.0.1', '192.0.2.10']) {
  for (const tls of [false, true]) {
    test(`disabled remote audience is forbidden on ${address} ${tls ? 'TLS metadata' : 'HTTP metadata'}`, async () => {
      const f = model(address, tls);
      const old = f.owner();
      f.config.musicApiRemoteEnabled = false;
      f.publish();
      expect(old.signal.aborted).toBe(true);
      expect(old.identity).not.toBe(f.owner().identity);
      expect(f.service.enabled).toBe(address === '127.0.0.1');
      const response = await f.request();
      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('forbidden');
      expect(response.headers).toEqual({ 'cache-control': 'no-store' });
      expect(f.calls.authorize).toBe(0);
      expect(f.calls.operation).toBe(0);
      f.assertClean();
    });
    test(`enabled owned current dispatches exactly once on ${address} ${tls ? 'TLS metadata' : 'HTTP metadata'}`, async () => {
      const f = model(address, tls);
      const response = await f.request();
      expect(response).toEqual({
        status: 200,
        body: { version: 1, current: null },
        headers: { 'cache-control': 'no-store' },
      });
      expect(f.calls.authorize).toBe(1);
      expect(f.calls.operation).toBe(1);
      f.assertClean();
    });
  }
}

for (const guard of [
  'global',
  'feature',
  'stopped',
  'stale',
  'bindings',
  'unowned',
  'missing-service',
]) {
  test(`unavailable ${guard} does not authorize or dispatch`, async () => {
    const f = model();
    if (guard === 'global') {
      f.config.enabled = false;
      f.publish();
    }
    if (guard === 'feature') {
      f.config.musicApiEnabled = false;
      f.publish();
    }
    if (guard === 'stopped') f.service.stopped = true;
    if (guard === 'stale') f.owner().current = () => false;
    if (guard === 'missing-service') f.removeService();
    const response = await f.request({
      bindings: guard !== 'bindings',
      owned: guard !== 'unowned',
    });
    expect(response.status).toBe(503);
    expect(f.calls.authorize).toBe(0);
    expect(f.calls.operation).toBe(0);
    f.assertClean();
  });
}

for (const headers of [
  ['Host', 'forged.invalid:32123'],
  ['Origin', 'https://forged.invalid'],
  ['Forwarded', 'for=192.0.2.1'],
  ['X-Forwarded-Host', 'forged.invalid'],
]) {
  test(`owned policy rejects ${headers[0]} before authorization`, async () => {
    const f = model();
    expect((await f.request({ headers })).status).toBe(403);
    expect(f.calls.authorize).toBe(0);
    expect(f.calls.operation).toBe(0);
    f.assertClean();
  });
}

test('enabled token and method failures preserve zero operation dispatch', async () => {
  const f = model();
  expect((await f.request({ token: 'malformed' })).status).toBe(401);
  expect(f.calls.authorize).toBe(0);
  expect(
    (
      await f.request({
        token: 'pdm_' + Buffer.alloc(32, 2).toString('base64url'),
      })
    ).status,
  ).toBe(401);
  expect(f.calls.authorize).toBe(1);
  expect((await f.request({ method: 'OPTIONS' })).status).toBe(405);
  expect(f.calls.operation).toBe(0);
  f.assertClean();
});

test('reentrant listener replacement cannot authorize the old request', async () => {
  const f = model();
  const old = f.owner(),
    current = old.current;
  let armed = true;
  old.current = () => {
    if (armed) {
      armed = false;
      f.publish();
    }
    return current();
  };
  expect((await f.request()).status).toBe(503);
  expect(f.calls.authorize).toBe(0);
  expect(f.calls.operation).toBe(0);
  f.assertClean();
});

test('reconfiguration during authorization retires the request before operation dispatch', async () => {
  const f = model();
  f.hooks.authorize = () => {
    f.publish();
  };
  expect((await f.request()).status).toBe(409);
  expect(f.calls.authorize).toBe(1);
  expect(f.calls.operation).toBe(0);
  f.assertClean();
});

for (const retire of ['configure', 'revoke']) {
  test(`in-flight ${retire} rejects the old operation result`, async () => {
    const f = model();
    let entered!: () => void, settle!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.hooks.operation = () => {
      entered();
      return new Promise((resolve) => {
        settle = () => resolve({ version: 1, current: null });
      });
    };
    const response = f.request();
    await started;
    if (retire === 'configure') f.publish();
    else f.revoke();
    expect((await response).status).toBe(409);
    settle();
    expect(f.calls.authorize).toBe(1);
    expect(f.calls.operation).toBe(1);
    f.assertClean();
  });
}
