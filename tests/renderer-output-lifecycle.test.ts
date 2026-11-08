import { test, expect } from '@playwright/test';

import { RendererOutput } from '../src/providers/renderer-output';

function fixture() {
  const events: string[] = [],
    nodes: any[] = [],
    loads: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const context: any = {
    currentTime: 1,
    state: 'running',
    audioWorklet: {
      addModule: () =>
        new Promise<void>((resolve, reject) => loads.push({ resolve, reject })),
    },
  };
  class Node {
    edges = new Set<any>();
    gain = {
      value: 1,
      cancelScheduledValues() {},
      setValueAtTime(value: number) {
        this.value = value;
      },
    };
    constructor(public name: string) {}
    connect(target: any) {
      this.edges.add(target);
      events.push(this.name + '->' + target.name);
      if (context.failConnection === this.name) throw Error('partial connect');
      return target;
    }
    disconnect(target?: any) {
      if (target) this.edges.delete(target);
      else this.edges.clear();
    }
  }
  context.createWaveShaper = () => new Node('fault-guard');
  const input: any = new Node('input'),
    master: any = new Node('master'),
    gate: any = new Node('gate');
  input.connect(gate);
  const saved = globalThis.AudioWorkletNode;
  class Worklet extends Node {
    onprocessorerror: (() => void) | null = null;
    port = {
      onmessage: null as ((event: any) => void) | null,
      closed: false,
      messages: [] as any[],
      postMessage(data: any) {
        this.messages.push(data);
      },
      close() {
        this.closed = true;
      },
    };
    constructor() {
      if (context.failConstructor) throw Error('constructor failed');
      super('processor');
      nodes.push(this);
    }
  }
  globalThis.AudioWorkletNode = Worklet as any;
  const output = new RendererOutput(context, input, master, gate);
  output.unmute();
  return {
    context,
    input,
    master,
    gate,
    events,
    nodes,
    loads,
    output,
    wet: (name = 'wet') => new Node(name) as any,
    close: () => {
      output.close();
      globalThis.AudioWorkletNode = saved;
    },
  };
}

test('output module failure preserves dry/EQ and permits a later clean registration', async () => {
  const f = fixture();
  try {
    const wet = f.wet();
    let failures = 0;
    const lease = f.output.registerWet(wet, () => failures++);
    f.loads[0].reject(Error('module failure'));
    expect(await lease.ready).toBe(false);
    expect(failures).toBe(1);
    expect(wet.edges.size).toBe(0);
    expect([...f.input.edges].some((n: any) => n.name === 'fault-guard')).toBe(
      true,
    );
    const next = f.output.registerWet(f.wet('next'), () => {});
    f.loads[1].resolve();
    expect(await next.ready).toBe(true);
    next.release();
  } finally {
    f.close();
  }
});
for (const failure of ['constructor', 'connection'])
  test(`output ${failure} failure rolls back before dry bypass`, async () => {
    const f = fixture();
    try {
      const wet = f.wet();
      let failed = false;
      const lease = f.output.registerWet(wet, () => {
        failed = true;
        expect(wet.gain.value).toBe(0);
        expect(wet.edges.has(f.master)).toBe(false);
      });
      if (failure === 'constructor') f.context.failConstructor = true;
      else f.context.failConnection = 'processor';
      f.loads[0].resolve();
      expect(await lease.ready).toBe(false);
      expect(failed).toBe(true);
      expect(
        [...f.input.edges].some((n: any) => n.name === 'fault-guard'),
      ).toBe(true);
      for (const node of f.nodes) {
        expect(node.port.closed).toBe(true);
        expect(node.edges.size).toBe(0);
      }
    } finally {
      f.close();
    }
  });

