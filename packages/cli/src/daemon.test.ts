import { describe, expect, it } from "vitest";
import { isConvenoDaemonCommand } from "./daemon.js";

describe("isConvenoDaemonCommand", () => {
  it("accepts the daemon.js of an installed @conveno/cli on every OS", () => {
    for (const line of [
      "node /usr/lib/node_modules/@conveno/cli/dist/daemon.js",
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@conveno\\cli\\dist\\daemon.js',
      "/usr/bin/node /home/u/.local/share/pnpm/global/5/.pnpm/@conveno+cli@0.1.1/node_modules/@conveno/cli/dist/daemon.js",
    ]) {
      expect(isConvenoDaemonCommand(line), line).toBe(true);
    }
  });

  it("still accepts the daemon package of releases before 0.1.1", () => {
    for (const line of [
      "node /usr/lib/node_modules/@conveno/cli/node_modules/@conveno/daemon/dist/bin.js",
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@conveno\\cli\\node_modules\\@conveno\\daemon\\dist\\bin.js',
      "/usr/bin/node /home/u/.local/share/pnpm/global/5/.pnpm/@conveno+cli@0.1.0/node_modules/@conveno/daemon/dist/bin.js",
    ]) {
      expect(isConvenoDaemonCommand(line), line).toBe(true);
    }
  });

  it("accepts the entry script this install resolved, however it is spelled", () => {
    const entry = "/work/conveno/packages/daemon/dist/bin.js";
    expect(isConvenoDaemonCommand(`node ${entry}`, entry)).toBe(true);
    const win = "C:\\work\\conveno\\packages\\daemon\\dist\\bin.js";
    expect(
      isConvenoDaemonCommand(`node.exe ${win}`, "C:/work/conveno/packages/daemon/dist/bin.js"),
    ).toBe(true);
    expect(isConvenoDaemonCommand(`node.exe ${win.toUpperCase()}`, win)).toBe(true);
  });

  it("rejects anything else, including look-alikes", () => {
    for (const line of [
      "node -e setInterval(() => {}, 1000)",
      "node /work/app/server.js",
      "node C:\\tools\\other\\bin.js",
      "/usr/bin/vim notes-about-@conveno/daemon.txt",
      "node /x/@conveno/daemon/dist/other.js",
      "node /x/@conveno/daemon-extras/dist/bin.js",
      "node /x/@conveno/cli/dist/bin.js",
      "node /x/@conveno/cli-extras/dist/daemon.js",
    ]) {
      expect(isConvenoDaemonCommand(line, "/work/conveno/packages/daemon/dist/bin.js"), line).toBe(
        false,
      );
    }
    expect(isConvenoDaemonCommand("node /work/app/server.js")).toBe(false);
  });
});
