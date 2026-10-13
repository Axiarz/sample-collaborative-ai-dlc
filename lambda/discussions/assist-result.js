import { query } from './clients.js';
import { acceptAssistResult } from './data-access.js';
import { mapMessage } from './mappers.js';

export const createAssistResultHandler =
  (run = query) =>
  async (event) => {
    if (
      !event ||
      !['completed', 'failed'].includes(event.status) ||
      !['intentId', 'discussionId', 'messageId', 'requestId'].every(
        (key) =>
          typeof event[key] === 'string' && event[key].length > 0 && event[key].length <= 512,
      ) ||
      (event.attemptId !== undefined && !/^[a-f0-9-]{36}$/.test(event.attemptId)) ||
      typeof event.content !== 'string' ||
      Buffer.byteLength(event.content) > 128 * 1024
    )
      return { ok: false };
    const result = await run((g) => acceptAssistResult(g, event));
    return { ok: true, message: result ? mapMessage(result) : null };
  };
export const handler = createAssistResultHandler();
