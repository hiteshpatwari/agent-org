export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

// Deliberately permissive: the objective asks the agent to repair validation.
export function parseOrderLine(value: string): OrderLine {
  const [sku = "", quantity = "0", unitPriceCents = "0"] = value.split(",");
  return {
    sku,
    quantity: Number.parseInt(quantity, 10),
    unitPriceCents: Number.parseFloat(unitPriceCents),
  };
}
