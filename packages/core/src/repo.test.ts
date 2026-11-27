import { describe, expect, it } from "vitest";
import { baseName, detectRepo } from "./repo.js";

const fsOf = (...existing: string[]) => ({ exists: (p: string) => existing.includes(p) });

describe("detectRepo", () => {
  it("finds the git root above cwd", async () => {
    const r = await detectRepo("/w/api/src/deep", fsOf("/w/api/.git"));
    expect(r).toEqual({ root: "/w/api", basename: "api" });
  });
  it("finds a root at cwd itself", async () => {
    expect((await detectRepo("/w/api", fsOf("/w/api/.git"))).root).toBe("/w/api");
  });
  it("uses the nearest root (nested repos)", async () => {
    const r = await detectRepo("/w/mono/pkg/a", fsOf("/w/mono/.git", "/w/mono/pkg/.git"));
    expect(r.root).toBe("/w/mono/pkg");
  });
  it("falls back to the cwd basename outside a repo", async () => {
    expect(await detectRepo("/tmp/scratch", fsOf())).toEqual({ root: null, basename: "scratch" });
  });
  it("handles filesystem roots", async () => {
    expect(await detectRepo("/", fsOf())).toEqual({ root: null, basename: "workspace" });
  });
  it("supports async fs and windows paths", async () => {
    const fs = { exists: async (p: string) => p === "C:\\src\\app\\.git" };
    expect(await detectRepo("C:\\src\\app\\lib", fs)).toEqual({
      root: "C:\\src\\app",
      basename: "app",
    });
    expect((await detectRepo("C:\\x\\y", fs)).root).toBeNull();
  });
  it("baseName tolerates trailing separators", () => {
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("C:\\a\\b\\")).toBe("b");
  });
});
