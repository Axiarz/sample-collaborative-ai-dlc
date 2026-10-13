import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';

export const openNativeGraph = async (env = process.env) => {
  const credentials = await fromNodeProviderChain()();
  const { url, headers } = getUrlAndHeaders(
    env.NEPTUNE_ENDPOINT,
    '8182',
    { ...credentials, region: env.AWS_REGION },
    '/gremlin',
    'wss',
  );
  const connection = new gremlin.driver.DriverRemoteConnection(url, { headers });
  return {
    g: gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection),
    close: () => connection.close(),
  };
};
