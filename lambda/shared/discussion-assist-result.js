import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
// Quorum submits an observation. Only the discussion owner conditionally
// accepts it against the pending request/attempt and redaction state.
export const submitDiscussionAssistResult = async (
  result,
  { client = lambda, functionName = process.env.DISCUSSION_RESULT_FUNCTION } = {},
) => {
  if (!functionName) throw new Error('Discussion result owner is not configured');
  const response = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(result)),
    }),
  );
  if (response.FunctionError) throw new Error('Discussion result acceptance unavailable');
  const accepted = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
  if (!accepted.ok) throw new Error('Discussion result acceptance failed');
  return accepted.message;
};
