import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sampleNativeResources,
  startNativeResourceTelemetry,
} from '../native/resource-telemetry.js';

const GiB = 1024 ** 3;
const system = {
  uptime: () => 312.9,
  totalmem: () => 8 * GiB,
  freemem: () => GiB,
  loadavg: () => [1.234, 0, 0],
};
const proc = {
  memoryUsage: () => ({ rss: 300 * 1024 ** 2, heapUsed: 90 * 1024 ** 2 }),
  uptime: () => 41.7,
};
const cgroup = {
  '/sys/fs/cgroup/memory.current': '7516192768\n',
  '/sys/fs/cgroup/memory.max': 'max\n',
  '/sys/fs/cgroup/memory.peak': '8589934592\n',
  '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n',
  '/proc/vmstat': 'nr_free_pages 1\noom_kill 3\nnr_foll_pin_acquired 0\n',
};
const read = vi.fn(async (path) => {
  if (Object.hasOwn(cgroup, path)) return cgroup[path];
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
});
const readdir = vi.fn(async () => ['1', '17', '204', 'self', 'meminfo']);
const statfs = vi.fn(async (path) => ({
  bsize: 4096,
  blocks: path === '/tmp' ? 1000 : 2000,
  bavail: path === '/tmp' ? 10 : 500,
}));

afterEach(() => vi.useRealTimers());

describe('native resource samples', () => {
  it('reports cgroup memory, OOM counters, processes and free disk as numbers only', async () => {
    const sample = await sampleNativeResources({
      reason: 'busy',
      read,
      readdir,
      statfs,
      system,
      proc,
      now: () => 5,
    });
    expect(sample).toEqual({
      type: 'native.resources',
      reason: 'busy',
      at: 5,
      systemUptimeSeconds: 312,
      processUptimeSeconds: 41,
      rssBytes: 300 * 1024 ** 2,
      heapUsedBytes: 90 * 1024 ** 2,
      systemTotalBytes: 8 * GiB,
      systemFreeBytes: GiB,
      load1: 1.23,
      processes: 3,
      kernelOomKills: 3,
      cgroup: { currentBytes: 7516192768, maxBytes: null, peakBytes: 8 * GiB, oom: 1, oomKill: 1 },
      disks: {
        root: { freeBytes: 500 * 4096, totalBytes: 2000 * 4096 },
        tmp: { freeBytes: 10 * 4096, totalBytes: 1000 * 4096 },
        homes: { freeBytes: 500 * 4096, totalBytes: 2000 * 4096 },
      },
    });
    // No path, name or other free text ever enters the record.
    const values = JSON.stringify(sample).match(/:"[^"]*"/g);
    expect(values).toEqual([':"native.resources"', ':"busy"']);
  });

  it('degrades to nulls when every source is unavailable, without throwing', async () => {
    const fail = vi.fn(async () => {
      throw new Error('denied');
    });
    const sample = await sampleNativeResources({
      reason: 'boot',
      read: fail,
      readdir: fail,
      statfs: fail,
      system,
      proc,
    });
    expect(sample.cgroup).toEqual({
      currentBytes: null,
      maxBytes: null,
      peakBytes: null,
      oom: null,
      oomKill: null,
    });
    expect(sample.processes).toBeNull();
    expect(sample.kernelOomKills).toBeNull();
    expect(sample.disks).toEqual({ root: null, tmp: null, homes: null });
  });

  it('ignores malformed cgroup values', async () => {
    const bad = vi.fn(
      async (path) =>
        ({
          '/sys/fs/cgroup/memory.current': '-1\n',
          '/sys/fs/cgroup/memory.max': '1e9',
          '/sys/fs/cgroup/memory.peak': '',
          '/sys/fs/cgroup/memory.events': 'oom x\noom_kill -2\n',
        })[path],
    );
    const sample = await sampleNativeResources({
      reason: 'busy',
      read: bad,
      readdir,
      statfs,
      system,
      proc,
    });
    expect(sample.cgroup).toEqual({
      currentBytes: null,
      maxBytes: null,
      peakBytes: null,
      oom: null,
      oomKill: null,
    });
  });
});

describe('native resource telemetry cadence', () => {
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('logs at boot, every interval while busy, once on return to idle, and never while idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let busy = false;
    const log = vi.fn();
    const sample = vi.fn(async ({ reason }) => ({ type: 'native.resources', reason }));
    const stop = startNativeResourceTelemetry({
      isBusy: () => busy,
      intervalMs: 1000,
      log,
      sample,
      proc: fakeProc(),
    });
    await flush();
    vi.advanceTimersByTime(3000);
    await flush();
    busy = true;
    vi.advanceTimersByTime(1000);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    busy = false;
    vi.advanceTimersByTime(1000);
    await flush();
    vi.advanceTimersByTime(3000);
    await flush();
    stop();
    expect(log.mock.calls.map(([event]) => event.reason)).toEqual(['boot', 'busy', 'busy', 'idle']);
  });

  it('adds the flight recorder window maxima to each sample', async () => {
    const log = vi.fn();
    const window = vi.fn(() => ({ maxLagMs: 12, maxUsedMB: 2539, maxProcs: 12, samples: 15 }));
    const stop = startNativeResourceTelemetry({
      isBusy: () => false,
      log,
      window,
      sample: async ({ reason }) => ({ type: 'native.resources', reason }),
      proc: fakeProc(),
    });
    await flush();
    stop();
    expect(log).toHaveBeenCalledWith({
      type: 'native.resources',
      reason: 'boot',
      window: { maxLagMs: 12, maxUsedMB: 2539, maxProcs: 12, samples: 15 },
    });
  });

  it('never lets a sampling failure escape', async () => {
    const log = vi.fn();
    const stop = startNativeResourceTelemetry({
      isBusy: () => true,
      log,
      sample: async () => {
        throw new Error('boom');
      },
      proc: fakeProc(),
    });
    await flush();
    stop();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs SIGTERM and re-raises it with the default disposition', () => {
    const p = fakeProc();
    const log = vi.fn();
    startNativeResourceTelemetry({ isBusy: () => true, log, sample: async () => ({}), proc: p });
    p.emit('SIGTERM');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'native.signal', signal: 'SIGTERM', busy: true }),
    );
    expect(p.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    // The handler was registered once, so the re-raised signal terminates normally.
    expect(p.listenerCount('SIGTERM')).toBe(0);
  });
});
