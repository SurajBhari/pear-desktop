/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';
import { startCrossfadeFixture } from './helpers/crossfade-native';
import { reverbNativeSource } from './helpers/reverb-native-source';

// Only the existing matching-parameter receipt utility; no separate stress renderer/bundle.
const receiptSource = reverbNativeSource.slice(
  0,
  reverbNativeSource.indexOf('export async function renderReverbStress'),
);
const source =
  receiptSource +
  String.raw`
import {getCurrentAudioGraph,graphFromAnnouncement} from '@/providers/renderer-audio';
export async function setupCrossfadeComposition({main,graph,context,analyser,aux},options){
  if(getCurrentAudioGraph()!==graph||graphFromAnnouncement({audioContext:context,audioSource:graph.audioSource})!==graph)throw Error('Provider identity split');
  const c={graph,context,main,aux,receipts:[],flushes:[],ready:[],ports:[],sourceEdges:new Set([graph.dryInput]),wetRoutes:new Set(),admissions:[],counts:[],edgeLive:false,listenerOrder:[]};
  window.composition=c;
  c.wait=async(predicate)=>{const deadline=performance.now()+5000;for(;;){if(performance.now()>=deadline)throw Error('Owned composition readiness timeout');if(predicate())return;if(context.state!=='running')throw Error('Owned clock stopped');await new Promise(r=>setTimeout(r,1));}};
  c.ramp=async()=>{const end=c.wet.wetEnvelope.end;await c.wait(()=>context.currentTime>=end);};
  c.frames=async(n)=>{const end=context.currentTime+n/context.sampleRate;await c.wait(()=>context.currentTime>=end);};
  const add=main.addEventListener.bind(main);let constructing='test';
  main.addEventListener=(name,...args)=>{if(name==='volumechange')c.listenerOrder.push(constructing);return add(name,...args);};
  const connect=graph.audioSource.connect.bind(graph.audioSource),disconnect=graph.audioSource.disconnect.bind(graph.audioSource);
  graph.audioSource.connect=(node,...args)=>{const result=connect(node,...args);c.sourceEdges.add(node);return result;};
  graph.audioSource.disconnect=(node,...args)=>{const result=disconnect(node,...args);if(node)c.sourceEdges.delete(node);else c.sourceEdges.clear();return result;};
  const registerWet=graph.registerWetOutput.bind(graph);
  graph.registerWetOutput=(gain,...args)=>{const con=gain.connect.bind(gain),dis=gain.disconnect.bind(gain);gain.connect=(target,...rest)=>{const result=con(target,...rest);if(target===graph.masterInput)c.wetRoutes.add(gain);return result;};gain.disconnect=(target,...rest)=>{const result=target?dis(target,...rest):dis();if(!target||target===graph.masterInput)c.wetRoutes.delete(gain);return result;};return registerWet(gain,...args);};
  const Native=window.AudioWorkletNode;
  window.AudioWorkletNode=class extends Native{constructor(ctx,name,settings){super(ctx,name,settings);const owned={node:this,name,closed:false,disposed:false};c.ports.push(owned);const post=this.port.postMessage.bind(this.port),close=this.port.close.bind(this.port);this.port.close=()=>{owned.closed=true;return close();};this.port.postMessage=(message,...rest)=>{if(message.type==='dispose')owned.disposed=true;if(message.type==='flush')c.flushes.push({token:message.token,time:ctx.currentTime,gate:graph.musicGate.gain.value});return post(message,...rest);};if(name==='renderer-output-peak'){this.port.addEventListener('message',event=>{if(event.data?.type==='flush-ready')c.ready.push({...event.data,time:ctx.currentTime});});this.port.start();}}};
  const addModule=context.audioWorklet.addModule.bind(context.audioWorklet);
  context.audioWorklet.addModule=async(url)=>{const raw=await fetch(url).then(r=>r.text());if(!raw.includes("registerProcessor('dattorro-reverb'"))return addModule(url);const body=DATTORRO_WORKLET_SOURCE.replace("registerProcessor('dattorro-reverb', DattorroReverbProcessor);", "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams'&&data.fixtureToken!==undefined)this.port.postMessage({type:'fixture-params-ready',token:data.fixtureToken,appliedAt:this.t,params:{preDelay:this.predelay,preFilter:this.preFilterAmt,inputDiff1:this.inputDiff1Amt,inputDiff2:this.inputDiff2Amt,decayDiff1:this.decayDiff1Amt,decay:this.decayAmt,damping:this.dampingAmt,wetGain:this.wetGain}})}};registerProcessor('dattorro-reverb',Ready);");const replacement=URL.createObjectURL(new Blob([body],{type:'application/javascript'}));try{return await addModule(replacement);}finally{URL.revokeObjectURL(replacement);}};
  const makeEQ=()=>{constructing='eq';c.eq=new EqualizerController(graph);c.eq.apply({mode:'custom',preamp:0,bands:[{id:'boost',type:'peaking',frequency:1000,gain:36,Q:1}]},false,true);};
  if(options.eq&&options.eqFirst)makeEQ();
  constructing='wet';c.wet=createSlowedReverbController();c.wet.ctx={getConfig:()=>c.wet.config,setConfig:()=>{}};c.wet.config={active:true,slow:1,reverbIntensity:1,wetHighpass:180,wetLowpass:6500};
  try{c.wet.wireAudio(context,graph.audioSource);await c.wet.ensureWorklet();if(!c.wet.reverbNode||!(await c.wet.wetOutput.ready))throw Error('Wet/output not admitted');c.receipts.push(await acknowledgeReverbFixtureParams(c.wet));await c.ramp();}finally{window.AudioWorkletNode=Native;}
  if(options.eq&&!options.eqFirst)makeEQ();constructing='test';
  c.control=async(change)=>{let timer;await new Promise((resolve,reject)=>{const receive=()=>{clearTimeout(timer);resolve();};main.addEventListener('volumechange',receive,{once:true});timer=setTimeout(()=>{main.removeEventListener('volumechange',receive);reject(Error('Owned volume event missing'));},5000);change();});};
  if(options.eq){await c.control(()=>{main.volume=.03;});c.beforeAdmission=c.eq.getResponse().effectivePreampDb;}
  c.eqState=()=>c.eq?{target:c.eq.getResponse().effectivePreampDb,chains:[...c.eq.chains].map(chain=>chain.preampDb)}:null;
  let ever=false;const register=graph.registerMedia.bind(graph);graph.registerMedia=(...args)=>{const output=args[2]??args[1],con=output.connect.bind(output),dis=output.disconnect.bind(output);c.chain={element:args[0],user:args[1],output};output.connect=(target,...rest)=>{if(target===graph.dryInput)c.admissions.push({count:graph.auxiliaryMediaCount,eq:c.eqState(),edgeLive:c.edgeLive});const result=con(target,...rest);if(target===graph.dryInput)c.edgeLive=true;return result;};output.disconnect=(target,...rest)=>{const result=target?dis(target,...rest):dis();if(!target||target===graph.dryInput)c.edgeLive=false;return result;};return register(...args);};
  c.releaseCount=graph.observeAuxiliaryMedia(count=>{if(count)ever=true;c.counts.push({count,ever,edgeLive:c.edgeLive,eq:c.eqState()});});
  const captureSource="class Capture extends AudioWorkletProcessor{constructor(){super();this.pending=null;this.port.onmessage=e=>{const d=e.data;if(d.type==='capture')this.pending={token:d.token,frames:d.frames,start:null,data:[[],[]]};};}process(inputs,outputs){for(const channel of outputs[0]??[])channel.fill(0);const p=this.pending;if(!p)return true;if(p.start===null)p.start=currentFrame;const input=inputs[0];for(let i=0;i<(outputs[0]?.[0]?.length??128)&&p.data[0].length<p.frames;i++){p.data[0].push(input?.[0]?.[i]??0);p.data[1].push(input?.[1]?.[i]??input?.[0]?.[i]??0);}if(p.data[0].length===p.frames){this.port.postMessage({token:p.token,start:p.start,end:p.start+p.frames,data:p.data});this.pending=null;}return true;}}registerProcessor('composition-capture',Capture);";
  const url=URL.createObjectURL(new Blob([captureSource],{type:'application/javascript'}));try{await context.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
  const tap=bus=>{const node=new Native(context,'composition-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});bus.connect(node);node.connect(context.destination);let token=0;return {node,capture:frames=>{if(frames<128||frames>65536)throw Error('Unbounded capture');return new Promise((resolve,reject)=>{const id=++token;const receive=event=>{if(event.data.token!==id)return;clearTimeout(timer);node.port.removeEventListener('message',receive);const data=event.data;let peak=0,finite=true;for(const channel of data.data)for(const value of channel){finite&&=Number.isFinite(value);peak=Math.max(peak,Math.abs(value));}resolve({start:data.start,end:data.end,frames,peak,finite});};const timer=setTimeout(()=>{node.port.removeEventListener('message',receive);reject(Error('Owned PCM capture timeout'));},5000);node.port.addEventListener('message',receive);node.port.start();node.port.postMessage({type:'capture',token:id,frames});});}};};
  c.final=tap(graph.musicGate);c.pre=tap(graph.outputInput);c.pair=async(frames=1024)=>{const [final,pre]=await Promise.all([c.final.capture(frames),c.pre.capture(frames)]);return {final,pre};};
  c.setIntensity=async value=>{c.wet.onConfigChange({...c.wet.config,reverbIntensity:value});if(value){await c.wet.ensureWorklet();await c.wet.wetOutput.ready;c.receipts.push(await acknowledgeReverbFixtureParams(c.wet));await c.ramp();}};
  c.close=async()=>{c.releaseCount();c.wet.stop();c.eq?.stop();c.final.node.disconnect();c.pre.node.disconnect();};
}
`;

