// Cookies (1.20.5+): servers store small blobs on the client and ask for them back, typically across
// a transfer. minecraft-protocol doesn't answer cookie requests, so a server (or proxy) that asks
// would wait until it times out the login.
import type { PosseBot } from '../bot.js';
import { packetNames } from '../decode.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/** The game's limits: 5 KiB per cookie; Posse also caps how many it keeps. */
const MAX_COOKIE_BYTES = 5120;
const MAX_COOKIES = 64;

export function installCookies(bot: PosseBot): void {
  if (!packetNames(bot.version, 'login').includes('cookie_request')) return;
  const client = bot._client as any;
  client.on('store_cookie', (packet: any) => {
    const value = Buffer.from(packet.value ?? []);
    if (value.length > MAX_COOKIE_BYTES) return;
    if (!bot.cookies.has(packet.key) && bot.cookies.size >= MAX_COOKIES) return;
    bot.cookies.set(packet.key, value);
  });
  client.on('cookie_request', (packet: any) => {
    client.write('cookie_response', { key: packet.cookie, value: bot.cookies.get(packet.cookie) });
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
