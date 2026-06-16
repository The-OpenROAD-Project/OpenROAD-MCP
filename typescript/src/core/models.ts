export enum SessionState {
  CREATING = "creating",
  ACTIVE = "active",
  TERMINATED = "terminated",
  ERROR = "error",
}

export interface InteractiveSessionInfo {
  sessionId: string;
  createdAt: string;
  isAlive: boolean;
  commandCount: number;
  bufferSize: number;
  uptimeSeconds: number | null;
  state: SessionState | null;
  error?: string | null;
}

export interface InteractiveExecResult {
  output: string;
  sessionId: string | null;
  timestamp: string;
  executionTime: number;
  commandCount: number;
  bufferSize: number;
  error?: string | null;
}
