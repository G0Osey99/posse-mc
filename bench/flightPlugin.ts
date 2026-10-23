// A tiny Bukkit plugin for the live harness on Paper: `posseflight <player> on|off` grants or takes
// flight in survival, like a factions server's /fly. Built once with the JDK's javac against
// stand-ins for the few Bukkit types it uses (no API jar needed), so the same jar loads on Paper
// 1.8.8 through the latest.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLUGIN = `package posse.flight;

import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

public class PosseFlight extends JavaPlugin {
  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (args.length != 2) return false;
    Player player = Bukkit.getPlayerExact(args[0]);
    if (player == null) {
      System.out.println("posseflight: no player " + args[0]);
      return true;
    }
    boolean on = args[1].equals("on");
    player.setAllowFlight(on);
    if (!on) player.setFlying(false);
    System.out.println("posseflight: " + args[0] + " " + (on ? "may fly" : "may not fly"));
    return true;
  }
}
`;

// Stand-ins with the real signatures; only the plugin class goes into the jar.
const STUBS: Record<string, string> = {
  'org/bukkit/Bukkit.java': 'package org.bukkit; public final class Bukkit { public static org.bukkit.entity.Player getPlayerExact(String name) { return null; } }',
  'org/bukkit/command/Command.java': 'package org.bukkit.command; public abstract class Command {}',
  'org/bukkit/command/CommandSender.java': 'package org.bukkit.command; public interface CommandSender {}',
  'org/bukkit/entity/Player.java': 'package org.bukkit.entity; public interface Player { void setAllowFlight(boolean flight); void setFlying(boolean value); }',
  'org/bukkit/plugin/java/JavaPlugin.java':
    'package org.bukkit.plugin.java; public abstract class JavaPlugin { public boolean onCommand(org.bukkit.command.CommandSender sender, org.bukkit.command.Command command, String label, String[] args) { return false; } }',
};

const PLUGIN_YML = `name: PosseFlight
main: posse.flight.PosseFlight
version: '1.0'
api-version: '1.13'
commands:
  posseflight:
    description: Grants or takes flight (live harness)
    usage: /posseflight <player> on|off
`;

/** Builds (once) the plugin jar under `<dir>/jars`; returns its path. Needs a JDK (javac, jar). */
export async function flightPluginJar(dir: string): Promise<string> {
  const jar = path.resolve(dir, 'jars', 'PosseFlight.jar');
  if (existsSync(jar)) return jar;
  const work = path.resolve(dir, 'build', 'posse-flight');
  await rm(work, { recursive: true, force: true });
  const src = path.join(work, 'src');
  const out = path.join(work, 'classes');
  const files: string[] = [];
  for (const [file, code] of Object.entries({ ...STUBS, 'posse/flight/PosseFlight.java': PLUGIN })) {
    const target = path.join(src, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, code);
    files.push(target);
  }
  await mkdir(out, { recursive: true });
  await run('javac', ['--release', '8', '-nowarn', '-d', out, ...files]);
  await writeFile(path.join(out, 'plugin.yml'), PLUGIN_YML);
  await mkdir(path.dirname(jar), { recursive: true });
  await run('jar', ['cf', jar, '-C', out, 'plugin.yml', '-C', out, 'posse']);
  return jar;
}