test('runtime error cuts every wet edge before bypass and stale handlers cannot change a replacement', async () => {
  const f = fixture();
  try {
    const a = f.wet('a'),
      b = f.wet('b');
    let callbacks = 0;
    const failure = () => {
      callbacks++;
      expect(a.gain.value).toBe(0);
      expect(b.gain.value).toBe(0);
      expect(a.edges.has(f.master)).toBe(false);
      expect(b.edges.has(f.master)).toBe(false);
      expect(f.input.edges.has(f.gate)).toBe(false);
    };
    const leaseA = f.output.registerWet(a, failure),
      leaseB = f.output.registerWet(b, failure);
    f.loads[0].resolve();
    expect(await leaseA.ready).toBe(true);
    expect(await leaseB.ready).toBe(true);
    const old = f.nodes[0],
      stale = old.onprocessorerror;
    old.onprocessorerror();
    expect(callbacks).toBe(2);
    expect([...f.input.edges].some((n: any) => n.name === 'fault-guard')).toBe(
      true,
    );
    expect(old.port.closed).toBe(true);
    const cancelled = f.output.registerWet(f.wet('cancelled'), () => {});
    cancelled.release();
    expect(await cancelled.ready).toBe(false);
    expect(f.input.edges.size).toBe(1);
    expect([...f.input.edges][0].name).toBe('fault-guard');
    const replacement = f.wet('replacement'),
      next = f.output.registerWet(replacement, () => {});
    expect(await next.ready).toBe(true);
    stale();
    expect(replacement.edges.has(f.master)).toBe(true);
    expect(f.input.edges.has(f.gate)).toBe(false);
    next.release();
  } finally {
    f.close();
  }
});

test('partially attached wet output is zeroed and disconnected before its failure callback', async () => {
  const f = fixture();
  try {
    const wet = f.wet();
    f.context.failConnection = 'wet';
    let failed = false;
    const lease = f.output.registerWet(wet, () => {
      failed = true;
      expect(wet.gain.value).toBe(0);
      expect(wet.edges.has(f.master)).toBe(false);
    });
    f.loads[0].resolve();
    expect(await lease.ready).toBe(false);
    expect(failed).toBe(true);
    expect(f.input.edges.has(f.nodes[0])).toBe(true);
  } finally {
    f.close();
  }
});

test('cancelled registration cannot install a late processor and context close disposes renderer ownership', async () => {
  const f = fixture();
  try {
    const lease = f.output.registerWet(f.wet(), () => {});
    lease.release();
    f.loads[0].resolve();
    expect(await lease.ready).toBe(false);
    expect(f.nodes.length).toBe(0);
    const next = f.output.registerWet(f.wet(), () => {});
    expect(await next.ready).toBe(true);
    next.release();
    expect(f.nodes[0].port.closed).toBe(false);
    f.context.state = 'closed';
    f.output.close();
    expect(f.nodes[0].port.closed).toBe(true);
  } finally {
    f.close();
  }
});

test('mute is immediate; only the latest fresh-buffer token can reopen after rapid mute/unmute', async () => {
  const f = fixture();
  try {
    const lease = f.output.registerWet(f.wet(), () => {});
    f.loads[0].resolve();
    await lease.ready;
    const node = f.nodes[0];
    f.output.mute();
    expect(f.gate.gain.value).toBe(0);
    f.output.unmute();
    const first = node.port.messages.at(-1).token;
    f.output.mute();
    f.output.unmute();
    const latest = node.port.messages.at(-1).token;
    node.port.onmessage({
      data: { type: 'flush-ready', token: first, readyAt: 1.004 },
    });
    expect(f.gate.gain.value).toBe(0);
    node.port.onmessage({
      data: { type: 'flush-ready', token: latest, readyAt: 1.004 },
    });
    expect(f.gate.gain.value).toBe(1);
    lease.release();
  } finally {
    f.close();
  }
});

test('synchronous module registration failure revokes its owned URL and the next genuine owner retries', async () => {
  const f = fixture(),
    original = URL.revokeObjectURL;
  let revoked = 0;
  URL.revokeObjectURL = (url) => {
    revoked++;
    original(url);
  };
  try {
    const add = f.context.audioWorklet.addModule;
    f.context.audioWorklet.addModule = () => {
      throw Error('synchronous module registration');
    };
    const lease = f.output.registerWet(f.wet(), () => {});
    expect(await lease.ready).toBe(false);
    expect(revoked).toBe(1);
    f.context.audioWorklet.addModule = add;
    const next = f.output.registerWet(f.wet(), () => {});
    expect(f.loads.length).toBe(1);
    f.loads[0].resolve();
    expect(await next.ready).toBe(true);
    next.release();
  } finally {
    URL.revokeObjectURL = original;
    f.close();
  }
});
