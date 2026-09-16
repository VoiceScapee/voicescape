import { describe, expect, it } from "vitest";
import { normalizeTipInput, TIP_CURRENCY_KEY, TIP_PANEL_EVENT } from "./tip-currency";

describe("normalizeTipInput", () => {
  it("adds the leading zero when the amount starts with a dot", () => {
    expect(normalizeTipInput(".37")).toBe("0.37");
    expect(normalizeTipInput(".")).toBe("0.");
  });

  it("strips non-numeric characters", () => {
    expect(normalizeTipInput("$5.00")).toBe("5.00");
    expect(normalizeTipInput("1a2b")).toBe("12");
  });

  it("leaves normal amounts untouched", () => {
    expect(normalizeTipInput("5")).toBe("5");
    expect(normalizeTipInput("0.37")).toBe("0.37");
    expect(normalizeTipInput("")).toBe("");
  });
});

describe("tip-currency constants", () => {
  it("uses stable storage/event keys", () => {
    expect(TIP_CURRENCY_KEY).toBe("vs-tip-currency");
    expect(TIP_PANEL_EVENT).toBe("vs-tip-panel");
  });
});
