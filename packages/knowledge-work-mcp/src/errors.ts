export class FailClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailClosedError';
  }
}

export class ApiError extends Error {
  constructor(
    public readonly service: 'home' | 'kfdb',
    public readonly status: number,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `${service} API ${status}: ${body.slice(0, 300)}`);
    this.name = 'ApiError';
  }
}
