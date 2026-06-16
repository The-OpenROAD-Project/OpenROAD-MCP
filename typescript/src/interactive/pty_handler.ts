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

  validateCommand(command: string[]): void {
    if (!this._settings.ENABLE_COMMAND_VALIDATION) return;

    if (command.length === 0) {
      throw new PTYError("Command list cannot be empty");
    }

    const executable = command[0]!;

    if (path.isAbsolute(executable)) {
      throw new PTYError(
        `Command '${executable}' must not be an absolute path. ` +
          `Use the binary name only (e.g. 'openroad'). ` +
          `To allow additional commands, set OPENROAD_ALLOWED_COMMANDS environment variable.`,
      );
    }

    if (!this._settings.ALLOWED_COMMANDS.includes(executable)) {
      const allowed = this._settings.ALLOWED_COMMANDS.join(", ");
      throw new PTYError(
        `Command '${executable}' is not in the allowed commands list. Allowed commands: ${allowed}. ` +
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

      if (onData) {
        this._dataDisposable = this._ptyProcess.onData(onData);
      }

      this._exitDisposable = this._ptyProcess.onExit(({ exitCode }) => {
        this._alive = false;
        this._exitCode = exitCode;
        const resolvers = this._exitResolvers.splice(0);
        for (const resolve of resolvers) resolve(exitCode);
        onExit?.(exitCode);
      });
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
    return this._alive;
  }

  async waitForExit(timeoutMs?: number): Promise<number | null> {
    if (!this._ptyProcess) return null;
    if (this._exitCode !== null) return this._exitCode;

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
        await this.terminateProcess();
      } catch {
        // Best effort - don't let terminate errors prevent state reset
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
    this._exitCode = null;
  }
}
