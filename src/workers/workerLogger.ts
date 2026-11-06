/**
 * The three-method logger every worker takes: a Fastify request logger satisfies it
 * structurally, and a worker that is handed none resolves to a no-op.
 */
export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
