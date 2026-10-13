// Bounded JSON-RPC transport only. The caller owns session authorization,
// permission policy, process lifetime, and closing the child streams.
export const KIRO_ACP_LIMITS = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxPendingRequests: 8,
  defaultTimeoutMs: 30_000,
});

const ERROR_CODES = new Set([
  'INVALID_OPTIONS',
  'INVALID_REQUEST',
  'FRAME_LIMIT',
  'INPUT_LIMIT',
  'OUTPUT_LIMIT',
  'PENDING_LIMIT',
  'INVALID_JSON',
  'INVALID_MESSAGE',
  'UNEXPECTED_RESPONSE',
  'RPC_ERROR',
  'TIMEOUT',
  'CALLBACK_ERROR',
  'STREAM_ERROR',
  'EOF',
  'TRUNCATED_FRAME',
  'CLOSED',
]);

export class KiroAcpError extends Error {
  constructor(code, rpcCode) {
    const safeCode = ERROR_CODES.has(code) ? code : 'INVALID_MESSAGE';
    super(`Kiro ACP transport: ${safeCode}`);
    this.name = 'KiroAcpError';
    this.code = `KIRO_ACP_${safeCode}`;
    if (safeCode === 'RPC_ERROR' && Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode;
  }
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const validId = (value) =>
  Number.isSafeInteger(value) ||
  (typeof value === 'string' && value.length > 0 && value.length <= 256);
const validMethod = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validParams = (value) => record(value) || Array.isArray(value);
const ignoreLateError = () => {};
const cancelled = () => ({ outcome: { outcome: 'cancelled' } });

export function createKiroAcpClient({
  input,
  output,
  onUpdate = () => {},
  onPermission = cancelled,
  ...overrides
} = {}) {
  const limits = { ...KIRO_ACP_LIMITS, ...overrides };
  if (
    typeof input?.on !== 'function' ||
    typeof input?.off !== 'function' ||
    typeof input?.listeners !== 'function' ||
    typeof input?.resume !== 'function' ||
    typeof input?.pause !== 'function' ||
    typeof input?.read !== 'function' ||
    typeof output?.on !== 'function' ||
    typeof output?.off !== 'function' ||
    typeof output?.listeners !== 'function' ||
    typeof output.write !== 'function' ||
    typeof onUpdate !== 'function' ||
    typeof onPermission !== 'function' ||
    Object.keys(limits).some(
      (key) =>
        !own(KIRO_ACP_LIMITS, key) ||
        !(
          positiveInteger(limits[key]) ||
          (['maxInputBytes', 'maxOutputBytes'].includes(key) && limits[key] === null)
        ),
    ) ||
    limits.defaultTimeoutMs > 2_147_483_647
  )
    throw new KiroAcpError('INVALID_OPTIONS');

  const pending = new Map();
  const serverRequests = new Set();
  const callbacks = new Set();
  const updates = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let terminal = null;
  let inputEnded = false;
  let nextId = 1;
  let updateSequence = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let frame = Buffer.alloc(0);
  let frameLength = 0;
  let chunk = Buffer.alloc(0);
  let offset = 0;
  let draining = false;
  let updateBlocked = false;

  const listeners = [
    [input, 'readable', receive],
    [input, 'end', end],
    [input, 'close', end],
    [input, 'error', streamError],
    [output, 'error', streamError],
    [output, 'close', streamError],
    [output, 'finish', streamError],
  ];

  function stop(error) {
    if (terminal) return;
    terminal = error;
    for (const [stream, event, listener] of listeners) stream.off(event, listener);
    // The process owner may end/destroy these streams after disposing us.
    for (const stream of new Set([input, output])) {
      if (!stream.listeners('error').includes(ignoreLateError)) stream.on('error', ignoreLateError);
    }
    input.resume();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const job of callbacks) {
      clearTimeout(job.timer);
      job.done();
    }
    callbacks.clear();
    updates.clear();
    serverRequests.clear();
    frame = Buffer.alloc(0);
    frameLength = 0;
    chunk = Buffer.alloc(0);
    offset = 0;
    updateBlocked = false;
  }

  function streamError() {
    stop(new KiroAcpError('STREAM_ERROR'));
  }

  function end() {
    if (terminal) return;
    inputEnded = true;
    finishInput();
  }

  function finishInput() {
    if (terminal || !inputEnded || updateBlocked || offset < chunk.length) return;
    if (frameLength) {
      stop(new KiroAcpError('TRUNCATED_FRAME'));
      return;
    }
    // Complete frames may still be awaiting their microtask or update callback.
    // EOF closes new requests but does not discard those validated responses.
    for (const [id, item] of pending) {
      if (!item.responded) {
        clearTimeout(item.timer);
        pending.delete(id);
        item.reject(new KiroAcpError('EOF'));
      }
    }
    if (!pending.size) stop(new KiroAcpError('EOF'));
  }

  function send(packet) {
    if (terminal) throw terminal;
    let text;
    try {
      text = JSON.stringify(packet);
    } catch {
      throw new KiroAcpError('INVALID_REQUEST');
    }
    const size = Buffer.byteLength(text);
    if (size > limits.maxFrameBytes) throw new KiroAcpError('FRAME_LIMIT');
    if (limits.maxOutputBytes !== null) {
      if (outputBytes + size + 1 > limits.maxOutputBytes) throw new KiroAcpError('OUTPUT_LIMIT');
      outputBytes += size + 1;
    }
    try {
      output.write(`${text}\n`, (error) => {
        if (error) streamError();
      });
    } catch {
      throw new KiroAcpError('STREAM_ERROR');
    }
  }

  // Update projection settles before the next update or final response. An
  // asynchronous projection holds upstream reads, not an expanding job queue.
  // Permission callbacks retain their separate bounded request handling.
  function call(callback, params, success, sequence = null) {
    if (callbacks.size >= limits.maxPendingRequests) throw new KiroAcpError('PENDING_LIMIT');
    let result;
    try {
      result = callback(params);
      if (!result || typeof result.then !== 'function') {
        success(result);
        return;
      }
    } catch {
      throw new KiroAcpError('CALLBACK_ERROR');
    }
    let done;
    const completion = new Promise((resolve) => {
      done = resolve;
    });
    const job = {
      done,
      timer:
        sequence === null
          ? setTimeout(() => stop(new KiroAcpError('TIMEOUT')), limits.defaultTimeoutMs)
          : null,
    };
    callbacks.add(job);
    if (sequence !== null) updates.set(sequence, completion);
    const finish = () => {
      clearTimeout(job.timer);
      callbacks.delete(job);
      if (sequence !== null) updates.delete(sequence);
      done();
    };
    void Promise.resolve(result).then(
      (value) => {
        if (!terminal) {
          try {
            success(value);
          } catch {
            stop(new KiroAcpError('CALLBACK_ERROR'));
          }
        }
        finish();
      },
      () => {
        stop(new KiroAcpError('CALLBACK_ERROR'));
        finish();
      },
    );
    return completion;
  }

  function message(value) {
    if (!record(value) || value.jsonrpc !== '2.0') throw new KiroAcpError('INVALID_MESSAGE');
    if (own(value, 'method')) {
      if (
        !validMethod(value.method) ||
        own(value, 'result') ||
        own(value, 'error') ||
        (own(value, 'params') && !validParams(value.params))
      )
        throw new KiroAcpError('INVALID_MESSAGE');
      const params = value.params ?? {};
      if (!own(value, 'id')) {
        if (value.method === 'session/update')
          return call(onUpdate, params, () => {}, ++updateSequence);
        return;
      }
      if (!validId(value.id) || serverRequests.has(value.id))
        throw new KiroAcpError('INVALID_MESSAGE');
      if (value.method !== 'session/request_permission') {
        send({
          jsonrpc: '2.0',
          id: value.id,
          error: { code: -32601, message: 'Method not found' },
        });
        return;
      }
      if (serverRequests.size >= limits.maxPendingRequests) throw new KiroAcpError('PENDING_LIMIT');
      serverRequests.add(value.id);
      call(onPermission, params, (result) => {
        const outcome = result?.outcome;
        if (
          !record(outcome) ||
          (outcome.outcome !== 'cancelled' &&
            !(outcome.outcome === 'selected' && validMethod(outcome.optionId)))
        )
          throw new KiroAcpError('CALLBACK_ERROR');
        send({ jsonrpc: '2.0', id: value.id, result });
        serverRequests.delete(value.id);
      });
      return;
    }
    if (
      !validId(value.id) ||
      own(value, 'params') ||
      own(value, 'result') === own(value, 'error') ||
      (own(value, 'error') &&
        (!record(value.error) ||
          !Number.isSafeInteger(value.error.code) ||
          typeof value.error.message !== 'string'))
    )
      throw new KiroAcpError('INVALID_MESSAGE');
    const item = pending.get(value.id);
    if (!item || item.responded) throw new KiroAcpError('UNEXPECTED_RESPONSE');
    item.responded = true;
    item.response = value;
  }

  function scheduleResponses() {
    for (const [id, item] of pending) {
      if (!item.responded || item.scheduled) continue;
      item.scheduled = true;
      queueMicrotask(() => {
        if (terminal) return;
        if (frameLength || updateBlocked || offset < chunk.length || input.readableLength) {
          item.scheduled = false;
          return;
        }
        const precedingUpdates = [...updates]
          .filter(([sequence]) => sequence > item.updateSequence)
          .map(([, completion]) => completion);
        if (precedingUpdates.length)
          void Promise.all(precedingUpdates).then(() => settleResponse(id, item));
        else settleResponse(id, item);
      });
    }
  }

  function settleResponse(id, item) {
    if (terminal) return;
    if (frameLength || updateBlocked || offset < chunk.length || input.readableLength) {
      item.scheduled = false;
      return;
    }
    pending.delete(id);
    clearTimeout(item.timer);
    const value = item.response;
    if (own(value, 'error')) item.reject(new KiroAcpError('RPC_ERROR', value.error.code));
    else item.resolve(value.result);
    if (inputEnded && !pending.size) stop(new KiroAcpError('EOF'));
  }

  function consume(bytes) {
    let value;
    try {
      value = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new KiroAcpError('INVALID_JSON');
    }
    return message(value);
  }

  function append(bytes) {
    if (frameLength + bytes.length > limits.maxFrameBytes) throw new KiroAcpError('FRAME_LIMIT');
    if (frame.length < frameLength + bytes.length) {
      const next = Buffer.alloc(
        Math.min(
          limits.maxFrameBytes,
          Math.max(frameLength + bytes.length, frame.length * 2, 1024),
        ),
      );
      frame.copy(next, 0, 0, frameLength);
      frame = next;
    }
    bytes.copy(frame, frameLength);
    frameLength += bytes.length;
  }

  function receive() {
    if (terminal || draining || updateBlocked) return;
    draining = true;
    try {
      while (!terminal && !updateBlocked) {
        if (offset === chunk.length) {
          // Never retain an arbitrary producer chunk or concatenate a burst.
          // Pull at most 64 KiB; the stream's high-water mark propagates pressure
          // to the child pipe while a projection is pending.
          chunk = input.read(Math.min(input.readableLength, 64 * 1024)) ?? Buffer.alloc(0);
          offset = 0;
          if (!chunk.length) break;
          if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
          if (limits.maxInputBytes !== null) {
            inputBytes += chunk.length;
            if (inputBytes > limits.maxInputBytes) throw new KiroAcpError('INPUT_LIMIT');
          }
        }
        const newline = chunk.indexOf(10, offset);
        const last = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(offset, last);
        offset = newline === -1 ? last : last + 1;
        let completion;
        if (newline === -1 || frameLength) {
          append(part);
          if (newline !== -1) {
            const complete = frame.subarray(0, frameLength);
            frameLength = 0;
            completion = consume(complete);
          }
        } else {
          if (part.length > limits.maxFrameBytes) throw new KiroAcpError('FRAME_LIMIT');
          completion = consume(part);
        }
        if (completion) {
          updateBlocked = true;
          void completion.then(() => {
            updateBlocked = false;
            receive();
          });
        }
      }
      // Responses cannot overtake queued, partial, or pressure-held updates,
      // including later frames in the same producer write.
      if (!frameLength && !updateBlocked && offset === chunk.length) scheduleResponses();
      finishInput();
    } catch (error) {
      stop(error instanceof KiroAcpError ? error : new KiroAcpError('INVALID_MESSAGE'));
    } finally {
      draining = false;
    }
  }

  async function request(method, params = {}, { timeoutMs = limits.defaultTimeoutMs } = {}) {
    if (terminal) throw terminal;
    if (inputEnded) throw new KiroAcpError('EOF');
    if (
      !validMethod(method) ||
      !validParams(params) ||
      (timeoutMs !== null && (!positiveInteger(timeoutMs) || timeoutMs > 2_147_483_647))
    )
      throw new KiroAcpError('INVALID_REQUEST');
    if (pending.size >= limits.maxPendingRequests) throw new KiroAcpError('PENDING_LIMIT');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null ? null : setTimeout(() => stop(new KiroAcpError('TIMEOUT')), timeoutMs);
      pending.set(id, { resolve, reject, timer, updateSequence, responded: false });
      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        stop(error);
      }
    });
  }

  // Notifications are queued synchronously; no response or pending slot exists.
  function notify(method, params = {}) {
    if (terminal) throw terminal;
    if (inputEnded) throw new KiroAcpError('EOF');
    if (!validMethod(method) || !validParams(params)) throw new KiroAcpError('INVALID_REQUEST');
    try {
      send({ jsonrpc: '2.0', method, params });
    } catch (error) {
      stop(error);
      throw error;
    }
  }

  const dispose = () => stop(new KiroAcpError('CLOSED'));
  input.pause();
  for (const [stream, event, listener] of listeners) stream.on(event, listener);
  if (input.readableEnded || input.destroyed || output.writableEnded || output.destroyed) end();
  return { request, notify, dispose, close: dispose };
}
