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

/**
 * Log timestamp in the node's local time, with its UTC offset.
 *
 * Deliberately not toISOString(): these logs are read next to a wall clock
 * while working out when a camera stopped, and UTC forces the reader to do
 * arithmetic. The offset is kept so a line is still unambiguous, and the
 * sortable YYYY-MM-DD HH:MM:SS shape is preserved for grep ranges. TZ is
 * whatever the host says (set TZ to override).
 */
export function stamp(at = new Date()): string {
  const p = (n: number, w = 2): string => String(Math.floor(Math.abs(n))).padStart(w, "0");
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}.${p(at.getMilliseconds(), 3)}` +
    `${sign}${p(offsetMin / 60)}:${p(offsetMin % 60)}`
  );
}

function write(level: LogLevel, name: string, message: string, args: unknown[]): void {
  if (LEVELS[level] < threshold()) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${name}] ${message}`;
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
