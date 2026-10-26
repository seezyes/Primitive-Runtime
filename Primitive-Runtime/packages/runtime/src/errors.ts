export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
export function safeError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RuntimeError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof Error && error.name === "AbortError")
    return {
      code: "CANCELLED",
      message: "Execution was cancelled.",
      retryable: false,
    };
  return {
    code: "INTERNAL_ERROR",
    message: "The operation failed. Inspect protected operator diagnostics.",
    retryable: false,
  };
}
export function check(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new RuntimeError(code, message);
}
