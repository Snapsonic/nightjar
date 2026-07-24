/** Tiny leveled logger. No dependencies. Level via LOG_LEVEL env (default "info"). */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = process.env.LOG_LEVEL;
  if (raw && raw in LEVELS) return LEVELS[raw as LogLevel];
  return LEVELS.info;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(name: string): Logger;
}

function write(level: LogLevel, name: string, message: string, args: unknown[]): void {
  if (LEVELS[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${name}] ${message}`;
  const sink = level === "warn" || level === "error" ? console.error : console.log;
  if (args.length > 0) sink(line, ...args);
  else sink(line);
}

export function createLogger(name = "nightjar"): Logger {
  return {
    debug: (message, ...args) => write("debug", name, message, args),
    info: (message, ...args) => write("info", name, message, args),
    warn: (message, ...args) => write("warn", name, message, args),
    error: (message, ...args) => write("error", name, message, args),
    child: (childName) => createLogger(`${name}:${childName}`),
  };
}
