import type { CliKind } from "@conveno/protocol";
import type { ConvenoClient } from "./client.js";

/** The part of a CLI's setup a change belongs to. */
export type ConfigComponent = "mcp" | "hooks";

export interface ConfigChange {
  /** Which part of the setup this change adds or fixes. `conveno doctor` reads it. */
  component: ConfigComponent;
  /**
   * `add` when nothing of that part is set up yet. `update` when Conveno's entry exists but is out
   * of date, such as an upgrade that adds a setting or a moved `conveno` command. `remove` is for
   * an uninstall plan.
   */
  kind: "add" | "update" | "remove";
  path: string;
  before: string | null;
  after: string;
  description: string;
  viaCommand?: string[];
}

export interface Detection {
  installed: boolean;
  version?: string;
  binary?: string;
  configPaths: string[];
}

export interface HookOutput {
  stdout: string;
  exitCode: 0;
}

export interface AdapterEnv {
  home: string;
  platform: NodeJS.Platform;
  cwd: string;
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  conveno: { command: string[] };
  /** Process environment as the caller sees it. Adapters read env vars from here, never from process.env. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface HookContext {
  client: ConvenoClient;
  /** The CLI process above the hook, passed to `session.byHost`. */
  hostPid: number;
}

export interface Adapter {
  cli: CliKind;
  displayName: string;
  deliveryTier: "next_turn" | "inbox";
  detect(env: AdapterEnv): Promise<Detection>;
  /** Idempotent: empty when already installed. */
  plan(env: AdapterEnv): Promise<ConfigChange[]>;
  uninstallPlan(env: AdapterEnv): Promise<ConfigChange[]>;
  hook(event: string, input: unknown, ctx: HookContext): Promise<HookOutput>;
}
