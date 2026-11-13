import { useEffect, useState } from "react";
import { isValidUserId, refusalText, trustLabel } from "../../core/src/conversation.ts";
import type { ChatMessage, Engine, PeerView, RoomSummary, SessionInfo, VerificationView } from "./engine.ts";
import { AppError, PROTOTYPE_WARNING, REVENUE_DATA, REVENUE_PLAN, decideSend, messageText } from "./policy.ts";

const ERR: Record<string, string> = {
  login_failed: "Sign-in failed. Check the user name and password.",
  bad_server: "The server must be a localhost address.",
  insecure_context: "FabriC++ only runs on localhost or HTTPS.",
  not_signed_in: "Not signed in.",
  bad_input: "That user id is not valid. Use @name:server.",
  create_failed: "Could not start the conversation.",
  send_failed: "Message not sent.",
  sync_timeout: "The server did not respond in time.",
  own_device_unverified: "This device is not verified by your account yet. Verify it from Settings using another of your signed-in devices.",
  already_verified: "This device is already verified.",
  verification_unavailable: "Verification is not ready yet. Try again in a moment.",
  no_request: "There is no verification request to answer.",
  no_sas: "The emoji check is not ready.",
  no_room: "That conversation is not available.",
  report_failed: "Report not sent.",
  block_failed: "Could not update the block list.",
  bad_text: "That message cannot be sent.",
  ...refusalText,
};

function explain(err: unknown): string {
  const code = err instanceof AppError ? err.code : (err as { code?: string } | null)?.code;
  return (code && ERR[code]) || "Something went wrong.";
}

type Route =
  | { name: "list" }
  | { name: "new" }
  | { name: "chat"; room: RoomSummary }
  | { name: "contact"; room: RoomSummary }
  | { name: "settings" };

export function App({ engine, secure, startSignedIn = null }: { engine: Engine; secure: boolean; startSignedIn?: SessionInfo | null }) {
  const [session, setSession] = useState<SessionInfo | null>(startSignedIn);
  const [route, setRoute] = useState<Route>({ name: "list" });
  if (!secure) return <Insecure />;
  if (!session) return <SignIn engine={engine} onDone={(next) => { setSession(next); setRoute({ name: "list" }); }} />;
  if (route.name === "new") return <NewChat engine={engine} back={() => setRoute({ name: "list" })} open={(room) => setRoute({ name: "chat", room })} />;
  if (route.name === "settings") return <Settings engine={engine} session={session} back={() => setRoute({ name: "list" })} onLogout={() => setSession(null)} />;
  if (route.name === "contact") return <Contact engine={engine} room={route.room} back={() => setRoute({ name: "chat", room: route.room })} />;
  if (route.name === "chat") return <Conversation engine={engine} room={route.room} back={() => setRoute({ name: "list" })} details={() => setRoute({ name: "contact", room: route.room })} />;
  return <ChatList engine={engine} open={(room) => setRoute({ name: "chat", room })} settings={() => setRoute({ name: "settings" })} compose={() => setRoute({ name: "new" })} />;
}

function Warning() {
  return <p className="warning">{PROTOTYPE_WARNING}</p>;
}

function Insecure() {
  return (
    <main className="pad">
      <h1 className="brand">FabriC++</h1>
      <p>FabriC++ only runs in a secure context, on localhost or HTTPS.</p>
    </main>
  );
}

function Header({ title, left, right }: { title: string; left?: [string, () => void, string?]; right?: [string, () => void, string?] }) {
  return (
    <header className="header">
      {left ? <button type="button" className="link" data-settings={left[2] === "settings" ? "" : undefined} onClick={left[1]}>{left[0]}</button> : <span />}
      <h1>{title}</h1>
      {right ? <button type="button" className="link" data-nav={right[2]} onClick={right[1]}>{right[0]}</button> : <span />}
    </header>
  );
}

