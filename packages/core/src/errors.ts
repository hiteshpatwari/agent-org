export class InvalidTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}
