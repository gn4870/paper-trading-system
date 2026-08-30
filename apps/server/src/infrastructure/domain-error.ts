export type DomainErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "INSUFFICIENT_FUNDS"
  | "INSUFFICIENT_POSITION"
  | "INVARIANT_VIOLATION"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_ACTIVE";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}