function SignIn({ engine, onDone }: { engine: Engine; onDone: (session: SessionInfo) => void }) {
  const [homeserver, setHomeserver] = useState("http://127.0.0.1:8008");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      onDone(await engine.signIn(homeserver.trim(), username.trim(), secret));
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="pad">
      <h1 className="brand">FabriC++</h1>
      <p>Private, end-to-end encrypted messages.</p>
      <Warning />
      <label className="label" htmlFor="homeserver">Server</label>
      <input id="homeserver" name="homeserver" className="field" value={homeserver} onChange={(event) => setHomeserver(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <label className="label" htmlFor="username">User name</label>
      <input id="username" name="username" className="field" value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <label className="label" htmlFor="password">Password</label>
      <input id="password" name="password" type="password" className="field" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
      {error ? <p className="error">{error}</p> : null}
      <button type="button" className="button" disabled={busy || !homeserver || !username || !password} onClick={() => { void submit(); }}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="small">New accounts are created by the server administrator. Registration is closed.</p>
    </main>
  );
}

function ChatList({ engine, open, settings, compose }: { engine: Engine; open: (room: RoomSummary) => void; settings: () => void; compose: () => void }) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => engine.rooms().then((rows) => { if (live) setRooms(rows); }).catch((err) => { if (live) setError(explain(err)); });
    load();
    const timer = setInterval(load, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [engine]);
  const accept = async (room: RoomSummary) => {
    try {
      if (room.invited) await engine.join(room.roomId);
      open({ ...room, invited: false });
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <main className="grow">
      <Header title="FabriC++" left={["Settings", settings, "settings"]} right={["New", compose]} />
      <div className="pad"><Warning /><p className="small">{engine.syncLabel()}</p></div>
      {error ? <p className="error pad">{error}</p> : null}
      {rooms === null ? <p className="center muted">Loading…</p> : rooms.length === 0 ? <p className="center muted">No conversations yet.</p> : (
        <div>
          {rooms.map((room) => (
            <button type="button" className="row" data-room={room.roomId} key={room.roomId} onClick={() => { void accept(room); }}>
              <span className="row-title">{room.name}</span>
              <span className="muted">{room.invited ? "Invitation. Tap to accept." : room.peer ?? ""}</span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

function NewChat({ engine, back, open }: { engine: Engine; back: () => void; open: (room: RoomSummary) => void }) {
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const value = userId.trim();
    if (!isValidUserId(value)) { setError(ERR.bad_input); return; }
    setBusy(true);
    setError(null);
    try {
      const roomId = await engine.createDm(value);
      open({ roomId, name: value, peer: value, invited: false });
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main>
      <Header title="New chat" left={["Back", back]} />
      <div className="pad">
        <label className="label" htmlFor="user-id">User id</label>
        <input id="user-id" className="field" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="@name:server" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        {error ? <p className="error">{error}</p> : null}
        <button type="button" className="button" disabled={busy || !userId} onClick={() => { void create(); }}>Start encrypted chat</button>
      </div>
    </main>
  );
}

function Conversation({ engine, room, back, details }: { engine: Engine; room: RoomSummary; back: () => void; details: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<PeerView | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [nextMessages, nextStatus] = await Promise.all([engine.messages(room.roomId), engine.peerStatus(room.roomId)]);
        if (live) { setMessages(nextMessages); setStatus(nextStatus); }
      } catch (err) {
        if (live) setError(explain(err));
      }
    };
    engine.open(room.roomId).then(tick).catch((err) => setError(explain(err)));
    const timer = setInterval(() => { void tick(); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [engine, room.roomId]);
  const decision = status ? decideSend(status) : { ok: false as const, reason: "encryption_unknown" as const };
  const send = async () => {
    const value = text;
    if (!value.trim()) return;
    setError(null);
    try {
      await engine.send(room.roomId, value);
      setText("");
    } catch (err) {
      setError(explain(err));
    }
  };
  const acknowledge = async () => {
    try { await engine.acknowledgeIdentityChange(room.roomId); } catch (err) { setError(explain(err)); }
  };
  return (
    <main className="grow">
      <Header title={room.name} left={["Back", back]} right={["Details", details]} />
      <div className="banner">
        <p className="small">{status?.encrypted ? "End-to-end encrypted. " : ""}{status ? trustLabel(status.identity) : "Checking…"}{status?.wasVerified && status.identity === "changed" ? " This contact was verified before." : ""}</p>
        {status?.identity === "changed" ? <button type="button" className="link" onClick={() => { void acknowledge(); }}>Acknowledge identity change</button> : null}
      </div>
      <div className="timeline">
        {messages.map((message) => (
          <article className={message.mine ? "msg mine" : "msg"} key={message.id}>
            <p>{message.utd ? messageText(true, message.body) : messageText(false, message.body)}</p>
            {message.mine && message.state !== "sent" ? <p className={message.state === "failed" ? "error" : "small"}>{message.state === "failed" ? "Failed" : "Sending…"}</p> : null}
            {message.mine && message.state === "failed" ? <button type="button" className="link" onClick={() => { void engine.retry(room.roomId, message.id).catch((err) => setError(explain(err))); }}>Retry</button> : null}
            {!message.mine && message.id.startsWith("$") ? <button type="button" className="link" data-report={message.id} onClick={() => setReportId(message.id)}>Report</button> : null}
          </article>
        ))}
        {reportId ? (
          <div className="dialog" data-report-dialog>
            <p>Report this message? Sends to your server administrators: the message id, the conversation id, your user id and the reason "Abuse". The app does not send the message text. The server already stores this message only in encrypted form.</p>
            <button type="button" className="link" onClick={() => setReportId(null)}>Cancel</button>
            <button type="button" className="button" data-report-confirm onClick={() => {
              const id = reportId;
              setReportId(null);
              void engine.report(room.roomId, id).catch((err) => setError(explain(err)));
            }}>Report</button>
          </div>
        ) : null}
      </div>
      {error ? <p className="error pad">{error}</p> : null}
      {!decision.ok ? <p className="small pad">{refusalText[decision.reason]}</p> : null}
      <div className="composer">
        <textarea className="field" value={text} onChange={(event) => setText(event.target.value)} placeholder="Message" disabled={!decision.ok} />
        <button type="button" className="link" disabled={!decision.ok} onClick={() => { void send(); }}>Send</button>
      </div>
    </main>
  );
}

function VerificationPanel({ engine, start, startLabel }: { engine: Engine; start: (() => Promise<void>) | null; startLabel: string }) {
  const [view, setView] = useState<VerificationView>(engine.verification());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setView(engine.verification()), 500);
    return () => clearInterval(timer);
  }, [engine]);
  const run = (fn: () => Promise<void>) => { setError(null); void fn().catch((err) => setError(explain(err))); };
  let body;
  if (view.phase === "sas") body = (
    <>
      <p>Check that the other device shows the same emoji, in the same order.</p>
      <div className="emoji-row">{view.emojis.map((emoji) => <div className="emoji" key={emoji.description}><span>{emoji.symbol}</span><p className="small">{emoji.description}</p></div>)}</div>
      <button type="button" className="button" onClick={() => run(() => engine.verifyConfirm())}>They match</button>
      <button type="button" className="link" onClick={() => run(() => engine.verifyMismatch())}>They don't match</button>
    </>
  );
  else if (view.phase === "incoming") body = (
    <>
      <p>{view.other} wants to verify with you.</p>
      <button type="button" className="button" onClick={() => run(() => engine.verifyAccept())}>Start</button>
      <button type="button" className="link" onClick={() => run(() => engine.verifyCancel())}>Decline</button>
    </>
  );
  else if (view.phase === "requested" || view.phase === "accepted") body = (
    <>
      <p>Waiting for the other device…</p>
      <button type="button" className="link" onClick={() => run(() => engine.verifyCancel())}>Cancel</button>
    </>
  );
  else if (view.phase === "done" || view.phase === "cancelled" || view.phase === "failed") body = (
    <>
      <p>{view.phase === "done" ? "Verified." : view.phase === "cancelled" ? "Verification cancelled. Nothing was marked as verified." : "Verification failed. Nothing was marked as verified."}</p>
      <button type="button" className="link" onClick={() => engine.verifyReset()}>OK</button>
    </>
  );
  else body = start ? <button type="button" className="button" onClick={() => run(start)}>{startLabel}</button> : null;
  return <div>{body}{error ? <p className="error">{error}</p> : null}</div>;
}

function Contact({ engine, room, back }: { engine: Engine; room: RoomSummary; back: () => void }) {
  const [status, setStatus] = useState<PeerView | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => Promise.all([engine.peerStatus(room.roomId), engine.blocked()]).then(([next, list]) => {
      if (live) { setStatus(next); setBlocked(list); }
    }).catch((err) => { if (live) setError(explain(err)); });
    void tick();
    const timer = setInterval(() => { void tick(); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [engine, room.roomId]);
  const peer = status?.peer ?? null;
  const isBlocked = !!peer && blocked.includes(peer);
  const run = (fn: () => Promise<void>) => { setError(null); void fn().catch((err) => setError(explain(err))); };
  return (
    <main>
      <Header title="Contact" left={["Back", back]} />
      <div className="pad">
        <p>{peer ?? "Unknown contact"}</p>
        <p className="small">{status ? trustLabel(status.identity) : "Checking…"}</p>
        <hr className="rule" />
        <p className="label">Verification</p>
        <VerificationPanel engine={engine} start={peer && status?.identity !== "verified" ? () => engine.verifyUser(peer, room.roomId) : null} startLabel="Verify with emoji" />
        <hr className="rule" />
        <p className="label">Block</p>
        <p className="small">Blocking adds this user to your ignore list on your server. You stop seeing their messages and invites.</p>
        <button type="button" className="button" disabled={!peer} onClick={() => peer && run(() => (isBlocked ? engine.unblock(peer) : engine.block(peer)))}>{isBlocked ? "Unblock" : "Block"}</button>
        <p className="small">To report a message, use Report on that message in the conversation.</p>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}

function Settings({ engine, session, back, onLogout }: { engine: Engine; session: SessionInfo; back: () => void; onLogout: () => void }) {
  const [own, setOwn] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => Promise.all([engine.ownDeviceVerified(), engine.blocked()]).then(([verified, list]) => {
      if (live) { setOwn(verified); setBlocked(list); }
    }).catch((err) => { if (live) setError(explain(err)); });
    void tick();
    const timer = setInterval(() => { void tick(); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [engine]);
  const run = (fn: () => Promise<void>) => { setError(null); void fn().catch((err) => setError(explain(err))); };
  return (
    <main>
      <Header title="Settings" left={["Back", back]} />
      <div className="pad">
        <Warning />
        <p className="label">Account</p>
        <p>{session.userId}</p>
        <p className="small">This device: {session.deviceId}. {own === null ? "Checking…" : own ? "Verified by your account." : "Not verified by your account."}</p>
        {own === false ? <p className="small">Until another of your signed-in devices verifies this one, you cannot verify contacts here. Your account's identity is never reset by this app.</p> : null}
        <VerificationPanel engine={engine} start={own === false ? () => engine.verifyOwnDevice() : null} startLabel="Verify with another device" />
        {blocked.length ? (
          <>
            <p className="label">Blocked</p>
            {blocked.map((userId) => (
              <p key={userId}><span className="muted">{userId}</span> <button type="button" className="link" onClick={() => run(() => engine.unblock(userId))}>Unblock</button></p>
            ))}
          </>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <hr className="rule" />
        <p className="label">Plan</p>
        <p>{REVENUE_PLAN}</p>
        <p className="label">Data revenue</p>
        <p>{REVENUE_DATA}</p>
        <hr className="rule" />
        <button type="button" className="button" disabled={busy} onClick={() => { setBusy(true); void engine.logout().finally(() => { setBusy(false); onLogout(); }); }}>{busy ? "Signing out…" : "Sign out and erase this device"}</button>
      </div>
    </main>
  );
}
