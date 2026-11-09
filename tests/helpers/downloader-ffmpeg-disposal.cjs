// Actual core/wrapper probes. Always invoke through the external supervisor.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../..'),
  req = createRequire(path.join(ROOT, 'package.json'));
const { ownWav, probe } = require('./downloader-real-ffmpeg.cjs');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
async function qualify(mode, out) {
  fs.mkdirSync(out, { recursive: true });
  const report = {
    mode,
    runtime: process.versions,
    commands: [],
    cores: [],
    passed: false,
  };
  const save = (stage) => {
    report.stage = stage;
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  };
  const corePath =
    process.env.PEAR_FFMPEG_CORE || req.resolve('@ffmpeg.wasm/core-mt');
  const factory = req(corePath),
    callbacks = [],
    pending = [],
    manualStops = [],
    weak = [];
  let triggerFault = false,
    releaseOldLoad,
    createdOldLoad;
  const oldCreated = new Promise((r) => {
      createdOldLoad = r;
    }),
    holdOld = new Promise((r) => {
      releaseOldLoad = r;
    });
  req.cache[corePath].exports = async (options) => {
    const core = await factory(options),
      id = report.cores.length,
      pool = core.PThread;
    const row = {
      id,
      nativeExitCalls: 0,
      stops: [],
      originalPoolKeys: Object.keys(pool),
    };
    report.cores.push(row);
    callbacks.push(options.onExit);
    weak.push({
      core: new WeakRef(core),
      buffer: new WeakRef(core.HEAPU8.buffer),
    });
    const nativeExit = core.exit.bind(core);
    core.exit = (...args) => {
      row.nativeExitCalls++;
      save('native-exit-entered');
      return nativeExit(...args);
    };
    const stop = pool.pd.bind(pool);
    pool.pd = () => {
      const workers = [
        ...new Set([...pool.Rb, ...pool.Vb, ...Object.values(pool.Gb)]),
      ];
      const state = {
        workers: workers.map((w) => ({ id: w.threadId })),
        allExited: workers.length === 0,
      };
      row.stops.push(state);
      for (const [i, w] of workers.entries()) {
        const terminate = w.terminate.bind(w);
        w.terminate = () => {
          const p = terminate();
          pending.push(
            p.then((code) => {
              state.workers[i].exitCode = code;
              state.workers[i].finalId = w.threadId;
              state.allExited = state.workers.every((w) => w.finalId === -1);
            }),
          );
          return p;
        };
      }
      const started = performance.now();
      stop();
      state.returnMilliseconds = performance.now() - started;
      state.poolsAfter = {
        running: pool.Rb.length,
        idle: pool.Vb.length,
        index: Object.keys(pool.Gb).length,
      };
      assert.deepEqual(state.poolsAfter, { running: 0, idle: 0, index: 0 });
    };
    manualStops.push(pool.pd);
    if (mode === 'unsupported' && id === 0) pool.pd = undefined;
    const cwrap = core.cwrap.bind(core);
    core.cwrap = (...args) => {
      const call = cwrap(...args);
      return (...argv) => {
        const ret = call(...argv);
        if (triggerFault) {
          triggerFault = false;
          save('after-owned-dispatch-fault');
          throw Error('Owned post-dispatch fault');
        }
        return ret;
      };
    };
    if (mode === 'superseded' && id === 0) {
      createdOldLoad();
      await holdOld;
    }
    return core;
  };
  const api = process.env.PEAR_FFMPEG_WRAPPER
    ? req(process.env.PEAR_FFMPEG_WRAPPER)
    : req('@ffmpeg.wasm/main');
  const engine = (api.default ?? api).createFFmpeg({
      corePath,
      logger() {},
      progress() {},
    }),
    input = ownWav();
  const readOutput = (name) => {
    const file = path.join(out, name);
    fs.writeFileSync(file, engine.FS('readFile', name));
    return probe(file);
  };
  const recover = async () => {
    await engine.load();
    engine.FS('writeFile', 'recover.wav', input);
    let settled = false;
    const job = engine.run('-i', 'recover.wav', 'recover.flac').then((v) => {
      settled = true;
      return v;
    });
    callbacks[0](0);
    callbacks[0](1);
    await Promise.resolve();
    assert.equal(settled, false, 'Old callback settled replacement command');
    await job;
    report.recovery = readOutput('recover.flac');
    assert.equal(report.recovery.pcmSha256, sha(input.subarray(44)));
    engine.exit();
  };
  try {
    if (mode === 'superseded') {
      const old = engine.load().then(
        () => ({ resolved: true }),
        (e) => ({ resolved: false, error: String(e) }),
      );
      await oldCreated;
      await engine.load();
      engine.FS('writeFile', 'active.wav', input);
      const active = engine.run('-i', 'active.wav', 'active.flac');
      releaseOldLoad();
      report.superseded = await old;
      assert.equal(report.superseded.resolved, false);
      assert.match(report.superseded.error, /superseded/);
      callbacks[0](0);
      callbacks[0](1);
      await active;
      report.recovery = readOutput('active.flac');
      assert.equal(report.recovery.pcmSha256, sha(input.subarray(44)));
      engine.exit();
    } else if (mode === 'gc') {
      assert.equal(typeof global.gc, 'function');
      for (let i = 0; i < 3; i++) {
        await engine.load();
        engine.FS('writeFile', 'input.wav', input);
        const job = engine.run('-i', 'input.wav', 'active.mp3').then(
          () => ({ resolved: true }),
          (e) => ({ resolved: false, error: String(e) }),
        );
        engine.exit();
        assert.equal((await job).resolved, false);
        await Promise.all(pending);
        pending.length = 0;
      }
      callbacks.length = 0;
      manualStops.length = 0;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setImmediate(r));
        global.gc();
        await new Promise((r) => setImmediate(r));
        report.collected = weak.map((w) => ({
          core: w.core.deref() === undefined,
          buffer: w.buffer.deref() === undefined,
        }));
        if (report.collected.every((w) => w.core && w.buffer)) break;
      }
      assert(report.collected.every((w) => w.core && w.buffer));
      report.memory = process.memoryUsage();
    } else {
      await engine.load();
      engine.FS('writeFile', 'input.wav', input);
      engine.FS('writeFile', 'partial.wav', input.subarray(0, 44145));
      const commands = [
        ['initial', ['-i', 'input.wav', 'a.flac'], 'a.flac', false],
        [
          'unknown',
          ['-i', 'input.wav', '-c:a', 'owned_unknown', 'b.mp3'],
          'b.mp3',
          true,
        ],
        ['recovery', ['-i', 'input.wav', 'c.mp3'], 'c.mp3', false],
        ['partial', ['-xerror', '-i', 'partial.wav', 'd.mp3'], 'd.mp3', true],
        [
          'atempo',
          ['-i', 'input.wav', '-af', 'atempo=2', 'e.mp3'],
          'e.mp3',
          false,
        ],
        [
          'unwritable',
          ['-i', 'input.wav', '/owned_missing/f.mp3'],
          'f.mp3',
          true,
        ],
        ['final', ['-i', 'input.wav', 'g.flac'], 'g.flac', false],
      ];
      for (const [name, args, output, fail] of commands) {
        let error;
        try {
          await engine.run(...args);
        } catch (e) {
          error = e;
        }
        assert.equal(!!error, fail);
        if (error) assert.equal(error.exitCode, 1);
        const exists = engine.FS('readdir', '/').includes(output);
        if (name === 'partial') assert(exists);
        if (exists) engine.FS('unlink', output);
        report.commands.push({
          name,
          exitCode: error?.exitCode ?? 0,
          outputExisted: exists,
        });
      }
      triggerFault = mode === 'sync-fault';
      save('before-active-dispatch');
      const started = performance.now();
      const cancelled = engine.run('-i', 'input.wav', 'cancel.mp3').then(
        () => ({ resolved: true }),
        (e) => ({ resolved: false, error: String(e), code: e?.code }),
      );
      save('after-active-dispatch');
      if (mode === 'invalid-status') callbacks[0]('invalid');
      else if (mode !== 'sync-fault') {
        try {
          engine.exit();
        } catch (e) {
          report.exitError = { message: String(e), code: e.code };
        }
      }
      report.returnMilliseconds = performance.now() - started;
      save('after-forced-teardown');
      report.cancelled = await cancelled;
      assert.equal(report.cancelled.resolved, false);
      assert.equal(engine.isLoaded(), false);
      if (mode === 'unsupported') {
        assert.equal(report.exitError.code, 'FFMPEG_UNSUPPORTED_CORE_DISPOSAL');
        assert.equal(report.cancelled.code, 'FFMPEG_UNSUPPORTED_CORE_DISPOSAL');
        assert.equal(report.cores[0].stops.length, 0);
        report.productionCleanupClaimed = false;
        manualStops[0]();
        report.manualFixtureCleanup = true;
      } else if (mode === 'sync-fault')
        assert.match(report.cancelled.error, /Owned post-dispatch fault/);
      else if (mode === 'invalid-status')
        assert.match(report.cancelled.error, /invalid exit status/);
      else assert.equal(report.cancelled.error, 'ffmpeg has exited');
      // Reload immediately: do not wait for old termination promises or a delay.
      await recover();
    }
    await Promise.all(pending);
    assert(
      report.cores.every((c) => c.nativeExitCalls === 0),
      'Native WASM destructor exit was used',
    );
    assert(
      report.cores.every(
        (c) =>
          c.stops.length > 0 &&
          c.stops.every(
            (s) => s.allExited && s.workers.every((w) => w.finalId === -1),
          ),
      ),
    );
    report.passed = true;
    save('finished');
  } catch (e) {
    report.error = String(e.stack || e);
    save('failed');
  } finally {
    req.cache[corePath].exports = factory;
  }
  return report;
}
module.exports = { qualify };
if (require.main === module)
  qualify(process.argv[2], path.resolve(process.argv[3])).then((r) =>
    process.exit(r.passed ? 0 : 1),
  );
