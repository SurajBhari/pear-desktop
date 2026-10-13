import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  link,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { Mutex } from 'async-mutex';
import NodeID3 from 'node-id3';

import {
  type AudioDescriptor,
  type DuplicatePolicy,
  type AudioPreference,
  reportedBitrate,
  validAudioLength,
  qualityTier,
} from './audio';

const INDEX = '.pear-desktop-library.json';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_VERIFY_BYTES = 512 * 1024 * 1024;
const locks = new Map<string, Mutex>();
const relocations = new Map<string, Map<string, string>>();
const resolvedRecord = (
  root: string,
  record: LibraryRecord,
): LibraryRecord => ({
  ...record,
  path: relocations.get(root)?.get(record.path) ?? record.path,
});
const truncateBytes = (value: string, max: number) => {
  let result = '';
  let used = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character);
    if (used + length > max) break;
    used += length;
    result += character;
  }
  return result;
};
export interface OutputRecipe {
  extension: string;
  args: string[];
}
export interface CompletedInput {
  videoId: string;
  source: AudioDescriptor;
  output: OutputRecipe;
  policy: DuplicatePolicy;
  preference?: AudioPreference;
  approved?: boolean;
}
export interface LibraryRecord {
  path: string;
  videoId: string;
  source: AudioDescriptor;
  output: OutputRecipe;
  variant: string;
  size: number;
  sha256: string;
  completedAt: string;
}
export interface LibraryFile {
  path: string;
  status: 'complete' | 'changed' | 'uncertain' | 'invalid' | 'missing';
  videoId?: string;
  source?: AudioDescriptor;
  size: number;
  reason?: string;
}
export interface LibraryReport {
  files: LibraryFile[];
  errors: string[];
  truncated: boolean;
  visited: number;
}
export const variantKey = (
  input: Pick<CompletedInput, 'videoId' | 'source' | 'output'>,
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.videoId,
        input.source.key,
        input.source.quality,
        input.source.bitrate,
        input.source.averageBitrate,
        input.source.channels,
        input.source.sampleRate,
        input.output.extension,
        input.output.args,
      ]),
    )
    .digest('hex');
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const relativeSafe = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length < 2048 &&
  !value.includes('\\') &&
  !path.isAbsolute(value) &&
  !/^[a-z]:/i.test(value) &&
  !value.split('/').some((p) => !p || p === '.' || p === '..');
