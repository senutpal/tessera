import type { WebSocket } from "ws";

export interface ClientSession {
  id: string;
  socket: WebSocket;
  ip: string;
  connectedAt: string;
  channels: Set<string>;
  isAlive: boolean;
  lastPing: number;
  lastPong: number;
  authenticated: boolean;
  userId?: string | undefined;
}

export class SessionManager {
  private sessions = new Map<string, ClientSession>();
  private channelIndex = new Map<string, Set<string>>();

  get count(): number {
    return this.sessions.size;
  }

  addSession(session: ClientSession): void {
    this.sessions.set(session.id, session);
    for (const channel of session.channels) {
      this.indexChannel(channel, session.id);
    }
  }

  removeSession(id: string): ClientSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    this.sessions.delete(id);
    for (const channel of session.channels) {
      const set = this.channelIndex.get(channel);
      if (set) {
        set.delete(id);
        if (set.size === 0) {
          this.channelIndex.delete(channel);
        }
      }
    }
    return session;
  }

  getSession(id: string): ClientSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): ClientSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionsForChannel(channel: string): ClientSession[] {
    const ids = this.channelIndex.get(channel);
    if (!ids) return [];

    const result: ClientSession[] = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session) {
        result.push(session);
      }
    }
    return result;
  }

  subscribe(sessionId: string, channel: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.channels.add(channel);
      this.indexChannel(channel, sessionId);
    }
  }

  unsubscribe(sessionId: string, channel: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.channels.delete(channel);
      const set = this.channelIndex.get(channel);
      if (set) {
        set.delete(sessionId);
        if (set.size === 0) {
          this.channelIndex.delete(channel);
        }
      }
    }
  }

  private indexChannel(channel: string, sessionId: string): void {
    let set = this.channelIndex.get(channel);
    if (!set) {
      set = new Set();
      this.channelIndex.set(channel, set);
    }
    set.add(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.channelIndex.clear();
  }
}
