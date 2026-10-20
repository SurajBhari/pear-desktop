// Passive macOS crash evidence. Never install handlers, change flags or retry tests.
// Only the allowlist below may leave the runner. Raw reports are never copied.
const { randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LIMITS = Object.freeze({
  reportBytes: 1024 * 1024,
  markerBytes: 256,
  scanEntries: 256,
  readFiles: 8,
  reports: 4,
  frames: 32,
  symbol: 160,
  outputBytes: 65536,
  jobMs: 6 * 60 * 60 * 1000,
});
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const evidenceError = (code) =>
  Object.assign(new Error(code), { evidenceCode: code });
const encoded = (value) => JSON.stringify(value, null, 2) + '\n';

// Check every existing path component, including output parents. Do not follow
// a symlink or turn a directory entry supplied by a report into a pathname.
async function directoryWithoutLinks(directory, create = false) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw evidenceError('unsafe');
  }
  return absolute;
}

async function readRegular(file, maximum) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw evidenceError('unsafe');
  if (before.size > maximum) throw evidenceError('oversized');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino
    )
      throw evidenceError('unsafe');
    if (stat.size > maximum) throw evidenceError('oversized');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw evidenceError('oversized');
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      length !== stat.size
    )
      throw evidenceError('changed');
    return {
      contents: new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
      stat,
    };
  } finally {
    await handle.close();
  }
}

async function createMarker(markerPath, startedAtMs = Date.now()) {
  try {
    if (!integer(startedAtMs)) return { code: 'markerUnavailable' };
    await directoryWithoutLinks(path.dirname(markerPath));
    const handle = await fs.open(
      markerPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(encoded({ schemaVersion: 1, startedAtMs }));
    } finally {
      await handle.close();
    }
    return { code: 'markerCreated' };
  } catch {
    return { code: 'markerUnavailable' };
  }
}

