import path from "node:path";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { PTY_COLS, PTY_ROWS, PTY_TERM } from "../constants.js";
import { PTYError } from "./models.js";

// Falls back unless value is a positive whole number of cells.
function positiveIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class PtyHandler {
  private _ptyProcess: IPty | null = null;
  private _alive = false;
  private _dataDisposable: IDisposable | null = null;
  private _exitDisposable: IDisposable | null = null;
  private _exitResolvers: Array<(code: number | null) => void> = [];
  private _exitCode: number | null = null;

  constructor(private readonly _settings: Settings = getSettings()) {}

  get pid(): number | null {
    return this._ptyProcess?.pid ?? null;
  }

  validateCommand(command: string[]): void {
    if (!this._settings.ENABLE_COMMAND_VALIDATION) return;

    if (command.length === 0) {
      throw new PTYError("Command list cannot be empty");
    }

    const executable = command[0]!;
    const execName = path.isAbsolute(executable) ? path.basename(executable) : executable;

    if (!this._settings.ALLOWED_COMMANDS.includes(execName)) {
      const allowed = this._settings.ALLOWED_COMMANDS.join(", ");
      throw new PTYError(
        `Command '${execName}' is not in the allowed commands list. Allowed commands: ${allowed}. ` +
          `To add this command, set OPENROAD_ALLOWED_COMMANDS environment variable.`,
      );
    }

    for (let i = 0; i < command.length; i++) {
      const arg = command[i]!;
      if (/[;&|$`\n\r]/.test(arg)) {
        throw new PTYError(
          `Command argument ${i} contains shell metacharacters which are not allowed: ${JSON.stringify(arg)}`,
        );
      }
      if (arg.startsWith(">") || arg.startsWith("<")) {
        throw new PTYError(
          `Command argument ${i} contains redirection operators which are not allowed: ${JSON.stringify(arg)}`,
        );
      }
      if (arg.split(/[/\\]/).some((part) => part === "..")) {
        throw new PTYError(
          `Command argument ${i} contains path traversal sequence which is not allowed: ${JSON.stringify(arg)}`,
        );
      }
    }
  }

  async createSession(
    command: string[],
    env?: Record<string, string>,
    cwd?: string,
    onData?: (data: string) => void,
    onExit?: (exitCode: number) => void,
  ): Promise<void> {
    const executable = command[0] ?? "";
    try {
      this.validateCommand(command);

      // Terminal settings come first so an explicit caller env can override them.
      const processEnv: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        TERM: PTY_TERM,
        COLUMNS: String(PTY_COLS),
        LINES: String(PTY_ROWS),
        ...env,
      };

      this._ptyProcess = spawn(command[0]!, command.slice(1), {
        name: processEnv.TERM ?? PTY_TERM,
        cols: positiveIntOr(processEnv.COLUMNS, PTY_COLS),
        rows: positiveIntOr(processEnv.LINES, PTY_ROWS),
        cwd: cwd ?? process.cwd(),
        env: processEnv,
      });

      this._alive = true;
      this._exitCode = null;

      // Register exit before onData so a fast-exiting process can't slip past us.
      this._exitDisposable = this._ptyProcess.onExit(({ exitCode }) => {
        if (!this._alive && this._exitCode !== null) return;
        this._alive = false;
        this._exitCode = exitCode;
        const resolvers = this._exitResolvers.splice(0);
        for (const resolve of resolvers) resolve(exitCode);
        onExit?.(exitCode);
      });

      if (onData) {
        this._dataDisposable = this._ptyProcess.onData(onData);
      }
    } catch (e) {
      if (e instanceof PTYError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      // Report only whether PATH was set, not its contents, since this may reach clients.
      const pathHint = process.env.PATH ? "set" : "empty";
      if (/posix_spawnp failed|ENOENT|command not found/i.test(raw)) {
        throw new PTYError(
          `Failed to create PTY session: executable '${executable}' could not be started. ` +
            `Most likely '${executable}' is missing from PATH or not executable ` +
            `(PATH is ${pathHint}). Rarely, node-pty's spawn-helper binary lost its ` +
            `exec bit — the postinstall script normally restores it; if not (e.g. install ran ` +
            `with --ignore-scripts), run: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`,
        );
      }
      throw new PTYError(`Failed to create PTY session: ${raw}`);
    }
  }

  writeInput(data: string): void {
    if (!this._ptyProcess) {
      throw new PTYError("Cannot write: no active PTY process");
    }
    try {
      this._ptyProcess.write(data);
    } catch (e) {
      throw new PTYError(`Failed to write to PTY: ${e}`);
    }
  }

  isProcessAlive(): boolean {
    if (!this._alive || !this._ptyProcess) return false;
    // Defensive liveness probe in case the exit event was missed; signal 0 only tests the pid.
    try {
      process.kill(this._ptyProcess.pid, 0);
      return true;
    } catch (e) {
      // EPERM means the pid exists but we can't signal it — still alive.
      if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
      this._alive = false;
      return false;
    }
  }

  async waitForExit(timeoutMs?: number): Promise<number | null> {
    if (this._exitCode !== null) return this._exitCode;
    if (!this._ptyProcess) return null;

    return new Promise<number | null>((resolve) => {
      let settled = false;

      const onExit = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(code);
      };

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = this._exitResolvers.indexOf(onExit);
          if (idx !== -1) this._exitResolvers.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
      }

      this._exitResolvers.push(onExit);
    });
  }

  async terminateProcess(force = false): Promise<void> {
    if (!this._ptyProcess || !this._alive) return;

    try {
      this._ptyProcess.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      await this.waitForExit(200);
      return;
    }

    const exited = await this.waitForExit(5000);
    if (exited === null && this._alive) {
      try {
        this._ptyProcess.kill("SIGKILL");
      } catch {
        // ignored
      }
      await this.waitForExit(5000);
    }
  }

  async cleanup(): Promise<void> {
    if (this._alive) {
      try {
        await this.terminateProcess(true);
      } catch {
        // best effort
      }
    }

    try { this._dataDisposable?.dispose(); } catch { /* ignored */ }
    try { this._exitDisposable?.dispose(); } catch { /* ignored */ }

    const pending = this._exitResolvers.splice(0);
    for (const resolve of pending) resolve(this._exitCode);

    this._ptyProcess = null;
    this._alive = false;
    this._dataDisposable = null;
    this._exitDisposable = null;
    // _exitCode is preserved for late waitForExit() callers; createSession() resets it on reuse.
  }
}
