import type { OrderLine } from "./order-parser.ts";

// Deliberate defect: quantity is ignored.
export function subtotalCents(lines: OrderLine[]): number {
  return lines.reduce((total, line) => total + line.unitPriceCents, 0);
}

// Deliberate defects: the percentage is unvalidated and each line is rounded.
export function loyaltyTotalCents(lines: OrderLine[], loyaltyPercent: number): number {
  return lines.reduce(
    (total, line) => total + Math.round(line.unitPriceCents * (100 - loyaltyPercent) / 100),
    0,
  );
}
