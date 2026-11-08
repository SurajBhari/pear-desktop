/* oxlint-disable typescript/no-explicit-any */
import { test, expect } from '@playwright/test';

import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { reverbNativeSource } from './helpers/reverb-native-source';

test('native fixture waits for its latest applied parameters despite earlier queued acknowledgements', async ({
  page,
}) => {
  const source = reverbNativeSource
    .replace(
      'wet.wireAudio(context,mediaVolume);await wet.ensureWorklet();',
      `wet.wireAudio(context,mediaVolume);await wet.ensureWorklet();
      let pendingFixtureParameters=0;
      const forwardFixtureMessage=wet.reverbNode.port.postMessage.bind(wet.reverbNode.port);
      wet.reverbNode.port.postMessage=message=>{
        if(message.type!=='setParams')return forwardFixtureMessage(message);
        pendingFixtureParameters++;
        queueMicrotask(()=>{
          wet.reverbNode.port.dispatchEvent(new MessageEvent('message',{data:'ready'}));
          wet.reverbNode.port.dispatchEvent(new MessageEvent('message',{data:{type:'fixture-params-ready',token:message.fixtureToken-1,params:message.params}}));
        });
        setTimeout(()=>{pendingFixtureParameters--;forwardFixtureMessage(message);},50);
      };`,
    )
    .replace(
      'source.start();const rendering=context.startRendering();',
      'const fixtureBarrier={pending:pendingFixtureParameters};source.start();const rendering=context.startRendering();',
    )
    .replace('return {faultAudit,', 'return {fixtureBarrier,faultAudit,');
  await fixturePage(page, await equalizerBundle(source));
  const result = await page.evaluate(() =>
    (window as any).EqualizerFixture.renderReverbStress({
      kind: 'music',
      intensity: 0.35,
      volume: 0.25,
      eq: 'off',
      highpass: 20,
      lowpass: 20000,
    }),
  );
  expect(result.fixtureBarrier.pending).toBe(0);
  expect(result.parameterReceipts).toHaveLength(2);
  const tokens = result.parameterReceipts.map((receipt: any) => receipt.token);
  expect(new Set(tokens).size).toBe(2);
  for (const receipt of result.parameterReceipts)
    expect(receipt.applied).toEqual(receipt.expected);
});

test('fixture parameter acknowledgement rejects wrong state and cleans up bounded failures', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(reverbNativeSource));
  const rows = await page.evaluate(async () => {
    const acknowledge = (window as any).EqualizerFixture
      .acknowledgeReverbFixtureParams;
    const rows = [];
    for (const failure of ['state', 'timeout', 'throw']) {
      const channel = new MessageChannel(),
        port = channel.port1,
        originalPost = port.postMessage,
        add = port.addEventListener.bind(port),
        remove = port.removeEventListener.bind(port);
      let listeners = 0;
      port.addEventListener = ((...args: any[]) => {
        listeners++;
        return (add as any)(...args);
      }) as any;
      port.removeEventListener = ((...args: any[]) => {
        listeners--;
        return (remove as any)(...args);
      }) as any;
      channel.port2.onmessage = ({ data }) => {
        channel.port2.postMessage({
          type: 'fixture-params-ready',
          token:
            failure === 'timeout' ? data.fixtureToken - 1 : data.fixtureToken,
          params: { wetGain: 0.5 },
        });
        channel.port2.postMessage({ type: 'reset', token: data.fixtureToken });
      };
      let message = '';
      try {
        await acknowledge(
          {
            reverbNode: { port },
            applyReverb() {
              if (failure === 'throw') throw new Error('fixture send failed');
              port.postMessage({ type: 'setParams', params: { wetGain: 1 } });
            },
          },
          failure === 'timeout' ? 50 : 10000,
        );
      } catch (error) {
        message = (error as Error).message;
      }
      rows.push({
        failure,
        message,
        listeners,
        restored: port.postMessage === originalPost,
      });
      channel.port1.close();
      channel.port2.close();
    }
    return rows;
  });
  expect(rows.map((row) => row.message)).toEqual([
    'Fixture reverb parameter receipt does not match applied DSP state',
    'Timed out waiting for matching fixture reverb parameters',
    'fixture send failed',
  ]);
  for (const row of rows)
    expect(row).toMatchObject({ listeners: 0, restored: true });
});
