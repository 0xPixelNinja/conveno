import { newSessionId, RpcErrorCode, SESSION_NAME_PATTERN, SessionName } from "@conveno/protocol";
import { describe, expect, it } from "vitest";
import { ConvenoError } from "./errors.js";
import {
  generateSessionName,
  nameMatchesPattern,
  sanitizeNamePart,
  validateRename,
} from "./naming.js";
import { rng, sess } from "./test-utils.js";

describe("generateSessionName", () => {
  it("starts at 1", () => {
    expect(generateSessionName("claude", "api", [])).toBe("claude@api-1");
  });
  it("picks the lowest free n", () => {
    const s = [sess("claude@api-1"), sess("claude@api-3")];
    expect(generateSessionName("claude", "api", s)).toBe("claude@api-2");
  });
  it("reuses numbers held only by offline sessions", () => {
    const s = [sess("claude@api-1", "offline"), sess("claude@api-2")];
    expect(generateSessionName("claude", "api", s)).toBe("claude@api-1");
  });
  it("is per cli and repo", () => {
    const s = [sess("claude@api-1")];
    expect(generateSessionName("codex", "api", s)).toBe("codex@api-1");
    expect(generateSessionName("claude", "web", s)).toBe("claude@web-1");
  });
  it("sanitizes awkward directory names", () => {
    expect(generateSessionName("claude", "My Project!", [])).toBe("claude@my-project-1");
    expect(generateSessionName("claude", "...", [])).toBe(
      "claude@...-1".replace("...", "workspace"),
    );
    expect(sanitizeNamePart("")).toBe("workspace");
  });
  it("always yields a valid, unique name (property)", () => {
    const r = rng(7);
    const alphabet = "abcXYZ019 _.-@/é中!";
    for (let i = 0; i < 200; i++) {
      const repo = Array.from(
        { length: Math.floor(r() * 90) },
        () => alphabet[Math.floor(r() * alphabet.length)],
      ).join("");
      const existing = Array.from({ length: Math.floor(r() * 5) }, (_, k) =>
        sess(
          generateSessionName("claude", repo, []).replace(/-1$/, `-${k + 1}`),
          r() < 0.3 ? "offline" : "idle",
        ),
      );
      const name = generateSessionName("claude", repo, existing);
      expect(SESSION_NAME_PATTERN.test(name)).toBe(true);
      expect(SessionName.safeParse(name).success).toBe(true);
      expect(existing.some((e) => e.status !== "offline" && e.name === name)).toBe(false);
    }
  });
});

describe("validateRename", () => {
  const a = sess("claude@api-1");
  const b = sess("codex@api-1");
  const gone = sess("old", "offline");
  const all = [a, b, gone];
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof ConvenoError ? e.code : "other";
    }
    return "none";
  };

  it("accepts a free name and the own name", () => {
    expect(validateRename(a.id, "planner", all)).toBe("planner");
    expect(validateRename(a.id, "claude@api-1", all)).toBe("claude@api-1");
  });
  it("conflicts with another active session (-32006)", () => {
    expect(code(() => validateRename(a.id, "codex@api-1", all))).toBe(RpcErrorCode.Conflict);
  });
  it("allows taking a name held by an offline session", () => {
    expect(validateRename(a.id, "old", all)).toBe("old");
  });
  it("rejects invalid and reserved names", () => {
    for (const bad of ["", "Upper", "-x", "has space", "a".repeat(65), "orchestrator"]) {
      expect(code(() => validateRename(a.id, bad, all))).toBe(RpcErrorCode.InvalidParams);
    }
  });
});

describe("reserved names", () => {
  it.each(["conveno", "orchestrator", "system", "user"])("refuses %s on rename", (name) => {
    expect(() => validateRename(newSessionId(), name, [])).toThrow(/reserved/);
  });
});

describe("nameMatchesPattern", () => {
  it("matches an exact name only", () => {
    expect(nameMatchesPattern("claude@api-1", "claude@api-1")).toBe(true);
    expect(nameMatchesPattern("claude@api-1", "claude@api-10")).toBe(false);
  });
  it("lets * match any run, including none", () => {
    expect(nameMatchesPattern("claude@conveno-real-*", "claude@conveno-real-abc-1")).toBe(true);
    expect(nameMatchesPattern("*-1", "codex@api-1")).toBe(true);
    expect(nameMatchesPattern("claude@*", "claude@")).toBe(true);
    expect(nameMatchesPattern("*", "anything")).toBe(true);
    expect(nameMatchesPattern("a*c*e", "abcde")).toBe(true);
    expect(nameMatchesPattern("a*c*e", "abcdf")).toBe(false);
  });
  it("anchors both ends and treats the dot literally", () => {
    expect(nameMatchesPattern("claude*", "xclaude")).toBe(false);
    expect(nameMatchesPattern("a.b*", "axb-1")).toBe(false);
    expect(nameMatchesPattern("a.b*", "a.b-1")).toBe(true);
  });
});
