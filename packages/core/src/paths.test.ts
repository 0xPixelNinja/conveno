import { describe, expect, it } from "vitest";
import { dataDir, dataPaths } from "./paths.js";

describe("dataDir", () => {
  it("linux: XDG_DATA_HOME, else ~/.local/share", () => {
    expect(dataDir("linux", { XDG_DATA_HOME: "/x/data" })).toBe("/x/data/conveno");
    expect(dataDir("linux", { HOME: "/home/u" })).toBe("/home/u/.local/share/conveno");
    expect(dataDir("linux", { XDG_DATA_HOME: "relative", HOME: "/home/u" })).toBe(
      "/home/u/.local/share/conveno",
    );
    expect(dataDir("linux", {}, "/h")).toBe("/h/.local/share/conveno");
  });
  it("darwin: Application Support", () => {
    expect(dataDir("darwin", { HOME: "/Users/u", XDG_DATA_HOME: "/ignored" })).toBe(
      "/Users/u/Library/Application Support/conveno",
    );
  });
  it("win32: LOCALAPPDATA, else AppData\\Local", () => {
    expect(dataDir("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\conveno",
    );
    expect(dataDir("win32", { USERPROFILE: "C:\\Users\\u" })).toBe(
      "C:\\Users\\u\\AppData\\Local\\conveno",
    );
  });
  it("throws without any home", () => {
    for (const p of ["linux", "darwin", "win32"]) expect(() => dataDir(p, {})).toThrow();
  });
  it("builds file paths with the platform separator", () => {
    expect(dataPaths("linux", "/d/conveno").token).toBe("/d/conveno/daemon.token");
    expect(dataPaths("win32", "C:\\d\\conveno").token).toBe("C:\\d\\conveno\\daemon.token");
    expect(dataPaths("darwin", "/d").backups).toBe("/d/backups");
  });
});
