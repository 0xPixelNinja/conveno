import type { CliKind } from "@0xpixelninja/conveno-protocol";
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
}

export interface HookContext {
  client: ConvenoClient;
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
