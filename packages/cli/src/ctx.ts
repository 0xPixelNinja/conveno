import type { Theme } from "@0xpixelninja/conveno-brand";
import type { connect } from "@0xpixelninja/conveno-client";
import type { Adapter, AdapterEnv } from "@0xpixelninja/conveno-core";
import type { CliKind } from "@0xpixelninja/conveno-protocol";

/** Everything a command touches outside its own arguments. Tests build one with fakes. */
export interface Ctx {
  home: string;
  platform: NodeJS.Platform;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
  /** Daemon socket. Undefined means the client's platform default. */
  socketPath?: string;
  /** Path to the daemon's entry script, passed to every `connect`. */
  daemonEntry?: string;
  /** Command that starts this conveno, written into CLI configs. */
  conveno: { command: string[] };
  adapters: Adapter[];
  exec: AdapterEnv["exec"];
  theme: Theme;
  /** Standard output: results. */
  out(text: string): void;
  /** Standard error: warnings, errors, prompts. */
  err(text: string): void;
  /** Can we ask the user a question. */
  interactive: boolean;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  now(): Date;
  readStdin(): Promise<string>;
  connect: typeof connect;
  ppid: number;
  /** Parent of a process, or null when unknown. Best effort, used to find the CLI above a shell. */
  parentOf(pid: number): Promise<number | null>;
  runMcp(opts: { cli: CliKind; daemonEntry?: string }): Promise<void>;
  /** Run a hook within this many ms or give up. */
  hookTimeoutMs: number;
}

export const adapterEnv = (ctx: Ctx): AdapterEnv => ({
  home: ctx.home,
  platform: ctx.platform,
  cwd: ctx.cwd,
  exec: ctx.exec,
  conveno: ctx.conveno,
  env: ctx.env,
});

export const connectOpts = (ctx: Ctx, autoStart: boolean) => ({
  kind: "cli" as const,
  dataDir: ctx.dataDir,
  autoStart,
  ...(ctx.socketPath ? { socketPath: ctx.socketPath } : {}),
  ...(ctx.daemonEntry ? { daemonEntry: ctx.daemonEntry } : {}),
});
