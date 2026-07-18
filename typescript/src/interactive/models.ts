export class SessionError extends Error {
  readonly sessionId: string | undefined;

  constructor(message: string, sessionId?: string) {
    super(message);
    this.name = "SessionError";
    this.sessionId = sessionId;
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(message: string, sessionId?: string) {
    super(message, sessionId);
    this.name = "SessionNotFoundError";
  }
}

export class SessionTerminatedError extends SessionError {
  constructor(message: string, sessionId?: string) {
    super(message, sessionId);
    this.name = "SessionTerminatedError";
  }
}

export class CommandBlockedError extends SessionError {
  readonly commandVerb: string;

  constructor(commandVerb: string, sessionId?: string) {
    super(
      `Command '${commandVerb}' is not allowed. Only OpenROAD and safe Tcl commands are permitted.`,
      sessionId,
    );
    this.name = "CommandBlockedError";
    this.commandVerb = commandVerb;
  }
}

export class PTYError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PTYError";
  }
}