async function start(page: any, settings: Record<string, unknown> = {}) {
  const stress = settings.stress === true;
  await startCrossfadeFixture(page, {
    sourceExports: source,
    beforeArmExport: 'setupCrossfadeComposition',
    setupOptions: settings,
    ...(stress ? { waveAmplitude: 0.99, mainVolume: 1 } : {}),
    ...(settings.eq ? { mainVolume: 1 } : {}),
    config: { fadeScaling: 'equalPower' },
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
}
const ceiling = Math.fround(0.99);
function protectedPCM(rows: any[]) {
  for (const row of rows) {
    expect(row.final.finite).toBe(true);
    expect(row.final.peak).toBeLessThanOrEqual(ceiling);
  }
}
async function close(page: any) {
  await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture,
      c = (window as any).composition;
    f.renderer.stop();
    await c.close();
    await f.context.close();
  });
}

test('composition actual outgoing tail with main wet engages a nonvacuous final PCM ceiling', async ({
  page,
}) => {
  await start(page, { stress: true });
  const result = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture,
      c = (window as any).composition,
      original = f.aux[0],
      rows = [];
    for (let i = 0; i < 35; i++) {
      const pcm = await c.pair();
      rows.push({
        ...pcm,
        tail: f.power(500),
        incoming: f.power(1000),
        opening: f.power(750),
        time: original.currentTime,
        same: f.aux[0] === original,
        count: f.graph.auxiliaryMediaCount,
      });
    }
    return {
      rows,
      requests: f.requests,
      nexts: f.nexts,
      registered: f.aux.length,
      master: f.graph.masterInput.gain.value,
      wetOnlyMain:
        c.wet.audioSource === f.graph.audioSource &&
        c.wet.wiredSource === f.graph.audioSource &&
        c.wet.wetVolumeMedia === f.main,
      wetRoutes: c.wetRoutes.size,
      wetSourceEdge: c.sourceEdges.has(c.wet.wetInput),
      receipts: c.receipts,
    };
  });
  protectedPCM(result.rows);
  expect(Math.max(...result.rows.map((r) => r.pre.peak))).toBeGreaterThan(0.99);
  const qualified = result.rows.filter(
    (r) => r.count === 1 && r.incoming > 0.003 && r.tail > 0.003,
  );
  expect(qualified.length).toBeGreaterThan(3);
  expect(
    qualified.every(
      (r) =>
        r.same && r.time > 3 && r.opening < Math.max(r.tail, r.incoming) * 0.15,
    ),
  ).toBe(true);
  expect(result).toMatchObject({
    requests: 1,
    nexts: 1,
    registered: 1,
    master: 1,
    wetOnlyMain: true,
    wetRoutes: 1,
    wetSourceEdge: true,
  });
  expect(result.receipts[0].expected).toEqual(result.receipts[0].applied);
  await close(page);
});

