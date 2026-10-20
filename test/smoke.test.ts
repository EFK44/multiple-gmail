import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("smoke", () => {
  it("exposes a semver VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
