import { describe, it, expect } from "vitest";
import { computeTrustLabel } from "../src/utils/trust-labels.js";

describe("computeTrustLabel", () => {
  // =========================================================================
  // 1. "Untrusted" — count >= 5 AND avg < -50
  // =========================================================================
  describe("Untrusted (count >= 5, avg < -50)", () => {
    it("matches at exact boundary: count=5, avg=-51", () => {
      const result = computeTrustLabel(5, -51);
      expect(result.label).toBe("Untrusted");
      expect(result.emoji).toBe("\u{1F534}");
      expect(result.display).toContain("-51/100");
      expect(result.display).toContain("5 reviews");
    });

    it("matches with extreme values: count=100, avg=-100", () => {
      expect(computeTrustLabel(100, -100).label).toBe("Untrusted");
    });

    it("does NOT match at avg=-50 exactly (not < -50)", () => {
      expect(computeTrustLabel(5, -50).label).not.toBe("Untrusted");
    });

    it("does NOT match with count=4 even if avg is very low", () => {
      // count < 5 means this rule is skipped; falls to "Caution" (avg < 0)
      expect(computeTrustLabel(4, -80).label).toBe("Caution");
    });
  });

  // =========================================================================
  // 2. "Caution" — avg < 0 (catches everything with negative avg not already Untrusted)
  // =========================================================================
  describe("Caution (avg < 0)", () => {
    it("matches at avg=-1 with any count", () => {
      const result = computeTrustLabel(1, -1);
      expect(result.label).toBe("Caution");
      expect(result.emoji).toBe("\u{1F7E0}");
    });

    it("matches at avg=-50 with count=5 (boundary not caught by Untrusted)", () => {
      // Untrusted requires avg < -50, so avg=-50 falls through to Caution
      expect(computeTrustLabel(5, -50).label).toBe("Caution");
    });

    it("matches with count=0 and avg=-10", () => {
      expect(computeTrustLabel(0, -10).label).toBe("Caution");
    });

    it("does NOT match at avg=0 exactly", () => {
      expect(computeTrustLabel(1, 0).label).not.toBe("Caution");
    });
  });

  // =========================================================================
  // 3. "Highly Trusted" — count >= 20 AND avg >= 80
  // =========================================================================
  describe("Highly Trusted (count >= 20, avg >= 80)", () => {
    it("matches at exact boundary: count=20, avg=80", () => {
      const result = computeTrustLabel(20, 80);
      expect(result.label).toBe("Highly Trusted");
      expect(result.emoji).toBe("\u2B50");
      expect(result.display).toContain("80/100");
      expect(result.display).toContain("20 reviews");
    });

    it("matches with high values: count=1000, avg=100", () => {
      expect(computeTrustLabel(1000, 100).label).toBe("Highly Trusted");
    });

    it("does NOT match with count=19 even if avg=100", () => {
      // Falls to Trusted (count >= 10, avg >= 70)
      expect(computeTrustLabel(19, 100).label).toBe("Trusted");
    });

    it("does NOT match with avg=79 even if count=100", () => {
      // Falls to Trusted (count >= 10, avg >= 70)
      expect(computeTrustLabel(100, 79).label).toBe("Trusted");
    });
  });

  // =========================================================================
  // 4. "Trusted" — count >= 10 AND avg >= 70
  // =========================================================================
  describe("Trusted (count >= 10, avg >= 70)", () => {
    it("matches at exact boundary: count=10, avg=70", () => {
      const result = computeTrustLabel(10, 70);
      expect(result.label).toBe("Trusted");
      expect(result.emoji).toBe("\u{1F7E2}");
    });

    it("matches at count=19, avg=79 (just below Highly Trusted)", () => {
      expect(computeTrustLabel(19, 79).label).toBe("Trusted");
    });

    it("does NOT match with count=9", () => {
      // Falls to Established (count >= 5, avg >= 50)
      expect(computeTrustLabel(9, 70).label).toBe("Established");
    });

    it("does NOT match with avg=69", () => {
      // Falls to Established (count >= 5, avg >= 50) if count >= 5
      expect(computeTrustLabel(10, 69).label).toBe("Established");
    });
  });

  // =========================================================================
  // 5. "Established" — count >= 5 AND avg >= 50
  // =========================================================================
  describe("Established (count >= 5, avg >= 50)", () => {
    it("matches at exact boundary: count=5, avg=50", () => {
      const result = computeTrustLabel(5, 50);
      expect(result.label).toBe("Established");
      expect(result.emoji).toBe("\u{1F7E2}");
    });

    it("matches at count=9, avg=69 (just below Trusted)", () => {
      expect(computeTrustLabel(9, 69).label).toBe("Established");
    });

    it("does NOT match with count=4", () => {
      // Falls to Emerging (count > 0)
      expect(computeTrustLabel(4, 50).label).toBe("Emerging");
    });

    it("does NOT match with avg=49", () => {
      // Falls to Emerging (count > 0)
      expect(computeTrustLabel(5, 49).label).toBe("Emerging");
    });
  });

  // =========================================================================
  // 6. "Emerging" — count > 0
  // =========================================================================
  describe("Emerging (count > 0)", () => {
    it("matches with count=1, avg=0", () => {
      const result = computeTrustLabel(1, 0);
      expect(result.label).toBe("Emerging");
      expect(result.emoji).toBe("\u{1F535}");
    });

    it("matches with count=4, avg=49 (below Established threshold)", () => {
      expect(computeTrustLabel(4, 49).label).toBe("Emerging");
    });

    it("matches with count=1, avg=99 (high avg but low count)", () => {
      expect(computeTrustLabel(1, 99).label).toBe("Emerging");
    });

    it("does NOT match with count=0", () => {
      expect(computeTrustLabel(0, 0).label).not.toBe("Emerging");
    });
  });

  // =========================================================================
  // 7. "No Data" — count = 0 (fallback)
  // =========================================================================
  describe("No Data (count = 0)", () => {
    it("matches with count=0, avg=0", () => {
      const result = computeTrustLabel(0, 0);
      expect(result.label).toBe("No Data");
      expect(result.emoji).toBe("\u26AA");
      expect(result.display).toBe("\u26AA No Data -- 0/100 (0 reviews)");
    });

    it("matches with count=0 regardless of avg value", () => {
      // avg could be anything when count=0, but avg < 0 check comes first
      // count=0, avg=50 -> avg is not < -50 (skip Untrusted), avg is not < 0 (skip Caution),
      // count < 20 (skip HT), count < 10 (skip T), count < 5 (skip E), count = 0 (skip Emerging) -> No Data
      expect(computeTrustLabel(0, 50).label).toBe("No Data");
    });

    it("Caution takes priority over No Data when avg < 0 and count = 0", () => {
      // count=0, avg=-10 -> Untrusted: count < 5 NO; Caution: avg < 0 YES
      expect(computeTrustLabel(0, -10).label).toBe("Caution");
    });
  });

  // =========================================================================
  // First-match-wins ordering verification
  // =========================================================================
  describe("first-match-wins ordering", () => {
    it("Untrusted beats Caution when both could match", () => {
      // count=5, avg=-60: matches Untrusted (count>=5, avg<-50) AND Caution (avg<0)
      expect(computeTrustLabel(5, -60).label).toBe("Untrusted");
    });

    it("Highly Trusted beats Trusted when both could match", () => {
      // count=20, avg=80: matches HT AND Trusted AND Established
      expect(computeTrustLabel(20, 80).label).toBe("Highly Trusted");
    });

    it("Trusted beats Established when both could match", () => {
      // count=10, avg=70: matches Trusted AND Established
      expect(computeTrustLabel(10, 70).label).toBe("Trusted");
    });
  });

  // =========================================================================
  // Display string format
  // =========================================================================
  describe("display string format", () => {
    it("formats correctly for Untrusted", () => {
      const r = computeTrustLabel(10, -80);
      expect(r.display).toBe("\u{1F534} Untrusted -- -80/100 (10 reviews)");
    });

    it("formats correctly for Caution", () => {
      const r = computeTrustLabel(3, -25);
      expect(r.display).toBe("\u{1F7E0} Caution -- -25/100 (3 reviews)");
    });

    it("formats correctly for Highly Trusted", () => {
      const r = computeTrustLabel(50, 95);
      expect(r.display).toBe("\u2B50 Highly Trusted -- 95/100 (50 reviews)");
    });

    it("formats correctly for Emerging", () => {
      const r = computeTrustLabel(2, 40);
      expect(r.display).toBe("\u{1F535} Emerging -- 40/100 (2 reviews)");
    });

    it("No Data always shows 0/100 (0 reviews)", () => {
      expect(computeTrustLabel(0, 0).display).toBe(
        "\u26AA No Data -- 0/100 (0 reviews)",
      );
    });
  });
});
