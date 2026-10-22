// Chat in every version. minecraft-protocol already turns `chat` (≤1.18), signed `player_chat`
// (1.19+), `system_chat` and `profileless_chat` into `playerChat` / `systemChat` events and signs
// outgoing messages; this formats them like mineflayer (`message` / `messagestr`).
import type { PosseBot } from '../bot.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

const POSITIONS: Record<number, string> = { 0: 'chat', 1: 'system', 2: 'game_info' };

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
        try {
          msg.unsigned = ChatMessage.fromNetwork(index, { ...parameters, content: parseComponent(data.unsignedContent) });
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
  const titleText = (text: unknown): string => {
    const value = text && typeof text === 'object' && 'value' in (text as object) ? (text as { value: unknown }).value : text;
    return fromNotch(parseComponent(value)).toString();
  };
  if (sf('titleUsesLegacyPackets')) {
    client.on('title', (packet: any) => {
      if (packet.action === 0) bot.emit('title', titleText(packet.text), 'title');
      else if (packet.action === 1) bot.emit('title', titleText(packet.text), 'subtitle');
      else if (packet.action === 2) bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut);
      else if (packet.action === 3 && packet.fadeIn !== undefined) bot.emit('title_times', packet.fadeIn, packet.stay, packet.fadeOut);
      else if (packet.action === 3 || packet.action === 4) bot.emit('title_clear');
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
  hooks.setSend((message) => {
    if (client.state !== 'play') return;
    send(message);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
