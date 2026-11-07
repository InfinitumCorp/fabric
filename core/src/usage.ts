export type DailyUsage = { date: string; sent: number; received: number; sessionSeconds: number };

export class UsageCounter {
  private sent = 0;
  private received = 0;
  private seconds = 0;
  private consented: () => boolean;
  constructor(consented: () => boolean) {
    this.consented = consented;
  }

  onSent(): void { if (this.consented()) this.sent++; }
  onReceived(): void { if (this.consented()) this.received++; }
  addSession(seconds: number): void { if (this.consented()) this.seconds += Math.max(0, Math.round(seconds)); }

  /** Returns the day's totals and resets, or null if consent is off or nothing was counted. Withdrawal drops unsent counts. */
  flush(date: string): DailyUsage | null {
    const out = { date, sent: this.sent, received: this.received, sessionSeconds: this.seconds };
    this.sent = 0; this.received = 0; this.seconds = 0;
    if (!this.consented()) return null;
    if (out.sent + out.received + out.sessionSeconds === 0) return null;
    return out;
  }
}
