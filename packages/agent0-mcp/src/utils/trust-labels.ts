export interface TrustLabel {
  emoji: string;
  label: string;
  display: string;
}

/**
 * Compute a human-readable trust label from review count and average score.
 * First-match-wins rules (order matters).
 */
export function computeTrustLabel(count: number, avg: number): TrustLabel {
  if (count >= 5 && avg < -50)
    return {
      emoji: "\u{1F534}",
      label: "Untrusted",
      display: `\u{1F534} Untrusted -- ${avg}/100 (${count} reviews)`,
    };
  if (avg < 0)
    return {
      emoji: "\u{1F7E0}",
      label: "Caution",
      display: `\u{1F7E0} Caution -- ${avg}/100 (${count} reviews)`,
    };
  if (count >= 20 && avg >= 80)
    return {
      emoji: "\u2B50",
      label: "Highly Trusted",
      display: `\u2B50 Highly Trusted -- ${avg}/100 (${count} reviews)`,
    };
  if (count >= 10 && avg >= 70)
    return {
      emoji: "\u{1F7E2}",
      label: "Trusted",
      display: `\u{1F7E2} Trusted -- ${avg}/100 (${count} reviews)`,
    };
  if (count >= 5 && avg >= 50)
    return {
      emoji: "\u{1F7E2}",
      label: "Established",
      display: `\u{1F7E2} Established -- ${avg}/100 (${count} reviews)`,
    };
  if (count > 0)
    return {
      emoji: "\u{1F535}",
      label: "Emerging",
      display: `\u{1F535} Emerging -- ${avg}/100 (${count} reviews)`,
    };
  return {
    emoji: "\u26AA",
    label: "No Data",
    display: "\u26AA No Data -- 0/100 (0 reviews)",
  };
}
