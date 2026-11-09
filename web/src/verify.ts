import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import type { VerificationView } from "./engine.ts";
import { AppError } from "./policy.ts";

/** Emoji SAS only. State changes when the SDK request changes, not when this class guesses. */
export class SasController {
  phase: VerificationView["phase"] = "idle";
  other: string | null = null;
  emojis: VerificationView["emojis"] = [];
  private request: VerificationRequest | null = null;
  private sas: ShowSasCallbacks | null = null;
  private armed: Verifier | null = null;
  private started = false;

  view(): VerificationView {
    return { phase: this.phase, other: this.other, emojis: this.emojis.map((item) => ({ ...item })) };
  }

  reset(): void {
    if (this.phase === "done" || this.phase === "cancelled" || this.phase === "failed" || this.phase === "idle") {
      this.clear();
    }
  }

  onIncoming(request: VerificationRequest): void {
    if (this.phase === "requested" || this.phase === "incoming" || this.phase === "accepted" || this.phase === "sas") return;
    this.bind(request, "incoming");
  }

  bindOutgoing(request: VerificationRequest): void {
    this.bind(request, "requested");
  }

  async accept(ownVerified: boolean): Promise<void> {
    if (this.phase !== "incoming" || !this.request) throw new AppError("no_request");
    if (!ownVerified) throw new AppError("own_device_unverified");
    await this.request.accept();
    this.phase = "accepted";
  }

  async confirm(): Promise<void> {
    if (this.phase !== "sas" || !this.sas) throw new AppError("no_sas");
    await this.sas.confirm();
  }

  mismatch(): void {
    if (this.phase !== "sas" || !this.sas) throw new AppError("no_sas");
    this.sas.mismatch();
  }

  async cancel(): Promise<void> {
    const request = this.request;
    this.phase = "cancelled";
    this.emojis = [];
    if (request) await request.cancel().catch(() => {});
  }

  private bind(request: VerificationRequest, phase: VerificationView["phase"]): void {
    this.clear();
    this.request = request;
    this.other = request.otherUserId;
    this.phase = phase;
    request.on(VerificationRequestEvent.Change, () => {
      void this.follow();
    });
    void this.follow();
  }

  private clear(): void {
    this.phase = "idle";
    this.other = null;
    this.emojis = [];
    this.request = null;
    this.sas = null;
    this.armed = null;
    this.started = false;
  }

  private async follow(): Promise<void> {
    const request = this.request;
    if (!request) return;
    if (request.phase === VerificationPhase.Cancelled) {
      this.phase = "cancelled";
      this.emojis = [];
      return;
    }
    if (request.phase === VerificationPhase.Done) {
      this.phase = "done";
      this.emojis = [];
      return;
    }
    if (request.phase === VerificationPhase.Requested) {
      this.phase = request.initiatedByMe ? "requested" : "incoming";
      return;
    }
    if (request.phase !== VerificationPhase.Ready && request.phase !== VerificationPhase.Started) return;
    if (this.phase !== "sas") this.phase = "accepted";
    if (request.initiatedByMe && request.phase === VerificationPhase.Ready && !this.started) {
      this.started = true;
      try {
        this.arm(await request.startVerification(VerificationMethod.Sas));
      } catch {
        this.phase = "failed";
      }
      return;
    }
    if (!request.initiatedByMe && request.verifier) this.arm(request.verifier);
  }

  private arm(verifier: Verifier): void {
    if (this.armed === verifier) return;
    this.armed = verifier;
    verifier.on(VerifierEvent.ShowSas, (callbacks) => {
      const emoji = callbacks.sas.emoji;
      if (!emoji || emoji.length === 0) {
        callbacks.cancel();
        this.phase = "cancelled";
        return;
      }
      this.sas = callbacks;
      this.emojis = emoji.map(([symbol, description]) => ({ symbol, description }));
      this.phase = "sas";
    });
    verifier.on(VerifierEvent.Cancel, () => {
      if (this.phase !== "done") this.phase = "cancelled";
    });
    void verifier.verify().then(() => {
      if (this.request?.phase === VerificationPhase.Done) this.phase = "done";
    }).catch(() => {
      if (this.phase !== "done" && this.phase !== "cancelled") this.phase = "failed";
    });
  }
}
