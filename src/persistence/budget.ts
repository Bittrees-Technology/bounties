/** Integer ERC-20 base-unit calculations. Deliberately never accepts JS numbers. */
export type BaseUnit = bigint;

export function parseBaseUnits(value: string): BaseUnit {
  if (!/^\d+$/.test(value)) throw new Error("Base units must be a non-negative integer string.");
  return BigInt(value);
}

export function defaultMilestoneSplit(total: BaseUnit, count: number): BaseUnit[] {
  if (total <= 0n || !Number.isSafeInteger(count) || count < 1) throw new Error("A positive total and milestone count are required.");
  const divisor = BigInt(count);
  const quotient = total / divisor;
  const remainder = total % divisor;
  return Array.from({ length: count }, (_, index) => quotient + (BigInt(index) < remainder ? 1n : 0n));
}

export function assertExactBudget(total: BaseUnit, milestones: readonly BaseUnit[], proposalTotal?: BaseUnit): void {
  if (total <= 0n || milestones.length === 0 || milestones.some((amount) => amount <= 0n)) throw new Error("Budget and milestone amounts must be positive integer base units.");
  const milestoneTotal = milestones.reduce((sum, amount) => sum + amount, 0n);
  if (milestoneTotal !== total) throw new Error(`Milestones total ${milestoneTotal}, expected ${total}.`);
  if (proposalTotal !== undefined && proposalTotal !== total) throw new Error(`Proposal total ${proposalTotal} does not reconcile to bounty budget ${total}.`);
}