function sanitizeReport(contents, startedAtMs, now) {
  let header, body;
  try {
    try {
      body = JSON.parse(contents);
    } catch {
      const newline = contents.indexOf('\n');
      if (newline < 0 || newline > 4096) return { code: 'reportMalformed' };
      header = JSON.parse(contents.slice(0, newline));
      body = JSON.parse(contents.slice(newline + 1));
    }
  } catch {
    return { code: 'reportMalformed' };
  }
  if (!object(body) || body.procName !== 'node')
    return { code: 'reportSchema' };
  if (
    header !== undefined &&
    (!object(header) ||
      header.app_name !== 'node' ||
      (header.name !== undefined && header.name !== 'node'))
  )
    return { code: 'reportSchema' };
  if (
    typeof body.procPath !== 'string' ||
    !body.procPath.startsWith('/') ||
    path.posix.basename(body.procPath) !== 'node'
  )
    return { code: 'reportSchema' };
  if (
    typeof body.captureTime !== 'string' ||
    body.captureTime.length > 64 ||
    !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:?\d\d| [+-]\d{4})$/.test(
      body.captureTime,
    )
  )
    return { code: 'reportSchema' };
  const capture = Date.parse(body.captureTime);
  if (
    !Number.isFinite(capture) ||
    capture < startedAtMs ||
    capture > now + 2000
  )
    return { code: 'reportOutsideWindow' };
  if (
    !object(body.exception) ||
    ![
      'EXC_BAD_ACCESS',
      'EXC_BAD_INSTRUCTION',
      'EXC_CRASH',
      'EXC_ARITHMETIC',
      'EXC_RESOURCE',
      'EXC_GUARD',
      'EXC_BREAKPOINT',
      'EXC_SOFTWARE',
    ].includes(body.exception.type) ||
    ![
      'SIGSEGV',
      'SIGABRT',
      'SIGBUS',
      'SIGILL',
      'SIGTRAP',
      'SIGFPE',
      'SIGKILL',
      'SIGTERM',
    ].includes(body.exception.signal)
  )
    return { code: 'reportSchema' };
  if (
    !Array.isArray(body.threads) ||
    body.threads.length === 0 ||
    body.threads.length > 256 ||
    !Array.isArray(body.usedImages) ||
    body.usedImages.length === 0 ||
    body.usedImages.length > 1024
  )
    return { code: 'reportSchema' };
  const triggered = body.threads.filter(
    (thread) => object(thread) && thread.triggered === true,
  );
  const thread =
    body.faultingThread === undefined
      ? triggered[0]
      : body.threads[body.faultingThread];
  if (
    triggered.length !== 1 ||
    (body.faultingThread !== undefined && !integer(body.faultingThread)) ||
    thread !== triggered[0] ||
    !Array.isArray(thread.frames)
  )
    return { code: 'reportSchema' };
  const process = { name: 'node' };
  if (['ARM-64', 'ARM-64E', 'X86-64'].includes(body.cpuType))
    process.architecture = body.cpuType;
  const operatingSystem = {};
  if (object(body.osVersion)) {
    if (
      typeof body.osVersion.train === 'string' &&
      /^macOS \d{1,2}(?:\.\d{1,2}){0,2}$/.test(body.osVersion.train)
    )
      operatingSystem.version = body.osVersion.train;
    if (
      typeof body.osVersion.build === 'string' &&
      /^\d{2}[A-Z]\d{1,5}[a-z]?$/.test(body.osVersion.build)
    )
      operatingSystem.build = body.osVersion.build;
  }
  const frames = [];
  let truncated = thread.frames.length > LIMITS.frames;
  for (const raw of thread.frames.slice(0, LIMITS.frames)) {
    if (
      !object(raw) ||
      !integer(raw.imageIndex) ||
      raw.imageIndex >= body.usedImages.length
    )
      continue;
    const image = body.usedImages[raw.imageIndex];
    if (!object(image)) continue;
    let binary = image.name;
    if (typeof binary !== 'string' || !/^[A-Za-z0-9_+.-]{1,96}$/.test(binary))
      binary =
        typeof image.path === 'string'
          ? path.posix.basename(image.path)
          : undefined;
    if (
      typeof binary !== 'string' ||
      !/^[A-Za-z0-9_+.-]{1,96}$/.test(binary) ||
      binary === '.' ||
      binary === '..'
    )
      continue;
    const frame = { binary };
    if (integer(raw.imageOffset)) frame.imageOffset = raw.imageOffset;
    // Symbols are bounded native identifiers, not free-form messages or paths.
    if (
      typeof raw.symbol === 'string' &&
      raw.symbol.length <= 4096 &&
      /^[A-Za-z_$][A-Za-z0-9_$:.<>,~* &()+\-[\]]*$/.test(raw.symbol)
    ) {
      frame.symbol = raw.symbol.slice(0, LIMITS.symbol);
      truncated ||= raw.symbol.length > LIMITS.symbol;
    }
    if (integer(raw.symbolLocation)) frame.symbolOffset = raw.symbolLocation;
    frames.push(frame);
  }
  const report = {
    schemaVersion: 1,
    process,
    os: operatingSystem,
    exception: { type: body.exception.type, signal: body.exception.signal },
    frames,
  };
  if (frames.length === 0) report.stackUnavailable = true;
  return { report, truncated };
}

