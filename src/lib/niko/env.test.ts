import { describe, it, expect, afterEach } from "vitest";
import { isNikoPhone, nikoAllowList } from "./env";

const original = process.env.NIKO_PHONE_NUMBERS;
afterEach(() => {
  if (original === undefined) delete process.env.NIKO_PHONE_NUMBERS;
  else process.env.NIKO_PHONE_NUMBERS = original;
});

describe("Niko routing gate", () => {
  it("matches an allow-listed number with or without a country code", () => {
    process.env.NIKO_PHONE_NUMBERS = "919742355944";
    expect(isNikoPhone("919742355944")).toBe(true);
    expect(isNikoPhone("+91 97423 55944")).toBe(true);
    expect(isNikoPhone("9742355944")).toBe(true);
  });

  it("routes nobody to Niko until NIKO_PHONE_NUMBERS is set", () => {
    // The built-in default allow-list is empty, so an unconfigured
    // deployment sends every inbound to Oliday. Niko is opt-in per
    // number via the env var.
    delete process.env.NIKO_PHONE_NUMBERS;
    expect(isNikoPhone("919742355944")).toBe(false);
    expect(isNikoPhone("919901855444")).toBe(false);
  });

  it("does NOT match another number — Oliday leads must fall through", () => {
    process.env.NIKO_PHONE_NUMBERS = "919742355944";
    expect(isNikoPhone("919901855444")).toBe(false);
    expect(isNikoPhone("917006171731")).toBe(false);
    expect(isNikoPhone(null)).toBe(false);
    expect(isNikoPhone("")).toBe(false);
  });

  it("an explicit empty list disables Niko entirely", () => {
    process.env.NIKO_PHONE_NUMBERS = "";
    expect(nikoAllowList()).toEqual([]);
    expect(isNikoPhone("919742355944")).toBe(false);
  });

  it("takes a comma-separated list in any format", () => {
    process.env.NIKO_PHONE_NUMBERS = "+91 99000 11111, 919888822222";
    expect(nikoAllowList()).toEqual(["919900011111", "919888822222"]);
    expect(isNikoPhone("919900011111")).toBe(true);
    expect(isNikoPhone("919742355944")).toBe(false);
  });
});
