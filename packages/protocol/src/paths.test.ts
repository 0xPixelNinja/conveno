import { describe, expect, it } from "vitest";
import { defaultSocketPath } from "./paths.js";

describe("defaultSocketPath", () => {
  it("linux: uses XDG_RUNTIME_DIR when set", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/u" })).toBe(
      "/run/user/1000/caucus/caucusd.sock",
    );
  });

  it("linux: strips trailing slashes", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "/run/user/1000/" })).toBe(
      "/run/user/1000/caucus/caucusd.sock",
    );
  });

  it("linux: falls back to ~/.caucus/run", () => {
    expect(defaultSocketPath("linux", { HOME: "/home/u" })).toBe(
      "/home/u/.caucus/run/caucusd.sock",
    );
  });

  it("linux: ignores an empty or relative XDG_RUNTIME_DIR", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "", HOME: "/home/u" })).toBe(
      "/home/u/.caucus/run/caucusd.sock",
    );
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "relative", HOME: "/home/u" })).toBe(
      "/home/u/.caucus/run/caucusd.sock",
    );
  });

  it("darwin: has no XDG dir by default, so uses the home fallback", () => {
    expect(defaultSocketPath("darwin", { HOME: "/Users/u" })).toBe(
      "/Users/u/.caucus/run/caucusd.sock",
    );
  });

  it("posix: uses the homedir argument when HOME is unset; throws with neither", () => {
    expect(defaultSocketPath("darwin", {}, "/Users/x/")).toBe("/Users/x/.caucus/run/caucusd.sock");
    expect(() => defaultSocketPath("linux", {})).toThrow(/home/);
  });

  it("win32: returns a named pipe with the username", () => {
    expect(defaultSocketPath("win32", { USERNAME: "alice" })).toBe("\\\\.\\pipe\\caucusd-alice");
  });

  it("win32: sanitises unusual usernames and ignores XDG/HOME", () => {
    expect(
      defaultSocketPath("win32", { USERNAME: "Bob Smith\\x", HOME: "/h", XDG_RUNTIME_DIR: "/x" }),
    ).toBe("\\\\.\\pipe\\caucusd-Bob_Smith_x");
  });

  it("win32: falls back to a generic user name", () => {
    expect(defaultSocketPath("win32", {})).toBe("\\\\.\\pipe\\caucusd-user");
  });
});