test('composition admitted outgoing obeys mute zero and matching fresh-buffer recovery', async ({
  page,
}) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture,
      c = (window as any).composition,
      contextTime = () => f.context.currentTime,
      original = f.aux[0],
      rows = [];
    for (const mode of ['mute', 'zero']) {
      if (mode === 'zero')
        await c.control(() => {
          f.main.volume = 0.65;
        });
      const history = await c.pair(1024);
      await c.control(() => {
        if (mode === 'mute') f.main.muted = true;
        else f.main.volume = 0;
      });
      const shut = f.graph.musicGate.gain.value;
      const silent = await c.pair(4096);
      const spectral = f.power(500) + f.power(1000);
      let pending, token;
      await c.control(() => {
        f.main.volume = 0.02;
        f.main.muted = false;
      });
      pending = f.graph.musicGate.gain.value;
      token = c.flushes.at(-1)?.token;
      await c.wait(
        () =>
          c.ready.some(
            (r) => r.token === token && contextTime() >= r.readyAt,
          ) && f.graph.musicGate.gain.value === 1,
      );
      const recovered = await c.pair(2048),
        reference = await c.pair(2048);
      rows.push({
        mode,
        shut,
        pending,
        token,
        ready: c.ready.find((r) => r.token === token),
        open: f.graph.musicGate.gain.value,
        silent,
        spectral,
        recovered,
        reference,
        history,
        identity: f.aux[0] === original,
        count: f.graph.auxiliaryMediaCount,
        time: original.currentTime,
      });
    }
    return rows;
  });
  for (const r of result) {
    expect(r.history.final.peak).toBeGreaterThan(0.003);
    expect(r.shut).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.ready.token).toBe(r.token);
    expect(r.open).toBe(1);
    expect(r.silent.final.peak).toBe(0);
    expect(r.spectral).toBeLessThan(1e-6);
    expect(r.recovered.final.peak).toBeLessThanOrEqual(
      r.history.final.peak * 1.05 + 1e-5,
    );
    expect(r.recovered.final.peak).toBeLessThan(r.reference.final.peak * 1.5);
    expect(r.identity).toBe(true);
    expect(r.count).toBe(1);
    expect(r.time).toBeGreaterThan(3);
    protectedPCM([r.silent, r.recovered, r.reference]);
  }
  await close(page);
});

