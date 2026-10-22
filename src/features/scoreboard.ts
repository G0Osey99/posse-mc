// Scoreboards and teams. Sidebar lines are usually team prefix + entry + suffix; 1.20.3+ servers
// can instead give each score a display name (mineflayer ignores those and, since that version's
// `scoreboard_score` has no action field, never adds scores at all).
import type { PosseBot } from '../bot.js';
import type { ChatMessage, Scoreboard, ScoreboardItem, Team } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

const TEAM_MODES = ['add', 'remove', 'change', 'join', 'leave'];
const COLORS = [
  'black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green',
  'aqua', 'red', 'light_purple', 'yellow', 'white', 'obfuscated', 'bold', 'strikethrough', 'underlined', 'italic', 'reset',
];

export function colorName(color: number | undefined): string {
  if (color === undefined || color < 0 || color > 21) return 'reset';
  return COLORS[color]!;
}

/** Highest value first; ties keep insertion order reversed, like mineflayer. */
export function sortScores(items: ScoreboardItem[]): ScoreboardItem[] {
  return items.sort((a, b) => (a.value > b.value ? -1 : 1));
}

const DISPLAY_SLOTS: Record<string, number> = { list: 0, sidebar: 1, belowName: 2 };

export function installScoreboard(bot: PosseBot): void {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const ChatMessage = bot.ChatMessage;

  const parse = (value: unknown): ChatMessage => {
    if (value === undefined || value === null) return new ChatMessage('');
    if (sf('teamUsesChatComponents') || typeof value === 'object') {
      try {
        return ChatMessage.fromNotch(value);
      } catch {
        return new ChatMessage(String(value));
      }
    }
    const built = ChatMessage.MessageBuilder.fromString(String(value), { colorSeparator: '§' });
    return built === null ? new ChatMessage('') : new ChatMessage(built.toJSON());
  };

  const titleOf = (value: unknown): string => {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'string' ? parsed : new ChatMessage(parsed).toString();
      } catch {
        return value;
      }
    }
    return parse(value).toString();
  };

  const makeBoard = (name: string, title: unknown): Scoreboard => {
    const itemsMap: Record<string, ScoreboardItem> = {};
    return {
      name,
      title: titleOf(title),
      itemsMap,
      get items() {
        return sortScores(Object.values(itemsMap));
      },
    };
  };

  const makeItem = (name: string, value: number, display: unknown): ScoreboardItem => {
    const override = display === undefined || display === null ? null : parse(display);
    return {
      name,
      value,
      get displayName() {
        if (override) return override;
        const team = bot.teamMap[name];
        return team ? team.displayName(name) : new ChatMessage(name);
      },
    };
  };

  const resetSlots = (): void => {
    bot.scoreboards = {};
    bot.scoreboard = {};
    bot.teams = {};
    bot.teamMap = {};
  };
  resetSlots();
  client.on('login', resetSlots);

  const setSlot = (position: number, board: Scoreboard | undefined): void => {
    bot.scoreboard[position] = board;
    for (const [name, slot] of Object.entries(DISPLAY_SLOTS)) if (slot === position) bot.scoreboard[name] = board;
  };

  client.on('scoreboard_objective', (packet: any) => {
    const { name } = packet;
    if (packet.action === 0) {
      const board = makeBoard(name, packet.displayText);
      bot.scoreboards[name] = board;
      bot.emit('scoreboardCreated', board);
    } else if (packet.action === 1) {
      const board = bot.scoreboards[name];
      delete bot.scoreboards[name];
      for (const [slot, b] of Object.entries(bot.scoreboard)) if (b && b.name === name) delete bot.scoreboard[slot];
      if (board) bot.emit('scoreboardDeleted', board);
    } else if (packet.action === 2) {
      const board = bot.scoreboards[name];
      if (!board) return;
      board.title = titleOf(packet.displayText);
      bot.emit('scoreboardTitleChanged', board);
    }
  });

  const removeScore = (entry: string, objective: string | undefined): void => {
    const boards = objective ? [bot.scoreboards[objective]] : Object.values(bot.scoreboards);
    for (const board of boards) {
      if (!board || !(entry in board.itemsMap)) continue;
      const removed = board.itemsMap[entry];
      delete board.itemsMap[entry];
      bot.emit('scoreRemoved', board, removed);
    }
  };

  client.on('scoreboard_score', (packet: any) => {
    // ≤1.20.2: action 0 = set, 1 = remove; 1.20.3+: no action (always set; removal is reset_score).
    if (packet.action === 1) {
      removeScore(packet.itemName, packet.scoreName || undefined);
      return;
    }
    const board = bot.scoreboards[packet.scoreName];
    if (!board) return;
    const item = makeItem(packet.itemName, packet.value, packet.display_name);
    board.itemsMap[packet.itemName] = item;
    bot.emit('scoreUpdated', board, item);
  });
  client.on('reset_score', (packet: any) => removeScore(packet.entity_name, packet.objective_name ?? undefined));

  client.on('scoreboard_display_objective', (packet: any) => {
    const board = bot.scoreboards[packet.name];
    const previous = bot.scoreboard[packet.position];
    if (!board) {
      if (!packet.name) setSlot(packet.position, undefined);
      return;
    }
    setSlot(packet.position, board);
    bot.emit('scoreboardPosition', packet.position, board, previous);
  });

  // ── Teams ──
  const makeTeam = (id: string): Team => {
    const members = new Set<string>();
    const team: Team & { members: string[]; _members: Set<string> } = {
      team: id,
      name: new ChatMessage(''),
      prefix: new ChatMessage(''),
      suffix: new ChatMessage(''),
      color: 'reset',
      _members: members,
      get members() {
        return [...members];
      },
      displayName(member: string) {
        const name = team.prefix.clone();
        name.append(new ChatMessage({ text: member, color: team.color }), team.suffix);
        return name;
      },
    };
    return team;
  };
  const update = (team: Team, packet: any): void => {
    team.name = parse(packet.name);
    team.color = colorName(packet.formatting ?? packet.color); // `color` before 1.13
    team.prefix = parse(packet.prefix);
    team.suffix = parse(packet.suffix);
  };
  const members = (team: Team): Set<string> => (team as unknown as { _members: Set<string> })._members;

  const onTeam = (packet: any): void => {
    const id = packet.team as string;
    const players = (packet.players ?? []) as string[];
    const mode = typeof packet.mode === 'number' ? TEAM_MODES[packet.mode] : packet.mode;
    let team = bot.teams[id];
    switch (mode) {
      case 'add':
        team = makeTeam(id);
        update(team, packet);
        for (const p of players) {
          members(team).add(p);
          bot.teamMap[p] = team;
        }
        bot.teams[id] = team;
        bot.emit('teamCreated', team);
        break;
      case 'remove':
        if (!team) break;
        for (const p of members(team)) delete bot.teamMap[p];
        delete bot.teams[id];
        bot.emit('teamRemoved', team);
        break;
      case 'change':
        if (!team) break;
        update(team, packet);
        bot.emit('teamUpdated', team);
        break;
      case 'join':
        if (!team) break;
        for (const p of players) {
          members(team).add(p);
          bot.teamMap[p] = team;
        }
        bot.emit('teamUpdated', team);
        break;
      case 'leave':
        if (!team) break;
        for (const p of players) {
          members(team).delete(p);
          delete bot.teamMap[p];
        }
        bot.emit('teamUpdated', team);
        break;
    }
  };
  client.on(sf('teamUsesScoreboard') ? 'scoreboard_team' : 'teams', onTeam);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
