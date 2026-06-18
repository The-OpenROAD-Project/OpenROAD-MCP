import path from "node:path";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { getSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { PTYError } from "./models.js";

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
    try {
      this.validateCommand(command);

      const processEnv: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        ...env,
        TERM: "xterm-256color",
        COLUMNS: "80",
        LINES: "24",
      };

      this._ptyProcess = spawn(command[0]!, command.slice(1), {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: cwd ?? process.cwd(),
        env: processEnv,
      });

      this._alive = true;
      this._exitCode = null;

      // Register exit before onData so a fast-exiting process cannot slip
      // its exit event through before we are listening. The guard keeps the
      // handler idempotent against a double-delivered exit.
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
      throw new PTYError(`Failed to create PTY session: ${e}`);
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
    // Defensive liveness probe in case the exit event was missed; signal 0
    // detects a dead/reaped pid via ESRCH.
    try {
      process.kill(this._ptyProcess.pid, 0);
      return true;
    } catch {
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
    // Preserve _exitCode so a late waitForExit() caller still sees the real
    // exit code; createSession() resets it on reuse.
  }
}