test('composition wet teardown and reengagement preserve the exact admitted auxiliary chain', async ({
  page,
}) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).crossfadeFixture,
      c = (window as any).composition,
      original = f.aux[0],
      chain = { ...c.chain },
      old = c.wet.reverbNode,
      port = c.ports.find((p) => p.node === old);
    const before = await c.pair();
    await c.setIntensity(0);
    const retired = {
      closed: port.closed,
      disposed: port.disposed,
      routes: c.wetRoutes.size,
      node: c.wet.reverbNode,
    };
    const dry = await c.pair();
    await c.setIntensity(1);
    const renewed = await c.pair();
    const stable = {
      same: f.aux[0] === original,
      user: c.chain.user === chain.user,
      output: c.chain.output === chain.output,
      count: f.graph.auxiliaryMediaCount,
      newNode: c.wet.reverbNode !== old,
      routes: c.wetRoutes.size,
      master: f.graph.masterInput.gain.value,
    };
    await c.wait(() => f.graph.auxiliaryMediaCount === 0);
    return {
      before,
      dry,
      renewed,
      retired,
      stable,
      afterCount: f.graph.auxiliaryMediaCount,
      edgeLive: c.edgeLive,
    };
  });
  protectedPCM([result.before, result.dry, result.renewed]);
  expect(result.dry.final.peak).toBeGreaterThan(0.003);
  expect(result.retired).toEqual({
    closed: true,
    disposed: true,
    routes: 0,
    node: null,
  });
  expect(result.stable).toEqual({
    same: true,
    user: true,
    output: true,
    count: 1,
    newNode: true,
    routes: 1,
    master: 1,
  });
  expect(result.afterCount).toBe(0);
  expect(result.edgeLive).toBe(false);
  await close(page);
});

for (const eqFirst of [true, false])
  test(`composition low-volume EQ with wet listener ${eqFirst ? 'last' : 'first'} preserves admission headroom`, async ({
    page,
  }) => {
    await start(page, { eq: true, eqFirst });
    const result = await page.evaluate(async () => {
      const f = (window as any).crossfadeFixture,
        c = (window as any).composition;
      const pcm = await c.pair(4096);
      const during = {
        eq: c.eq.getResponse().effectivePreampDb,
        input: c.wet.wetInput.gain.value,
        output: c.wet.wetGain.gain.value,
        count: f.graph.auxiliaryMediaCount,
        master: f.graph.masterInput.gain.value,
      };
      await c.wait(() => f.graph.auxiliaryMediaCount === 0);
      const restored = c.eq.getResponse().effectivePreampDb;
      await c.frames(Math.ceil(0.02 * f.context.sampleRate));
      const after = await c.pair(4096);
      return {
        pcm,
        after,
        during,
        restored,
        before: c.beforeAdmission,
        admissions: c.admissions,
        counts: c.counts,
        order: c.listenerOrder.filter((x) => x === 'eq' || x === 'wet'),
      };
    });
    expect(result.before).toBeCloseTo(-36 - 20 * Math.log10(0.03) - 0.1, 3);
    expect(result.during.eq).toBeCloseTo(-36.1, 3);
    expect(result.during.input).toBeCloseTo(1 / 0.03, 4);
    expect(result.during.output).toBeCloseTo(0.03 * 1.2, 6);
    expect(result.during).toMatchObject({ count: 1, master: 1 });
    expect(result.admissions).toHaveLength(1);
    expect(result.admissions[0]).toMatchObject({ count: 1, edgeLive: false });
    expect(result.admissions[0].eq.target).toBeCloseTo(-36.1, 3);
    expect(
      result.admissions[0].eq.chains.every((db) => db <= -36.1 + 1e-6),
    ).toBe(true);
    expect(result.restored).toBeCloseTo(-36 - 20 * Math.log10(0.03) - 0.1, 3);
    expect(
      result.counts
        .filter((x) => x.ever && x.count === 0)
        .every((x) => !x.edgeLive),
    ).toBe(true);
    expect(result.order.slice(0, 2)).toEqual(
      eqFirst ? ['eq', 'wet'] : ['wet', 'eq'],
    );
    protectedPCM([result.pcm, result.after]);
    await close(page);
  });
