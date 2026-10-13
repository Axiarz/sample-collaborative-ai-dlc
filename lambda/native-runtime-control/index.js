import { invokeNativeAuthority } from './authority-client.js';

// Transport has no table permissions. The authority verifies the original JWT.
export const handler = (event) => invokeNativeAuthority('commands', event);
