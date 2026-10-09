export class ImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
  }
}

export class ImportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportUnavailableError';
  }
}
