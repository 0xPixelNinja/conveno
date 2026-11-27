import { describe, expect, it } from "vitest";
import { defaultSocketPath, isSocketPathTooLong, socketPathTooLongMessage } from "./paths.js";

describe("defaultSocketPath", () => {
  it("linux: uses XDG_RUNTIME_DIR when set", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/u" })).toBe(
      "/run/user/1000/conveno/convenod.sock",
    );
  });

  it("linux: strips trailing slashes", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "/run/user/1000/" })).toBe(
      "/run/user/1000/conveno/convenod.sock",
    );
  });

  it("linux: falls back to ~/.conveno/run", () => {
    expect(defaultSocketPath("linux", { HOME: "/home/u" })).toBe(
      "/home/u/.conveno/run/convenod.sock",
    );
  });

  it("linux: ignores an empty or relative XDG_RUNTIME_DIR", () => {
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "", HOME: "/home/u" })).toBe(
      "/home/u/.conveno/run/convenod.sock",
    );
    expect(defaultSocketPath("linux", { XDG_RUNTIME_DIR: "relative", HOME: "/home/u" })).toBe(
      "/home/u/.conveno/run/convenod.sock",
    );
  });

  it("darwin: has no XDG dir by default, so uses the home fallback", () => {
    expect(defaultSocketPath("darwin", { HOME: "/Users/u" })).toBe(
      "/Users/u/.conveno/run/convenod.sock",
    );
  });

  it("posix: uses the homedir argument when HOME is unset; throws with neither", () => {
    expect(defaultSocketPath("darwin", {}, "/Users/x/")).toBe(
      "/Users/x/.conveno/run/convenod.sock",
    );
    expect(() => defaultSocketPath("linux", {})).toThrow(/home/);
  });

  it("win32: returns a named pipe with the username", () => {
    expect(defaultSocketPath("win32", { USERNAME: "alice" })).toBe("\\\\.\\pipe\\convenod-alice");
  });

  it("win32: sanitises unusual usernames and ignores XDG/HOME", () => {
    expect(
      defaultSocketPath("win32", { USERNAME: "Bob Smith\\x", HOME: "/h", XDG_RUNTIME_DIR: "/x" }),
    ).toBe("\\\\.\\pipe\\convenod-Bob_Smith_x");
  });

  it("win32: falls back to a generic user name", () => {
    expect(defaultSocketPath("win32", {})).toBe("\\\\.\\pipe\\convenod-user");
  });
});

describe("isSocketPathTooLong", () => {
  const pathOf = (n: number) => `/${"a".repeat(n - 1)}`;
  it("allows up to 103 bytes on macOS and 107 elsewhere", () => {
    expect(isSocketPathTooLong(pathOf(103), "darwin")).toBe(false);
    expect(isSocketPathTooLong(pathOf(104), "darwin")).toBe(true);
    expect(isSocketPathTooLong(pathOf(107), "linux")).toBe(false);
    expect(isSocketPathTooLong(pathOf(108), "linux")).toBe(true);
  });
  it("never applies to Windows pipes", () => {
    expect(isSocketPathTooLong(`\\\\.\\pipe\\${"a".repeat(300)}`, "win32")).toBe(false);
  });
});

describe("socketPathTooLongMessage", () => {
  it("names the path, the size, the limit and the fix", () => {
    const p = `/${"a".repeat(120)}`;
    const m = socketPathTooLongMessage(p, "linux");
    expect(m).toContain(p);
    expect(m).toContain("121 bytes");
    expect(m).toContain("limit is 107");
    expect(m).toContain("XDG_RUNTIME_DIR");
  });
});
