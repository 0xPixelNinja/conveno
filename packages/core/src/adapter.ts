import type { CliKind } from "@conveno/protocol";
import type { ConvenoClient } from "./client.js";

export interface ConfigChange {
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
