import * as fs from 'node:fs/promises';
import os from 'node:os';

// Fixed-schema resource telemetry for the per-run native runtime. A runtime
// that is killed (memory exhaustion, microVM recycle) leaves no log line of
// its own, so the last samples before a silent death are the only evidence.
// Numbers only: no paths, process names, identities, prompts or content.
export const NATIVE_RESOURCE_SAMPLE_MS = 15_000;
const DISKS = { root: '/', tmp: '/tmp', homes: '/home/node' };
const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const parseBytes = (text) => {
  const value = text?.trim();
  if (value === 'max') return null;
  return /^\d{1,19}$/.test(value ?? '') ? integer(Number(value)) : null;
};

const cgroupMemory = async (read) => {
  const file = async (name) => read(`/sys/fs/cgroup/${name}`, 'utf8').catch(() => null);
  const [current, max, peak, events] = await Promise.all(
    ['memory.current', 'memory.max', 'memory.peak', 'memory.events'].map(file),
  );
  const counters = Object.fromEntries(
    (events ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([key, value]) => ['oom', 'oom_kill'].includes(key) && /^\d{1,19}$/.test(value ?? ''))
      .map(([key, value]) => [key, integer(Number(value))]),
  );
  return {
    currentBytes: parseBytes(current),
    maxBytes: parseBytes(max),
    peakBytes: parseBytes(peak),
    oom: counters.oom ?? null,
    oomKill: counters.oom_kill ?? null,
  };
};

const diskFree = async (statfs) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(DISKS).map(async ([name, path]) => {
        try {
          const stat = await statfs(path);
          return [
            name,
            {
              freeBytes: integer(stat.bavail * stat.bsize),
              totalBytes: integer(stat.blocks * stat.bsize),
            },
          ];
        } catch {
          return [name, null];
        }
      }),
    ),
  );

// Kernel-wide OOM kills: visible even when the runtime is not in its own
// memory cgroup (the cgroup counters are then unavailable).
const kernelOomKills = async (read) => {
  const text = await read('/proc/vmstat', 'utf8').catch(() => null);
  const match = /^oom_kill (\d{1,19})$/m.exec(text ?? '');
  return match ? integer(Number(match[1])) : null;
};

const processCount = async (readdir) => {
  try {
    return (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).length;
  } catch {
    return null;
  }
};

/** One sample; never throws and never reads beyond the fixed sources above. */
export const sampleNativeResources = async ({
  reason,
  read = fs.readFile,
  readdir = fs.readdir,
  statfs = fs.statfs,
  system = os,
  proc = process,
  now = Date.now,
} = {}) => {
  const memory = proc.memoryUsage();
  return {
    type: 'native.resources',
    reason,
    at: now(),
    systemUptimeSeconds: Math.floor(system.uptime()),
    processUptimeSeconds: Math.floor(proc.uptime()),
    rssBytes: integer(memory.rss),
    heapUsedBytes: integer(memory.heapUsed),
    systemTotalBytes: integer(system.totalmem()),
    systemFreeBytes: integer(system.freemem()),
    load1: Number(system.loadavg()[0].toFixed(2)),
    processes: await processCount(readdir),
    kernelOomKills: await kernelOomKills(read),
    cgroup: await cgroupMemory(read),
    disks: await diskFree(statfs),
  };
};

/**
 * Log a boot sample, then a sample every interval while the runtime is busy and
 * one when it returns to idle. SIGTERM is logged and then re-raised with the
 * default disposition, so termination behaves exactly as without telemetry.
 */
export const startNativeResourceTelemetry = ({
  isBusy,
  intervalMs = NATIVE_RESOURCE_SAMPLE_MS,
  log = (event) => console.info(JSON.stringify(event)),
  sample = sampleNativeResources,
  window = null,
  proc = process,
} = {}) => {
  let wasBusy = false;
  let pending = false;
  const emit = async (reason) => {
    if (pending) return;
    pending = true;
    try {
      const recorded = await sample({ reason });
      // Maxima the flight recorder saw since the previous sample.
      log(window ? { ...recorded, window: window() } : recorded);
    } catch {
      // Telemetry must never affect execution.
    } finally {
      pending = false;
    }
  };
  void emit('boot');
  const timer = setInterval(() => {
    const busy = isBusy() === true;
    if (busy) void emit('busy');
    else if (wasBusy) void emit('idle');
    wasBusy = busy;
  }, intervalMs);
  timer.unref?.();
  const onTerm = () => {
    log({ type: 'native.signal', signal: 'SIGTERM', at: Date.now(), busy: isBusy() === true });
    proc.kill(proc.pid, 'SIGTERM');
  };
  proc.once('SIGTERM', onTerm);
  return () => {
    clearInterval(timer);
    proc.removeListener('SIGTERM', onTerm);
  };
};
