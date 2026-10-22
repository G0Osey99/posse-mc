// Chat in every version. minecraft-protocol already turns `chat` (≤1.18), signed `player_chat`
// (1.19+), `system_chat` and `profileless_chat` into `playerChat` / `systemChat` events and signs
// outgoing messages; this formats them like mineflayer (`message` / `messagestr`).
import type { PosseBot } from '../bot.js';
import { packetNames } from '../decode.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

const POSITIONS: Record<number, string> = { 0: 'chat', 1: 'system', 2: 'game_info' };
/** Messages held at most while the bot is out of the game. */
const MAX_HELD = 100;

/** Parses a JSON chat component, or wraps plain text. 1.20.3+ components already arrive as objects. */
export function parseComponent(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
}

export interface ChatHooks {
  setSend(fn: (message: string) => void): void;
  setTabComplete(fn: (text: string, assumeCommand?: boolean, sendBlockInSight?: boolean, timeout?: number) => Promise<string[]>): void;
}

export function installChat(bot: PosseBot, hooks: ChatHooks): void {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const ChatMessage = bot.ChatMessage;

  const fromNotch = (value: unknown): any => {
    try {
      return ChatMessage.fromNotch(value);
    } catch {
      return new ChatMessage({ text: typeof value === 'string' ? value : JSON.stringify(value) });
    }
  };

  client.on('playerChat', (data: any) => {
    let msg: any;
    if (sf('clientsideChatFormatting')) {
      const parameters = {
        sender: data.senderName ? parseComponent(data.senderName) : undefined,
        target: data.targetName ? parseComponent(data.targetName) : undefined,
        content: data.formattedMessage ? parseComponent(data.formattedMessage) : { text: data.plainMessage },
      };
      const index = data.type?.chatType ?? data.type;
      try {
        msg = ChatMessage.fromNetwork(index, parameters);
      } catch {
        msg = new ChatMessage(parameters.content);
      }
      if (data.unsignedContent) {
        // The server-decorated version is what the game shows (chat plugins render through it);
        // the signed text stays available as `signed`, the decorated one also as `unsigned`.
        try {
          const unsigned = ChatMessage.fromNetwork(index, { ...parameters, content: parseComponent(data.unsignedContent) });
          unsigned.signed = msg;
          unsigned.unsigned = unsigned;
          msg = unsigned;
        } catch {
          // keep the signed text
        }
      }
    } else {
      msg = fromNotch(data.formattedMessage);
    }
    bot.emit('message', msg, 'chat', data.sender, data.verified);
    if (bot.listenerCount('messagestr') > 0) bot.emit('messagestr', msg.toString(), 'chat', msg, data.sender, data.verified);
  });

  client.on('systemChat', (data: any) => {
    const msg = fromNotch(data.formattedMessage);
    const position = POSITIONS[data.positionId] ?? 'system';
    bot.emit('message', msg, position, null);
    if (bot.listenerCount('messagestr') > 0) bot.emit('messagestr', msg.toString(), position, msg, null);
    if (data.positionId === 2) bot.emit('actionBar', msg);
  });

  // 1.17+: the action bar has its own packet.
  client.on('action_bar', (packet: any) => bot.emit('actionBar', fromNotch(packet.text)));

  // ── Titles ──
  // A JSON string, or (1.20.3+) an NBT component, which fromNotch simplifies as a whole: unwrapping
  // only the outer tag left typed NBT inside (`extra` as {type:'list'…}) and lost styled parts.
  const titleText = (text: unknown): string => fromNotch(text).toString();
  // By packet, not feature flag: minecraft-data marks 1.17.0 as legacy, but it has set_title_*.
  if (!packetNames(bot.version, 'play').includes('set_title_text')) {
    // 1.11 inserted "action bar" as action 2: title, subtitle, [action bar], times, clear, reset.
    const actionBar = bot.registry.version['>=']('1.11');
    client.on('title', (packet: any) => {
      const action = actionBar || packet.action < 2 ? packet.action : packet.action + 1;
      if (action === 0) bot.emit('title', titleText(packet.text), 'title');
      else if (action === 1) bot.emit('title', titleText(packet.text), 'subtitle');
      else if (action === 2) bot.emit('actionBar', fromNotch(packet.text));
      else if (action === 3) bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut);
      else if (action === 4 || action === 5) bot.emit('title_clear');
    });
  } else {
    client.on('set_title_text', (packet: any) => bot.emit('title', titleText(packet.text), 'title'));
    client.on('set_title_subtitle', (packet: any) => bot.emit('title', titleText(packet.text), 'subtitle'));
    client.on('set_title_time', (packet: any) => bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut));
    client.on('clear_titles', () => bot.emit('title_clear'));
  }

  // ── Tab complete ──
  let transactionId = 0;
  const tabComplete = (text: string, assumeCommand = false, _sendBlockInSight = false, timeout = 5000): Promise<string[]> => {
    const id = (transactionId = (transactionId + 1) & 0x7fff);
    return new Promise((resolve, reject) => {
      const onReply = (packet: any): void => {
        if (packet.transactionId !== undefined && packet.transactionId !== id) return;
        cleanup();
        const matches = (packet.matches ?? []) as Array<string | { match: string }>;
        resolve(matches.map((m) => (typeof m === 'string' ? m : m.match)));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Tab complete for "${text}" timed out after ${timeout}ms`));
      }, timeout);
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeListener('tab_complete', onReply);
      };
      client.on('tab_complete', onReply);
      if (bot.registry.version['>=']('1.13')) client.write('tab_complete', { transactionId: id, text });
      else if (bot.registry.version['<']('1.9')) client.write('tab_complete', { text, block: undefined });
      else client.write('tab_complete', { text, assumeCommand, lookedAtBlock: undefined });
    });
  };
  hooks.setTabComplete(tabComplete);

  // ── Sending ──
  let send = (message: string): void => client.chat(message);
  if (sf('chatCommandsQueuedToMainThread')) {
    // 1.19.0 rejects a queued command as out-of-order if a chat message overtakes it; a tab
    // complete reply proves every earlier command was processed.
    let chain: Promise<void> = Promise.resolve();
    let commandPending = false;
    send = (message: string): void => {
      const isCommand = message.startsWith('/');
      chain = chain.then(async () => {
        if (!isCommand && commandPending) {
          commandPending = false;
          await tabComplete('/', false, false).catch(() => undefined);
        }
        client.chat(message);
        if (isCommand) commandPending = true;
      });
    };
  }
  // Outside the play state (before joining, or while a 1.20.2+ server or proxy has the bot back in
  // configuration) nothing can be sent: hold messages and send them once the bot is back in the game.
  const holdMs = bot.options.holdChatMs ?? 30_000;
  const held: Array<{ message: string; at: number }> = [];
  const flush = (): void => {
    const now = Date.now();
    for (const { message, at } of held.splice(0)) if (now - at <= holdMs) send(message);
  };
  // After the other login handlers (minecraft-protocol starts the chat session on login).
  client.on('login', () => setImmediate(flush));
  client.on('end', () => (held.length = 0));
  hooks.setSend((message) => {
    if (client.state === 'play' && held.length === 0) {
      send(message);
      return;
    }
    if (holdMs <= 0 || client.ended) return;
    held.push({ message, at: Date.now() });
    if (held.length > MAX_HELD) held.shift();
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
