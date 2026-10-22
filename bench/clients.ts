// The client side of the bench: the bot slice it uses, and the Posse loader.

/** The part of the mineflayer API the bench and the verifier touch (Posse implements it too). */
export interface BenchBot {
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  chat(message: string): void;
  clickWindow(slot: number, button: number, mode: number): Promise<unknown>;
  quit?(reason?: string): void;
  end?(reason?: string): void;
  players: Record<string, unknown>;
  scoreboard?: Record<string, unknown>;
  entities?: Record<string, unknown>;
  entity?: { position: { y: number; offset(x: number, y: number, z: number): unknown } };
  blockAt?(pos: unknown): { name: string } | null;
  _client?: { on(event: string, listener: (...args: never[]) => void): unknown };
}

export interface BotFactory {
  createBot(options: Record<string, unknown>): BenchBot;
}

export async function loadPosse(): Promise<BotFactory> {
  const { createBot } = await import('../src/index.js');
  return { createBot: createBot as unknown as BotFactory['createBot'] };
}

export async function loadMineflayer(): Promise<BotFactory> {
  const mineflayer = (await import('mineflayer')).default;
  return { createBot: (o) => mineflayer.createBot(o as never) as unknown as BenchBot };
}
