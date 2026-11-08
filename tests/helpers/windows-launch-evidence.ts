import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type Launch = (
  file: string,
  args: string[],
  options: { windowsHide: true; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

/** Test-only observer. Never publishes arguments, paths, output or error text. */
export function windowsLaunchEvidence(launch: Launch = spawn) {
  const rows: {
    spawned: boolean;
    launchError: boolean;
    processError: boolean;
    stdinError: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    frame:
      | 'none'
      | 'read'
      | 'ready'
      | 'committed'
      | 'failure'
      | 'invalid'
      | 'oversize';
    close: 'not-closed' | 'zero' | 'nonzero' | 'signal';
    elapsedMs: number;
  }[] = [];
  return {
    launch(file: string, args: string[], options: Parameters<Launch>[2]) {
      const started = performance.now();
      const row: (typeof rows)[number] = {
        spawned: false,
        launchError: false,
        processError: false,
        stdinError: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        frame: 'none',
        close: 'not-closed',
        elapsedMs: 0,
      };
      rows.push(row);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = launch(file, args, options);
      } catch (error) {
        row.launchError = true;
        row.elapsedMs = Math.round(performance.now() - started);
        throw error;
      }
      let buffer = Buffer.alloc(0);
      child.once('spawn', () => {
        row.spawned = true;
      });
      child.once('error', () => {
        row.processError = true;
      });
      child.stdin.once('error', () => {
        row.stdinError = true;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        row.stderrBytes = Math.min(1025, row.stderrBytes + chunk.length);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        row.stdoutBytes = Math.min(1048577, row.stdoutBytes + chunk.length);
        if (row.stdoutBytes > 1048576) {
          row.frame = 'oversize';
          buffer = Buffer.alloc(0);
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        for (let end; (end = buffer.indexOf(10)) >= 0; ) {
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          try {
            const packet = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(line),
            );
            row.frame =
              packet?.version === 1 &&
              ['read', 'ready', 'committed', 'failure'].includes(packet.type)
                ? packet.type
                : 'invalid';
          } catch {
            row.frame = 'invalid';
          }
        }
      });
      child.once('close', (code, signal) => {
        row.elapsedMs = Math.round(performance.now() - started);
        row.close = signal ? 'signal' : code === 0 ? 'zero' : 'nonzero';
        buffer = Buffer.alloc(0);
      });
      return child;
    },
    snapshot: () => rows.map((row) => ({ ...row })),
  };
}