async function canonicalRoot(root: string) {
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Library root must be a real directory');
  const resolved = await realpath(root);
  const after = await lstat(root, { bigint: true });
  if (
    after.isSymbolicLink() ||
    stat.ino !== after.ino ||
    stat.dev !== after.dev
  )
    throw new Error('Library directory changed');
  return resolved;
}
type DirectoryIdentity = { ino: bigint; dev: bigint };
async function contained(
  root: string,
  target: string,
  identity?: DirectoryIdentity,
) {
  const rootStat = await lstat(root, { bigint: true });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (identity &&
      (rootStat.ino !== identity.ino || rootStat.dev !== identity.dev)) ||
    path.relative(root, await realpath(root)) !== ''
  )
    throw new Error('Library directory changed or became a symlink');
  const relative = path.relative(root, path.resolve(target));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Library path outside selected root');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error('Symlink library path unsupported');
  }
  return target;
}
function validRecord(v: unknown): v is LibraryRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as LibraryRecord;
  return (
    relativeSafe(r.path) &&
    typeof r.videoId === 'string' &&
    /^[\w-]{1,128}$/.test(r.videoId) &&
    typeof r.variant === 'string' &&
    /^[a-f0-9]{64}$/.test(r.variant) &&
    Number.isSafeInteger(r.size) &&
    r.size > 0 &&
    /^[a-f0-9]{64}$/.test(r.sha256) &&
    !!r.source &&
    typeof r.source.key === 'string' &&
    r.source.key.length <= 4096 &&
    typeof r.source.codec === 'string' &&
    typeof r.source.language === 'string' &&
    validAudioLength(r.source.length) &&
    !!r.output &&
    typeof r.output.extension === 'string' &&
    /^[\w]{1,12}$/.test(r.output.extension) &&
    Array.isArray(r.output.args) &&
    r.output.args.length <= 128 &&
    r.output.args.every((a) => typeof a === 'string' && a.length <= 4096)
  );
}
async function readIndex(root: string, validate?: () => Promise<void>) {
  const errors: string[] = [];
  let records: LibraryRecord[] = [];
  let handle;
  try {
    await validate?.();
    handle = await open(path.join(root, INDEX), noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES)
      throw new Error('Invalid/oversized manifest');
    await validate?.();
    const data = JSON.parse(await handle.readFile('utf8')) as {
      version?: number;
      records?: unknown[];
    };
    if (
      data.version !== 1 ||
      !Array.isArray(data.records) ||
      data.records.length > 10000
    )
      throw new Error('Invalid library manifest schema');
    records = data.records.filter(validRecord);
    if (records.length !== data.records.length)
      errors.push('Invalid manifest records ignored');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      errors.push('Library manifest unreadable or invalid');
  } finally {
    await handle?.close();
  }
  return { records, errors };
}
async function hashFile(
  root: string,
  record: LibraryRecord,
  assertCurrent = () => {},
  limit = MAX_VERIFY_BYTES,
  validate?: (handle: import('node:fs/promises').FileHandle) => Promise<void>,
) {
  const target = path.join(root, record.path);
  await contained(root, target);
  const handle = await open(target, noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== record.size || stat.size > limit)
      return false;
    await validate?.(handle);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (true) {
      assertCurrent();
      const chunk = await handle.read(buffer, 0, buffer.length, null);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
      if (bytes > record.size) return false;
      hash.update(buffer.subarray(0, chunk.bytesRead));
    }
    assertCurrent();
    return bytes === record.size && hash.digest('hex') === record.sha256;
  } finally {
    await handle.close();
  }
}
async function verified(
  root: string,
  input: CompletedInput,
  assertCurrent = () => {},
) {
  const { records } = await readIndex(root);
  const matches: LibraryRecord[] = [];
  for (const record of records.filter((r) => r.videoId === input.videoId)) {
    try {
      const resolved = resolvedRecord(root, record);
      if (await hashFile(root, resolved, assertCurrent)) matches.push(resolved);
    } catch (e) {
      assertCurrent();
      if (!(e instanceof Error)) throw e;
    }
  }
  return matches;
}
export function duplicateDecision(
  records: LibraryRecord[],
  input: CompletedInput,
): 'skip' | 'save' | 'ask' {
  if (!records.length || input.policy === 'legacy') return 'save';
  if (input.policy === 'skip-any') return 'skip';
  if (records.some((r) => r.variant === variantKey(input))) return 'skip';
  if (input.policy === 'save-variant') return 'save';
  if (input.policy === 'ask') return input.approved ? 'save' : 'ask';
  const comparable = records.filter(
    (r) =>
      r.source.codec === input.source.codec &&
      r.source.language === input.source.language &&
      r.source.track === input.source.track &&
      r.source.drc === input.source.drc &&
      r.source.channels === input.source.channels &&
      r.source.sampleRate === input.source.sampleRate &&
      JSON.stringify(r.output) === JSON.stringify(input.output),
  );
  const target = reportedBitrate(input.source);
  const offeredTier = qualityTier(input.source);
  const comparisons = comparable.map((record) => {
    const existingTier = qualityTier(record.source);
    if (existingTier !== offeredTier)
      return existingTier && offeredTier
        ? Math.sign(existingTier - offeredTier)
        : undefined;
    if (record.source.quality !== input.source.quality) return undefined;
    const existingRate = reportedBitrate(record.source);
    return existingRate > 0 && target > 0
      ? Math.sign(existingRate - target)
      : undefined;
  });
  if (comparisons.some((order) => order !== undefined && order >= 0))
    return 'skip';
  if (
    comparisons.length &&
    comparisons.every((order) => order !== undefined && order < 0)
  )
    return 'save';
  const preferred =
    input.preference?.mode === 'opus'
      ? input.source.codec === 'opus' &&
        records.every((r) => r.source.codec !== 'opus')
      : input.preference?.mode === 'aac'
        ? input.source.codec.startsWith('mp4a.') &&
          records.every((r) => !r.source.codec.startsWith('mp4a.'))
        : input.preference?.mode === 'itag'
          ? records.every((r) => r.source.itag !== input.preference?.itag)
          : false;
  return preferred || input.approved ? 'save' : 'ask';
}
export async function checkDuplicate(
  root: string,
  input: CompletedInput,
  assertCurrent = () => {},
) {
  try {
    const canonical = await canonicalRoot(root);
    return duplicateDecision(
      await verified(canonical, input, assertCurrent),
      input,
    );
  } catch (e) {
    assertCurrent();
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'save';
    throw e;
  }
}
export async function hasVerifiedTrack(
  root: string,
  videoId: string,
  assertCurrent = () => {},
) {
  try {
    const canonical = await canonicalRoot(root);
    const { records } = await readIndex(canonical);
    for (const record of records.filter((r) => r.videoId === videoId)) {
      try {
        if (
          await hashFile(
            canonical,
            resolvedRecord(canonical, record),
            assertCurrent,
          )
        )
          return true;
      } catch {
        assertCurrent();
      }
    }
    return false;
  } catch (error) {
    assertCurrent();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function scanLibrary(
  root: string,
  options: {
    maxFiles?: number;
    maxDepth?: number;
    maxVerifyBytes?: number;
    signal?: AbortSignal;
    onProgress?: (visited: number) => void;
  } = {},
): Promise<LibraryReport> {
  const selectedRoot = await lstat(root, { bigint: true });
  const canonical = await canonicalRoot(root);
  const rootIdentity = { ino: selectedRoot.ino, dev: selectedRoot.dev };
  type ObservedDirectory = DirectoryIdentity & { path: string };
  const rootChain: ObservedDirectory[] = [{ ...rootIdentity, path: canonical }];
  const validateChain = async (chain: ObservedDirectory[]) => {
    await contained(canonical, chain[chain.length - 1].path, rootIdentity);
    for (const observed of chain) {
      const current = await lstat(observed.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== observed.ino ||
        current.dev !== observed.dev
      )
        throw new Error('Library directory changed during scan');
    }
  };
  const index = await readIndex(canonical, () => validateChain(rootChain));
  const report: LibraryReport = {
    files: [],
    errors: index.errors,
    truncated: false,
    visited: 0,
  };
  const assertCurrent = () => {
    if (options.signal?.aborted) throw new Error('Library scan cancelled');
  };
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 10000, 10000));
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 10, 20));
  let budget = Math.max(
    0,
    Math.min(options.maxVerifyBytes ?? 256 * 1024 * 1024, MAX_VERIFY_BYTES),
  );
  const seen = new Set<string>();
  const moved = new Map<string, string>();
  let entries = 0;
  async function walk(
    directory: string,
    depth: number,
    chain: ObservedDirectory[],
  ) {
    assertCurrent();
    let names;
    try {
      await validateChain(chain);
      names = await opendir(directory);
    } catch {
      report.errors.push('Unreadable library subfolder');
      return;
    }
    for await (const entry of names) {
      assertCurrent();
      try {
        await validateChain(chain);
      } catch {
        report.errors.push(
          'Library directory changed or became a symlink during scan; remaining entries skipped',
        );
        return;
      }
      if (report.visited >= maxFiles || ++entries > maxFiles * 4) {
        report.truncated = true;
        return;
      }
      if (entry.name === INDEX || entry.name.startsWith('.pear-')) continue;
      const full = path.join(directory, entry.name);
      let stat;
      try {
        stat = await lstat(full, { bigint: true });
      } catch {
        report.errors.push('Unreadable library entry');
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth >= maxDepth) {
          report.truncated = true;
          continue;
        }
        await walk(full, depth + 1, [
          ...chain,
          { path: full, ino: stat.ino, dev: stat.dev },
        ]);
        continue;
      }
      if (
        !stat.isFile() ||
        !/\.(mp3|m4a|mp4|webm|opus|ogg|flac|wav)$/i.test(entry.name)
      )
        continue;
      const size = Number(stat.size);
      const validateFile = async (
        handle: import('node:fs/promises').FileHandle,
      ) => {
        assertCurrent();
        await validateChain(chain);
        const opened = await handle.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size !== stat.size
        )
          throw new Error('Library file changed before scan read');
      };
      report.visited++;
      const relative = path.relative(canonical, full).split(path.sep).join('/');
      seen.add(relative);
      const record = index.records.find((r) => r.path === relative);
      const row: LibraryFile = {
        path: relative,
        size: size,
        status: size ? 'uncertain' : 'invalid',
        reason: size ? 'Unindexed: source/completion unknown' : 'Empty file',
      };
      if (record) {
        row.videoId = record.videoId;
        row.source = record.source;
        if (size <= budget) {
          budget -= size;
          try {
            row.status = (await hashFile(
              canonical,
              record,
              assertCurrent,
              budget + size,
              validateFile,
            ))
              ? 'complete'
              : 'changed';
            row.reason =
              row.status === 'complete'
                ? undefined
                : 'File differs from completed record';
          } catch {
            assertCurrent();
            row.status = 'changed';
          }
        } else {
          row.reason = 'Verification read budget reached';
          report.truncated = true;
        }
      } else {
        for (const previous of index.records.filter((r) => r.size === size)) {
          if (size > budget) {
            report.truncated = true;
            break;
          }
          budget -= size;
          try {
            if (
              await hashFile(
                canonical,
                { ...previous, path: relative },
                assertCurrent,
                size,
                validateFile,
              )
            ) {
              row.status = 'complete';
              row.videoId = previous.videoId;
              row.source = previous.source;
              row.reason = 'Completed receipt verified at renamed path';
              moved.set(previous.path, relative);
              break;
            }
          } catch {
            assertCurrent();
          }
        }
      }
      if (
        row.status === 'uncertain' &&
        /\.mp3$/i.test(entry.name) &&
        size > 0
      ) {
        let handle;
        try {
          handle = await open(full, noFollow);
          await validateFile(handle);
          const b = Buffer.alloc(Math.min(256 * 1024, size, budget));
          budget -= b.length;
          if (!b.length) {
            report.truncated = true;
            row.reason = 'Metadata read budget reached';
          }
          await handle.read(b, 0, b.length, 0);
          const tags = NodeID3.read(b);
          const embeddedId = tags.userDefinedText?.find(
            (t) => t.description === 'pear-desktop:youtube-video-id',
          )?.value;
          if (embeddedId && /^[\w-]{1,128}$/.test(embeddedId))
            row.videoId = embeddedId;
        } catch {
          row.reason = 'Metadata unreadable; preserved';
        } finally {
          await handle?.close();
        }
      }
      report.files.push(row);
      options.onProgress?.(report.visited);
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  await walk(canonical, 0, rootChain);
  assertCurrent();
  if (!report.truncated)
    for (const record of index.records)
      if (!seen.has(record.path) && !moved.has(record.path))
        report.files.push({
          path: record.path,
          videoId: record.videoId,
          source: record.source,
          size: 0,
          status: 'missing',
          reason: 'Indexed file missing',
        });
  report.files.sort((a, b) => a.path.localeCompare(b.path));
  relocations.set(canonical, moved);
  if (relocations.size > 16)
    relocations.delete(relocations.keys().next().value!);
  return report;
}
export async function publishCompleted(
  root: string,
  directory: string,
  filename: string,
  bytes: Uint8Array,
  input: CompletedInput,
  assertCurrent: () => void,
): Promise<{ status: 'saved' | 'skipped' | 'needs-choice'; path?: string }> {
  assertCurrent();
  if (!bytes.byteLength)
    throw new Error('Cannot publish empty processed audio');
  if (
    path.basename(filename) !== filename ||
    !filename ||
    filename.includes('\\')
  )
    throw new Error('Invalid output filename');
  if (
    !/^[\w-]{1,128}$/.test(input.videoId) ||
    !input.source.supported ||
    !validAudioLength(input.source.length)
  )
    throw new Error('Invalid completed source identity');
  await mkdir(root, { recursive: true });
  const canonical = await canonicalRoot(root);
  const relativeDirectory = path.relative(
    path.resolve(root),
    path.resolve(directory),
  );
  if (
    relativeDirectory === '..' ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  )
    throw new Error('Output directory outside selected library');
  const targetDirectory = path.join(canonical, relativeDirectory);
  const rootIdentity = await lstat(canonical, { bigint: true });
  await contained(canonical, targetDirectory, rootIdentity);
  const targetIdentity = await lstat(targetDirectory, { bigint: true });
  const assertDirectories = async () => {
    await contained(canonical, targetDirectory, rootIdentity);
    const current = await lstat(targetDirectory, { bigint: true });
    if (
      current.ino !== targetIdentity.ino ||
      current.dev !== targetIdentity.dev ||
      !current.isDirectory()
    )
      throw new Error('Library directory changed');
  };
  let mutex = locks.get(canonical);
  if (!mutex) {
    mutex = new Mutex();
    locks.set(canonical, mutex);
  }
  try {
    return await mutex.runExclusive(async () => {
      assertCurrent();
      await assertDirectories();
      const writerPath = path.join(canonical, '.pear-desktop-writer.lock');
      let writer;
      try {
        try {
          writer = await open(writerPath, 'wx', 0o600);
          await writer.writeFile(
            JSON.stringify({
              pid: process.pid,
              createdAt: new Date().toISOString(),
            }),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new Error(
              'Library writer lock exists: another process may be saving. After a crash, close other instances and remove only .pear-desktop-writer.lock before retrying.',
              { cause: error },
            );
          throw error;
        }
        const old = await readIndex(canonical);
        const decision = duplicateDecision(
          await verified(canonical, input, assertCurrent),
          input,
        );
        if (decision === 'skip') return { status: 'skipped' as const };
        if (decision === 'ask') return { status: 'needs-choice' as const };
        const temp = path.join(
          targetDirectory,
          `.pear-audio-${randomBytes(12).toString('hex')}.tmp`,
        );
        let finalPath: string | undefined;
        let handle;
        try {
          handle = await open(temp, 'wx', 0o600);
          await assertDirectories();
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = undefined;
          assertCurrent();
          for (let attempt = 0; attempt < 100; attempt++) {
            const ext = path.extname(filename);
            const stem = filename.slice(0, filename.length - ext.length);
            const name =
              attempt === 0
                ? `${truncateBytes(stem, 200)}${ext}`
                : `${truncateBytes(stem, 100)} [${truncateBytes(input.videoId, 100)}-${variantKey(input).slice(0, 8)}${attempt > 1 ? `-${attempt}` : ''}]${ext}`;
            const candidate = path.join(targetDirectory, name);
            assertCurrent();
            await assertDirectories();
            try {
              await link(temp, candidate);
              finalPath = candidate;
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            }
          }
          if (!finalPath)
            throw new Error('Output filename collision limit reached');
          assertCurrent();
          await assertDirectories();
          const record: LibraryRecord = {
            path: path.relative(canonical, finalPath).split(path.sep).join('/'),
            videoId: input.videoId,
            source: input.source,
            output: input.output,
            variant: variantKey(input),
            size: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            completedAt: new Date().toISOString(),
          };
          if (
            !validRecord(record) ||
            old.errors.length ||
            old.records.length >= 10000
          )
            throw new Error('Audio saved; library index invalid or full');
          const indexTemp = path.join(
            canonical,
            `.pear-index-${randomBytes(12).toString('hex')}.tmp`,
          );
          let indexHandle;
          try {
            await assertDirectories();
            indexHandle = await open(indexTemp, 'wx', 0o600);
            await assertDirectories();
            const encoded = JSON.stringify(
              { version: 1, records: [...old.records, record] },
              null,
              2,
            );
            if (Buffer.byteLength(encoded) > MAX_INDEX_BYTES)
              throw new Error('Library manifest size limit reached');
            await indexHandle.writeFile(encoded);
            await indexHandle.sync();
            await indexHandle.close();
            indexHandle = undefined;
            assertCurrent();
            await assertDirectories();
            await rename(indexTemp, path.join(canonical, INDEX));
          } catch (e) {
            throw new Error('Audio saved; library index update failed', {
              cause: e,
            });
          } finally {
            await indexHandle?.close();
            await unlink(indexTemp).catch(() => {});
          }
          return { status: 'saved' as const, path: finalPath };
        } finally {
          await handle?.close();
          await unlink(temp).catch(() => {});
        }
      } finally {
        if (writer) {
          await writer.close();
          await unlink(writerPath).catch(() => {});
        }
      }
    });
  } finally {
    if (!mutex.isLocked() && locks.get(canonical) === mutex)
      locks.delete(canonical);
  }
}