async function writeOwned(outputDirectory, name, contents) {
  const file = path.join(outputDirectory, name);
  try {
    const existing = await fs.lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw evidenceError('unsafe');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(
    outputDirectory,
    '.evidence-' + randomUUID() + '.tmp',
  );
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function collectReports({
  markerPath,
  directory,
  outputDirectory,
  now = Date.now(),
  supported = true,
}) {
  const index = {
    schemaVersion: 1,
    status: 'noReports',
    noReports: true,
    reports: [],
    readFailure: {},
    truncated: false,
  };
  const fail = (code) => {
    index.readFailure[code] = (index.readFailure[code] || 0) + 1;
  };
  const reports = [];
  let output;
  try {
    output = await directoryWithoutLinks(outputDirectory, true);
    // Reject a redirect before writing any report, not only when saving index.
    for (const name of [
      'index.json',
      ...Array.from(
        { length: LIMITS.reports },
        (_, i) => `node-${String(i + 1).padStart(3, '0')}.json`,
      ),
    ]) {
      try {
        const stat = await fs.lstat(path.join(output, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw evidenceError('unsafe');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch {
    return {
      schemaVersion: 1,
      status: 'outputUnavailable',
      code: 'outputUnsafeOrUnavailable',
    };
  }
  let marker;
  try {
    if (!supported) throw evidenceError('unsupportedPlatform');
    await directoryWithoutLinks(path.dirname(markerPath));
    marker = JSON.parse(
      (await readRegular(markerPath, LIMITS.markerBytes)).contents,
    );
    if (
      !object(marker) ||
      Object.keys(marker).length !== 2 ||
      marker.schemaVersion !== 1 ||
      !integer(marker.startedAtMs) ||
      marker.startedAtMs > now ||
      now - marker.startedAtMs > LIMITS.jobMs
    )
      throw evidenceError('invalid');
  } catch (error) {
    index.status = 'notAdmitted';
    index.reason =
      error.evidenceCode === 'unsupportedPlatform'
        ? 'unsupportedPlatform'
        : error.code === 'ENOENT'
          ? 'markerMissing'
          : 'markerInvalid';
  }
  if (index.status !== 'notAdmitted') {
    let handle;
    const candidates = [];
    try {
      await directoryWithoutLinks(directory);
      handle = await fs.opendir(directory);
      for (let count = 0; count <= LIMITS.scanEntries; count++) {
        const entry = await handle.read();
        if (!entry) break;
        if (count === LIMITS.scanEntries) {
          index.truncated = true;
          break;
        }
        if (/^node(?:[-_][A-Za-z0-9_.-]{1,120})?\.ips$/i.test(entry.name))
          candidates.push(entry.name);
      }
    } catch (error) {
      fail(
        error.code === 'ENOENT'
          ? 'directoryMissing'
          : error.evidenceCode === 'unsafe'
            ? 'directoryUnsafe'
            : 'directoryReadFailure',
      );
    } finally {
      await handle?.close().catch(() => {});
    }
    let reads = 0;
    for (const name of candidates.sort()) {
      if (reads === LIMITS.readFiles || reports.length === LIMITS.reports) {
        index.truncated = true;
        break;
      }
      const file = path.join(directory, name);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw evidenceError('unsafe');
        if (stat.size > LIMITS.reportBytes) throw evidenceError('oversized');
        if (stat.mtimeMs < marker.startedAtMs || stat.mtimeMs > now + 2000)
          continue;
        reads++;
        const { contents, stat: opened } = await readRegular(
          file,
          LIMITS.reportBytes,
        );
        if (opened.mtimeMs < marker.startedAtMs || opened.mtimeMs > now + 2000)
          continue;
        const result = sanitizeReport(contents, marker.startedAtMs, now);
        if (!result.report) {
          fail(result.code);
          continue;
        }
        reports.push(result.report);
        index.truncated ||= result.truncated;
      } catch (error) {
        fail(
          error.evidenceCode === 'unsafe'
            ? 'reportUnsafe'
            : error.evidenceCode === 'oversized'
              ? 'reportOversized'
              : 'reportReadFailure',
        );
      }
    }
  }
  try {
    let bytes = 4096; // Reserve enough for the bounded index and fixed error codes.
    for (const report of reports) {
      const contents = encoded(report);
      if (bytes + Buffer.byteLength(contents) > LIMITS.outputBytes) {
        index.truncated = true;
        break;
      }
      const name = `node-${String(index.reports.length + 1).padStart(3, '0')}.json`;
      await writeOwned(output, name, contents);
      bytes += Buffer.byteLength(contents);
      index.reports.push(name);
    }
    index.noReports = index.reports.length === 0;
    if (!index.noReports) index.status = 'collected';
    // A second invocation must not leave a formerly admitted stack alongside
    // a new absence index. Only our four fixed, already checked files retire.
    for (let i = index.reports.length; i < LIMITS.reports; i++) {
      await fs
        .unlink(
          path.join(output, `node-${String(i + 1).padStart(3, '0')}.json`),
        )
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
    await writeOwned(output, 'index.json', encoded(index));
    return index;
  } catch {
    return {
      schemaVersion: 1,
      status: 'outputUnavailable',
      code: 'outputWriteFailure',
    };
  }
}

module.exports = { createMarker, collectReports, sanitizeReport, LIMITS };
if (require.main === module) {
  (async () => {
    const [mode, markerPath, outputDirectory, extra] = process.argv.slice(2);
    let result;
    if (mode === 'mark' && markerPath && outputDirectory === undefined)
      result = await createMarker(markerPath);
    else if (
      mode === 'collect' &&
      markerPath &&
      outputDirectory &&
      extra === undefined
    )
      result = await collectReports({
        markerPath,
        outputDirectory,
        directory: path.join(os.homedir(), 'Library/Logs/DiagnosticReports'),
        supported: process.platform === 'darwin',
      });
    else result = { code: 'invalidArguments' };
    console.log(JSON.stringify(result));
    if (result.code && result.code !== 'markerCreated') process.exitCode = 1;
  })().catch(() => {
    console.log('{"code":"collectorUnavailable"}');
    process.exitCode = 1;
  });
}
