export class OpenROADError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenROADError";
  }
}

export class ValidationError extends OpenROADError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
