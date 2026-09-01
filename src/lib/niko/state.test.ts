import { describe, it, expect } from "vitest";
import {
  emptyNiko,
  mergeNiko,
  nikoFallback,
  parseNiko,
  recap,
  HISTORY_LIMIT,
} from "./state";
import { nextMissing } from "./services";

describe("parseNiko", () => {
  it("survives junk in the column", () => {
    for (const junk of [null, undefined, 42, "nope", [], { service: "yoga" }]) {
      expect(parseNiko(junk)).toEqual(emptyNiko());
    }
  });

  it("drops fields that aren't non-empty strings", () => {
    const s = parseNiko({
      service: "movie",
      fields: { city: "Bengaluru", seats: "  ", movie: 3 },
      stage: "collecting",
    });
    expect(s.fields).toEqual({ city: "Bengaluru" });
  });
});

describe("mergeNiko", () => {
  it("keeps the user's first answer — a later restatement can't drift it", () => {
    const s1 = mergeNiko(emptyNiko(), {
      service: "restaurant",
      extractedFields: { when: "Friday 6pm" },
    });
    const s2 = mergeNiko(s1, { extractedFields: { when: "sometime evening" } });
    expect(s2.fields.when).toBe("Friday 6pm");
  });

  it("ignores fields the service never asks for", () => {
    const s = mergeNiko(emptyNiko(), {
      service: "movie",
      extractedFields: { city: "Bengaluru", pickup: "hallucinated" },
    });
    expect(s.fields).toEqual({ city: "Bengaluru" });
  });

  it("clears collected fields when the service switches", () => {
    const s1 = mergeNiko(emptyNiko(), {
      service: "restaurant",
      extractedFields: { city: "Bengaluru", partySize: "4" },
    });
    const s2 = mergeNiko(s1, { service: "airport_cab" });
    expect(s2.service).toBe("airport_cab");
    expect(s2.fields).toEqual({});
  });

  it("derives the stage instead of trusting the model", () => {
    // Model claims confirmed while three fields are still missing.
    const s = mergeNiko(emptyNiko(), {
      service: "airport_cab",
      extractedFields: { pickup: "Indiranagar" },
      requestConfirmed: true,
    });
    expect(s.stage).toBe("collecting");
    expect(nextMissing("airport_cab", s.fields)?.key).toBe("drop");
  });

  it("reaches 'confirming' when complete, 'submitted' only on a yes", () => {
    const full = {
      service: "airport_cab",
      extractedFields: {
        pickup: "Indiranagar",
        drop: "BLR T2",
        when: "Sep 3, 5am",
        passengers: "2 with bags",
      },
    };
    const collected = mergeNiko(emptyNiko(), full);
    expect(collected.stage).toBe("confirming");
    const confirmed = mergeNiko(collected, { requestConfirmed: true });
    expect(confirmed.stage).toBe("submitted");
  });

  it("writes history once on the transition, not on every later turn", () => {
    const collected = mergeNiko(emptyNiko(), {
      service: "movie",
      extractedFields: {
        city: "Bengaluru",
        movie: "Dune 3",
        when: "Sat 9pm",
        seats: "2",
      },
    });
    const first = mergeNiko(collected, { requestConfirmed: true }, "2026-09-01");
    expect(first.history).toHaveLength(1);
    expect(first.history[0].summary).toContain("Dune 3");
    expect(first.history[0].at).toBe("2026-09-01");
    const again = mergeNiko(first, { requestConfirmed: true }, "2026-09-01");
    expect(again.history).toHaveLength(1);
  });

  it("caps history", () => {
    let s = emptyNiko();
    s = { ...s, history: Array.from({ length: HISTORY_LIMIT }, () => ({
      service: "movie" as const, summary: "old", at: "2026-01-01",
    })) };
    const complete = mergeNiko(s, {
      service: "movie",
      extractedFields: { city: "B", movie: "M", when: "W", seats: "2" },
    });
    const done = mergeNiko(complete, { requestConfirmed: true });
    expect(done.history).toHaveLength(HISTORY_LIMIT);
    expect(done.history[0].summary).toContain("movie tickets");
  });

  it("updates preferences — unlike request fields, these are meant to change", () => {
    const s1 = mergeNiko(emptyNiko(), { preferences: { home: "Indiranagar" } });
    const s2 = mergeNiko(s1, { preferences: { home: "Koramangala" } });
    expect(s2.prefs.home).toBe("Koramangala");
  });
});

describe("fallback", () => {
  it("offers the service menu when nothing is picked", () => {
    const { text, options } = nikoFallback(emptyNiko());
    expect(text).toContain("Niko");
    expect(options).toContain("Airport cab");
  });

  it("asks for the next missing field", () => {
    const s = mergeNiko(emptyNiko(), {
      service: "medicine",
      extractedFields: { items: "Crocin" },
    });
    expect(nikoFallback(s).text).toBe("Where should they be delivered?");
  });

  it("recaps and asks for a yes once complete", () => {
    const s = mergeNiko(emptyNiko(), {
      service: "medicine",
      extractedFields: { items: "Crocin", address: "Indiranagar", urgency: "today" },
    });
    const { text, options } = nikoFallback(s);
    expect(text).toContain("Crocin");
    expect(options).toEqual(["Yes, go ahead", "Change something"]);
    expect(recap(s)).toContain("medicine order");
  });
});
