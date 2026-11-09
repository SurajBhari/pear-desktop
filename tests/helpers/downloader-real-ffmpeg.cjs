// Explicit opt-in offline real-engine qualification. No application entry or profile.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createRequire, stripTypeScriptTypes } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'),
  req = createRequire(path.join(root, 'package.json'));
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
function ownWav() {
  const pcm = Buffer.alloc(88200),
    wav = Buffer.alloc(88244);
  for (let i = 0; i < 44100; i++)
    pcm.writeInt16LE(
      Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 44100)),
      i * 2,
    );
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(88200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
function probe(file) {
  const data = JSON.parse(
    execFileSync(
      process.env.PEAR_FFPROBE || 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8', timeout: 10000 },
    ),
  );
  const pcm = execFileSync(
    process.env.PEAR_FFMPEG || 'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      '44100',
      'pipe:1',
    ],
    { timeout: 10000, maxBuffer: 2000000 },
  );
  let energy = 0,
    crossings = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    energy += s * s;
    if (i && pcm.readInt16LE(i - 2) < 0 && s >= 0) crossings++;
  }
  return {
    codec: data.streams[0].codec_name,
    bitrate: data.streams[0].bit_rate,
    samples: pcm.length / 2,
    rms: Math.sqrt(energy / (pcm.length / 2)),
    crossings,
    pcmSha256: sha(pcm),
    metadata: data.format.tags ?? data.streams[0].tags,
  };
}
async function qualify(out) {
  fs.mkdirSync(out, { recursive: true });
  const report = { cases: [], coreAssets: [], errors: [] };
  let engine, current;
  const timer = setTimeout(() => {
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify({ ...report, timeout: true }, null, 2),
    );
    process.exit(124);
  }, 90000);
  try {
    const parser = req(
      './node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser',
    );
    const src = fs.readFileSync(
      path.join(root, 'src/plugins/downloader/main/index.ts'),
      'utf8',
    );
    const ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    const names = [
      'downloadChunks',
      'iterableStreamToProcessedUint8Array',
      'getFFmpegMetadataArgs',
    ];
    const functions = ast.program.body
      .filter(
        (n) => n.type === 'FunctionDeclaration' && names.includes(n.id?.name),
      )
      .map((n) => src.slice(n.start, n.end));
    if (functions.length !== 3)
      throw Error('Actual processor source extraction failed');
    report.sourceSha256 = sha(src);
    const corePath =
      process.env.PEAR_FFMPEG_CORE || req.resolve('@ffmpeg.wasm/core-mt');
    for (const name of [
      'ffmpeg-core.js',
      'ffmpeg-core.wasm',
      'ffmpeg-core.worker.js',
    ]) {
      const p = path.join(path.dirname(corePath), name);
      report.coreAssets.push({ name, sha256: sha(fs.readFileSync(p)) });
    }
    const logs = [];
    const wrapper = process.env.PEAR_FFMPEG_WRAPPER
      ? req(process.env.PEAR_FFMPEG_WRAPPER)
      : req('@ffmpeg.wasm/main');
    engine = (wrapper.default ?? wrapper).createFFmpeg({
      corePath,
      logger: (e) => logs.push(e),
      progress: () => {},
    });
    const run = engine.run.bind(engine),
      realFS = engine.FS.bind(engine);
    engine.run = async (...args) => {
      current.command = args;
      try {
        const value = await run(...args);
        current.run = 'resolved';
        current.value = String(value);
        return value;
      } catch (e) {
        current.run = 'rejected';
        current.exitCode = e?.exitCode;
        current.runError = String(e);
        throw e;
      }
    };
    engine.FS = (method, ...args) => {
      const value = realFS(method, ...args);
      if (
        current &&
        method === 'readdir' &&
        current.run &&
        !current.beforeCleanup
      )
        current.beforeCleanup = [...value];
      return value;
    };
    const { Mutex } = req('async-mutex');
    const deps = {
      randomBytes: crypto.randomBytes,
      ffmpegMutex: new Mutex(),
      ffmpeg: { get: async () => engine },
      Buffer,
      t: (k) => k,
      assertCurrentBinding: () => {},
      isCurrentBinding: () => true,
      sendError: (e) => {
        current.processorError = String(e);
      },
    };
    const processor = new Function(
      'd',
      'const {randomBytes,ffmpegMutex,ffmpeg,Buffer,t,assertCurrentBinding,isCurrentBinding,sendError}=d;' +
        stripTypeScriptTypes(functions.join('\n\n')) +
        ';return iterableStreamToProcessedUint8Array;',
    )(deps);
    const wav = ownWav();
    report.inputSha256 = sha(wav);
    report.pcmSha256 = sha(wav.subarray(44));
    await engine.load();
    const baseline = engine.FS('readdir', '/').sort();
    const cases = [
      ['mp3', 'mp3', ['-b:a', '256k', '-vn'], wav, 44100],
      ['flac', 'flac', ['-vn'], wav, 44100],
      ['opus', 'opus', ['-c:a', 'libopus', '-b:a', '128k', '-vn'], wav, 44100],
      [
        'malformed',
        'mp3',
        ['-b:a', '256k'],
        Buffer.from('owned invalid audio\n'),
        null,
      ],
      ['after-malformed', 'mp3', ['-b:a', '256k'], wav, 44100],
      ['unknown-encoder', 'mp3', ['-c:a', 'owned_no_encoder'], wav, null],
      ['after-unknown', 'mp3', ['-b:a', '256k'], wav, 44100],
      [
        'partial',
        'mp3',
        ['-xerror', '-b:a', '256k'],
        wav.subarray(0, 44145),
        null,
      ],
      ['after-partial', 'mp3', ['-b:a', '256k'], wav, 44100],
      ['legitimate-trim', 'mp3', ['-t', '0.25', '-b:a', '256k'], wav, 11025],
      ['quiet', 'mp3', ['-loglevel', 'quiet', '-b:a', '256k'], wav, 44100],
    ];
    for (const [name, ext, args, input, wantSamples] of cases) {
      current = { name, wantSamples };
      const logStart = logs.length;
      async function* chunks() {
        for (let i = 0; i < input.length; i += 8192)
          yield input.subarray(i, i + 8192);
      }
      const bytes = await processor(
        chunks(),
        ext,
        { title: 'Owned sine', artist: 'Offline qualification' },
        args,
        input.length,
        () => {},
        () => {},
        {},
      );
      current.returned = bytes === null ? 'null' : 'bytes';
      current.bytes = bytes?.length ?? 0;
      current.cleaned =
        JSON.stringify(engine.FS('readdir', '/').sort()) ===
        JSON.stringify(baseline);
      current.logs = logs.slice(logStart);
      if (bytes) {
        const file = path.join(out, name + '.' + ext);
        fs.writeFileSync(file, bytes);
        current.probe = probe(file);
        current.sha256 = sha(bytes);
      }
      current.passed =
        current.cleaned &&
        (wantSamples === null
          ? current.run === 'rejected' &&
            current.exitCode === 1 &&
            bytes === null
          : current.run === 'resolved' &&
            current.value === 'undefined' &&
            current.probe?.samples === wantSamples &&
            current.probe.rms > 8000 &&
            current.probe.rms < 9000);
      if (name === 'flac')
        current.passed &&= current.probe?.pcmSha256 === report.pcmSha256;
      if (name === 'mp3')
        current.passed &&=
          current.probe?.codec === 'mp3' && current.probe.bitrate === '256000';
      if (name === 'opus') current.passed &&= current.probe?.codec === 'opus';
      if (wantSamples !== null) {
        current.passed &&=
          Math.abs(
            current.probe.crossings - (wantSamples === 11025 ? 110 : 440),
          ) <= 1;
        current.passed &&=
          current.probe.metadata?.title === 'Owned sine' &&
          current.probe.metadata?.artist === 'Offline qualification';
      }
      if (name === 'partial') {
        current.partialExisted = current.beforeCleanup.includes(
          current.command.at(-1),
        );
        current.passed &&= current.partialExisted;
      }
      report.cases.push(current);
    }
    report.passed = report.cases.every((c) => c.passed);
    engine.exit();
    report.unloaded = !engine.isLoaded();
    engine = null;
  } catch (e) {
    report.errors.push(String(e.stack || e));
    report.passed = false;
  } finally {
    if (engine?.isLoaded()) engine.exit();
    clearTimeout(timer);
    fs.writeFileSync(
      path.join(out, 'result.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  return report;
}
module.exports = { ownWav, probe, qualify };
if (require.main === module)
  qualify(path.resolve(process.argv[2])).then((r) => {
    for (const c of r.cases)
      console.log(
        `${c.name}: ${c.passed ? 'PASS' : 'FAIL'} ${c.run} exit=${c.exitCode ?? '-'} returned=${c.returned} samples=${c.probe?.samples ?? '-'} cleanup=${c.cleaned}`,
      );
    if (r.errors.length) console.error(r.errors.join('\n'));
    process.exit(r.passed ? 0 : 1);
  });
