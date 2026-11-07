import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:5173/", width: 1280, height: 800 });
const globals = globalThis as Record<string, unknown>;
globals.window = dom;
globals.document = dom.document;
globals.HTMLElement = dom.HTMLElement;
globals.HTMLInputElement = dom.HTMLInputElement;
globals.HTMLButtonElement = dom.HTMLButtonElement;
globals.HTMLTextAreaElement = dom.HTMLTextAreaElement;
globals.Element = dom.Element;
globals.Node = dom.Node;
globals.DocumentFragment = dom.DocumentFragment;
globals.MutationObserver = dom.MutationObserver;
globals.Event = dom.Event;
globals.getComputedStyle = dom.getComputedStyle.bind(dom);
globals.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { App } = await import("../src/App.tsx");
const { PROTOTYPE_WARNING } = await import("../src/policy.ts");
import type { Engine, VerificationView } from "../src/engine.ts";

const idle: VerificationView = { phase: "idle", other: null, emojis: [] };

function engine(over: Partial<Engine> = {}): Engine {
  return {
    async signIn() {
      return { userId: "@a:localhost", deviceId: "DEV" };
    },
    async logout() {},
    async rooms() {
      return [{ roomId: "!r:localhost", name: "@b:localhost", peer: "@b:localhost", invited: false }];
    },
    async createDm(userId: string) {
      return `!${userId}`;
    },
    async join() {},
    async peerStatus() {
      return { encrypted: true, peer: "@b:localhost", identity: "unverified", wasVerified: false };
    },
    async messages() {
      return [
        { id: "$e1", mine: false, sender: "@b:localhost", body: "marker-plaintext-body", utd: false, state: "sent" },
      ];
    },
    async open() {},
    async send() {
      return { eventId: "$sent" };
    },
    async retry() {},
    async acknowledgeIdentityChange() {},
    async block() {},
    async unblock() {},
    async blocked() {
      return [];
    },
    async report() {},
    async ownDeviceVerified() {
      return false;
    },
    verification() {
      return idle;
    },
    async verifyOwnDevice() {},
    async verifyUser() {},
    async verifyAccept() {},
    async verifyConfirm() {},
    async verifyMismatch() {},
    async verifyCancel() {},
    verifyReset() {},
    syncLabel() {
      return "Connected";
    },
    ...over,
  } as Engine;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function render(node: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    cleanup() {
      root.unmount();
      host.remove();
    },
  };
}

test("insecure pages refuse to show the sign-in form", async () => {
  const view = await render(createElement(App, { engine: engine(), secure: false }));
  assert.match(view.host.textContent ?? "", /secure context/i);
  assert.equal(view.host.querySelector("input[type=password]"), null);
  view.cleanup();
});

test("sign-in shows the prototype warning and the wordmark with no logo", async () => {
  const view = await render(createElement(App, { engine: engine(), secure: true }));
  const text = view.host.textContent ?? "";
  assert.match(text, /FabriC\+\+/);
  assert.match(text, new RegExp(PROTOTYPE_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(view.host.querySelector("img, svg"), null);
  const input = view.host.querySelector("input[name=homeserver]") as HTMLInputElement;
  assert.equal(input.value, "http://127.0.0.1:8008");
  view.cleanup();
});

test("unverified peers can compose, and a changed identity blocks sending", async () => {
  const ok = await render(createElement(App, { engine: engine(), secure: true, startSignedIn: { userId: "@a:localhost", deviceId: "DEV" } }));
  await settle();
  await act(async () => {
    (ok.host.querySelector("[data-room]") as HTMLButtonElement).click();
  });
  await settle();
  assert.match(ok.host.textContent ?? "", /Not verified/);
  const box = ok.host.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(box.disabled, false);
  ok.cleanup();

  const changed = await render(createElement(App, {
    engine: engine({
      async peerStatus() {
        return { encrypted: true, peer: "@b:localhost", identity: "changed", wasVerified: true };
      },
    }),
    secure: true,
    startSignedIn: { userId: "@a:localhost", deviceId: "DEV" },
  }));
  await settle();
  await act(async () => {
    (changed.host.querySelector("[data-room]") as HTMLButtonElement).click();
  });
  await settle();
  assert.match(changed.host.textContent ?? "", /Identity changed/);
  assert.match(changed.host.textContent ?? "", /Acknowledge the change/);
  assert.equal((changed.host.querySelector("textarea") as HTMLTextAreaElement).disabled, true);
  changed.cleanup();
});

test("report disclosure names metadata and does not add the message text to the report copy", async () => {
  let reported = false;
  const view = await render(createElement(App, {
    engine: engine({
      async report() {
        reported = true;
      },
    }),
    secure: true,
    startSignedIn: { userId: "@a:localhost", deviceId: "DEV" },
  }));
  await settle();
  await act(async () => {
    (view.host.querySelector("[data-room]") as HTMLButtonElement).click();
  });
  await settle();
  await act(async () => {
    (view.host.querySelector("[data-report]") as HTMLButtonElement).click();
  });
  const dialog = view.host.querySelector("[data-report-dialog]")!;
  const copy = dialog.textContent ?? "";
  assert.match(copy, /message id/);
  assert.match(copy, /does not send the message text/);
  assert.equal(copy.includes("marker-plaintext-body"), false);
  await act(async () => {
    (dialog.querySelector("[data-report-confirm]") as HTMLButtonElement).click();
  });
  assert.equal(reported, true);
  view.cleanup();
});

test("settings show revenue as not connected and an unverified device", async () => {
  const view = await render(createElement(App, { engine: engine(), secure: true, startSignedIn: { userId: "@a:localhost", deviceId: "DEV" } }));
  await settle();
  await act(async () => {
    (view.host.querySelector("[data-settings]") as HTMLButtonElement).click();
  });
  await settle();
  const text = view.host.textContent ?? "";
  assert.match(text, /Not connected/);
  assert.match(text, /Not verified by your account/);
  assert.match(text, /never reset/i);
  assert.match(text, /Verify with another device/);
  view.cleanup();
});
