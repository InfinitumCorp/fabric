import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import Matrix, { Message, PeerStatusNative, RoomSummary, Session, VerificationState } from './modules/fabric-matrix/src/FabricMatrixModule';
import { isValidUserId, refusalText, sendDecision, trustLabel } from '../core/src/conversation';

const C = { paper: '#ffffff', ink: '#111820', muted: '#52606b', line: '#d6dce1', accent: '#2454dd', danger: '#a3261b' };
const FONT = Platform.select({ android: 'sans-serif', default: 'Helvetica' });
// Release 1 test backend: the local Synapse, reached from the Android emulator at 10.0.2.2. Editable on the sign-in screen.
const DEFAULT_HS = 'http://10.0.2.2:8008';
const ERR: Record<string, string> = {
  login_failed: 'Sign-in failed. Check the user name and password.',
  store_locked: 'Local data is locked and cannot be opened. Sign out to wipe it.',
  not_signed_in: 'Not signed in.',
  bad_input: 'That user id is not valid. Use @name:server.',
  create_failed: 'Could not start the conversation.',
  send_failed: 'Message not sent.',
  own_device_unverified: 'This device is not verified by your own account yet, so it cannot verify others. Sign in on a new account or verify this device first (not available in this version).',
  verify_failed: 'Verification could not continue.',
  report_failed: 'Report not sent.',
  block_failed: 'Could not update the block list.',
  ...refusalText,
};
const msg = (e: unknown) => ERR[(e as { code?: string })?.code ?? ''] ?? 'Something went wrong.';

type Route = { name: 'list' } | { name: 'new' } | { name: 'chat'; room: RoomSummary } | { name: 'contact'; room: RoomSummary } | { name: 'settings' };

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [hs, setHs] = useState(DEFAULT_HS);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Matrix?.encryptedMessaging) { setSession(null); return; }
    Matrix.restore(DEFAULT_HS).then(async (s) => { if (s) await Matrix!.startSync(); setSession(s); })
      .catch((e) => { setError(msg(e)); setSession(null); });
  }, []);

  let body;
  if (!Matrix?.encryptedMessaging) body = <Unavailable />;
  else if (session === undefined) body = <Center text="Opening…" />;
  else if (!session) body = <SignIn hs={hs} setHs={setHs} error={error} onDone={(s) => { setError(null); setSession(s); setRoute({ name: 'list' }); }} />;
  else if (route.name === 'contact') body = <Contact room={route.room} back={() => setRoute({ name: 'chat', room: route.room })} />;
  else if (route.name === 'list') body = <ChatList go={setRoute} />;
  else if (route.name === 'new') body = <NewChat go={setRoute} />;
  else if (route.name === 'chat') { const room = route.room; body = <Conversation room={room} back={() => setRoute({ name: 'list' })} details={() => setRoute({ name: 'contact', room })} />; }
  else body = <Settings session={session} back={() => setRoute({ name: 'list' })} onLogout={() => setSession(null)} />;

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />
      {body}
    </SafeAreaView>
  );
}

function Header({ title, left, right }: { title: string; left?: [string, () => void]; right?: [string, () => void] }) {
  return (
    <View style={s.header}>
      {left ? <Link label={left[0]} onPress={left[1]} /> : <View style={{ width: 8 }} />}
      <Text style={s.h1} numberOfLines={1}>{title}</Text>
      {right ? <Link label={right[0]} onPress={right[1]} /> : <View style={{ width: 8 }} />}
    </View>
  );
}
const Link = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}><Text style={s.link}>{label}</Text></Pressable>
);
const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => (
  <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={[s.button, disabled && { opacity: 0.4 }]}>
    <Text style={s.buttonText}>{label}</Text>
  </Pressable>
);
const Center = ({ text }: { text: string }) => <View style={s.center}><Text style={s.muted}>{text}</Text></View>;

function Unavailable() {
  return (<View style={s.pad}><Text style={s.brand}>FabriC++</Text>
    <Text style={s.p}>Encrypted messaging is not available in this build on this platform.</Text></View>);
}

function SignIn({ hs, setHs, error, onDone }: { hs: string; setHs: (v: string) => void; error: string | null; onDone: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);
  // User name and password are entered on a native screen; JavaScript never receives them.
  const open = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await Matrix!.signIn(hs.trim());
      if (s) { await Matrix!.startSync(); onDone(s); }
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <View style={s.pad}>
      <Text style={s.brand}>FabriC++</Text>
      <Text style={s.p}>Private, end-to-end encrypted messages.</Text>
      <Text style={s.label}>Server</Text>
      <TextInput style={s.input} value={hs} onChangeText={setHs} autoCapitalize="none" autoCorrect={false} />
      {err ? <Text style={s.error}>{err}</Text> : null}
      <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={open} disabled={busy || !hs} />
      <Text style={s.small}>New accounts are created by the server administrator. Registration is closed.</Text>
    </View>
  );
}

function ChatList({ go }: { go: (r: Route) => void }) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => Matrix!.rooms().then(setRooms).catch((e) => setErr(msg(e))), []);
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, [load]);
  const openRoom = async (r: RoomSummary) => {
    try { if (r.invited) await Matrix!.join(r.roomId); go({ name: 'chat', room: { ...r, invited: false } }); } catch (e) { setErr(msg(e)); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="FabriC++" left={['Settings', () => go({ name: 'settings' })]} right={['New', () => go({ name: 'new' })]} />
      {err ? <Text style={[s.error, s.padH]}>{err}</Text> : null}
      {rooms === null ? <Center text="Loading…" /> : rooms.length === 0 ? <Center text="No conversations yet." /> : (
        <FlatList data={rooms} keyExtractor={(r) => r.roomId} ItemSeparatorComponent={() => <View style={s.rule} />}
          renderItem={({ item }) => (
            <Pressable style={s.row} onPress={() => openRoom(item)}>
              <Text style={s.rowTitle} numberOfLines={1}>{item.name}</Text>
              <Text style={s.muted} numberOfLines={1}>{item.invited ? 'Invitation. Tap to accept.' : item.peer ?? ''}</Text>
            </Pressable>
          )} />
      )}
    </View>
  );
}

function NewChat({ go }: { go: (r: Route) => void }) {
  const [id, setId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const v = id.trim();
    if (!isValidUserId(v)) { setErr(ERR.bad_input); return; }
    setBusy(true); setErr(null);
    try { const roomId = await Matrix!.createDm(v); go({ name: 'chat', room: { roomId, name: v, peer: v, invited: false } }); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="New chat" left={['Back', () => go({ name: 'list' })]} />
      <View style={s.pad}>
        <Text style={s.label}>User id</Text>
        <TextInput style={s.input} value={id} onChangeText={setId} placeholder="@name:server" autoCapitalize="none" autoCorrect={false} />
        {err ? <Text style={s.error}>{err}</Text> : null}
        <Button label="Start encrypted chat" onPress={create} disabled={busy || !id} />
      </View>
    </View>
  );
}

function Conversation({ room, back, details }: { room: RoomSummary; back: () => void; details: () => void }) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [status, setStatus] = useState<PeerStatusNative | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [m, st] = await Promise.all([Matrix!.messages(room.roomId), Matrix!.peerStatus(room.roomId)]);
        if (live) { setMsgs(m); setStatus(st); }
      } catch (e) { if (live) setErr(msg(e)); }
    };
    Matrix!.open(room.roomId).then(tick).catch((e) => setErr(msg(e)));
    const t = setInterval(tick, 1500);
    return () => { live = false; clearInterval(t); };
  }, [room.roomId]);
  const decision = status ? sendDecision(status) : ({ ok: false, reason: 'encryption_unknown' } as const);
  const send = async () => {
    const v = text; if (!v.trim()) return;
    setErr(null);
    try { await Matrix!.send(room.roomId, v); setText(''); } catch (e) { setErr(msg(e)); }
  };
  const ack = async () => { try { await Matrix!.acknowledgeIdentityChange(room.roomId); } catch (e) { setErr(msg(e)); } };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <Header title={room.name} left={['Back', back]} right={['Details', details]} />
      <View style={s.banner}>
        <Text style={s.small}>
          {status?.encrypted ? 'End-to-end encrypted. ' : ''}{status ? trustLabel(status.identity) : 'Checking…'}
          {Matrix!.deviceVerification ? '' : '. Device verification is not available in this build.'}
        </Text>
        {status?.identity === 'changed' ? <Link label="Acknowledge identity change" onPress={ack} /> : null}
      </View>
      <FlatList style={{ flex: 1 }} contentContainerStyle={s.padH} data={msgs} keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <Pressable onLongPress={() => !item.mine && item.id.startsWith('$') && confirmReport(room.roomId, item.id, setErr)} style={[s.msg, item.mine ? s.mine : null]}>
            <Text style={item.utd ? s.muted : s.msgText}>{item.utd ? 'Unable to decrypt' : item.body}</Text>
            {item.mine && item.state !== 'sent' ? <Text style={item.state === 'failed' ? s.error : s.small}>{item.state === 'failed' ? 'Failed' : 'Sending…'}</Text> : null}
          </Pressable>
        )} />
      {err ? <Text style={[s.error, s.padH]}>{err}</Text> : null}
      {!decision.ok ? <Text style={[s.small, s.padH]}>{refusalText[decision.reason]}</Text> : null}
      <View style={s.composer}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} value={text} onChangeText={setText} placeholder="Message" editable={decision.ok} multiline />
        <Link label="Send" onPress={send} />
      </View>
    </KeyboardAvoidingView>
  );
}

// Reporting is opt-in per message and discloses exactly what is sent. Message text is never uploaded by the app.
function confirmReport(roomId: string, eventId: string, setErr: (v: string | null) => void) {
  Alert.alert('Report this message?',
    'Sends to your server administrators: the message id, the conversation id, your user id and the reason "Abuse". ' +
    'The app does not send the message text. The server already stores this message only in encrypted form.',
    [{ text: 'Cancel', style: 'cancel' },
     { text: 'Report', style: 'destructive', onPress: () => { Matrix!.report(roomId, eventId, 'Abuse').then(() => Alert.alert('Reported')).catch((e) => setErr(msg(e))); } }]);
}

function Contact({ room, back }: { room: RoomSummary; back: () => void }) {
  const [st, setSt] = useState<PeerStatusNative | null>(null);
  const [v, setV] = useState<VerificationState | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [a, b, c] = await Promise.all([Matrix!.peerStatus(room.roomId), Matrix!.verificationState(), Matrix!.blocked()]);
        if (live) { setSt(a); setV(b); setBlocked(c); }
      } catch (e) { if (live) setErr(msg(e)); }
    };
    tick(); const t = setInterval(tick, 1000);
    return () => { live = false; clearInterval(t); };
  }, [room.roomId]);
  const run = (f: () => Promise<void>) => { setErr(null); f().catch((e) => setErr(msg(e))); };
  const peer = st?.peer ?? null;
  const isBlocked = !!peer && blocked.includes(peer);
  const phase = v?.phase ?? 'idle';
  return (
    <View style={{ flex: 1 }}>
      <Header title="Contact" left={['Back', back]} />
      <View style={s.pad}>
        <Text style={s.p}>{peer ?? 'Unknown contact'}</Text>
        <Text style={s.small}>{st ? trustLabel(st.identity) : 'Checking…'}</Text>
        <View style={s.rule} />
        <Text style={s.label}>Verification</Text>
        {!Matrix!.deviceVerification ? <Text style={s.p}>Not available in this build.</Text>
          : phase === 'sas' ? (<>
            <Text style={s.p}>Check that {v?.other ?? 'the other person'} sees the same emoji, in the same order.</Text>
            <View style={s.emojiRow}>{v!.emojis.map((e, i) => (<View key={i} style={s.emoji}><Text style={{ fontSize: 28 }}>{e.symbol}</Text><Text style={s.small}>{e.description}</Text></View>))}</View>
            <Button label="They match" onPress={() => run(() => Matrix!.verifyConfirm())} />
            <Link label="They don't match" onPress={() => run(() => Matrix!.verifyMismatch())} />
          </>) : phase === 'incoming' ? (<>
            <Text style={s.p}>{v?.other} wants to verify with you.</Text>
            <Button label="Start" onPress={() => run(() => Matrix!.verifyAccept())} />
            <Link label="Decline" onPress={() => run(() => Matrix!.verifyCancel())} />
          </>) : phase === 'requested' || phase === 'accepted' ? (<>
            <Text style={s.p}>Waiting for the other device…</Text>
            <Link label="Cancel" onPress={() => run(() => Matrix!.verifyCancel())} />
          </>) : phase === 'done' || phase === 'cancelled' || phase === 'failed' ? (<>
            <Text style={s.p}>{phase === 'done' ? 'Verified.' : phase === 'cancelled' ? 'Verification cancelled. Nothing was marked as verified.' : 'Verification failed. Nothing was marked as verified.'}</Text>
            <Link label="OK" onPress={() => run(() => Matrix!.verifyReset())} />
          </>) : (
            <Button label="Verify with emoji" disabled={!peer || st?.identity === 'verified'} onPress={() => run(() => Matrix!.verifyUser(peer!))} />
          )}
        <View style={s.rule} />
        <Text style={s.label}>Block</Text>
        <Text style={s.small}>Blocking adds this user to your ignore list on your server. You stop seeing their messages and invites.</Text>
        <Button label={isBlocked ? 'Unblock' : 'Block'} disabled={!peer} onPress={() => run(() => (isBlocked ? Matrix!.unblock(peer!) : Matrix!.block(peer!)))} />
        <Text style={s.small}>To report a message, press and hold it in the conversation.</Text>
        {err ? <Text style={s.error}>{err}</Text> : null}
      </View>
    </View>
  );
}

function Settings({ session, back, onLogout }: { session: Session; back: () => void; onLogout: () => void }) {
  const [busy, setBusy] = useState(false);
  const logout = async () => { setBusy(true); try { await Matrix!.logoutAndWipe(); } finally { setBusy(false); onLogout(); } };
  return (
    <View style={{ flex: 1 }}>
      <Header title="Settings" left={['Back', back]} />
      <View style={s.pad}>
        <Text style={s.label}>Account</Text>
        <Text style={s.p}>{session.userId}</Text>
        <Text style={s.small}>This device: {session.deviceId}</Text>
        <View style={s.rule} />
        <Text style={s.label}>Plan</Text>
        <Text style={s.p}>Not connected. Plans and upgrades are not available in this build. Personal messaging is free.</Text>
        <Text style={s.label}>Data revenue</Text>
        <Text style={s.p}>Not connected. No data is shared and there are no earnings to show. Messaging does not depend on this.</Text>
        <View style={s.rule} />
        <Button label={busy ? 'Signing out…' : 'Sign out and erase this device'} onPress={logout} disabled={busy} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper, paddingTop: Platform.OS === 'android' ? 24 : 0 },
  pad: { padding: 20 }, padH: { paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line },
  h1: { flex: 1, textAlign: 'center', fontFamily: FONT, fontWeight: '400', fontSize: 18, color: C.ink, letterSpacing: -0.3 },
  brand: { fontFamily: FONT, fontWeight: '400', fontSize: 32, color: C.ink, letterSpacing: -0.8, marginBottom: 8 },
  p: { fontFamily: FONT, fontSize: 15, color: C.ink, marginBottom: 12, lineHeight: 21 },
  muted: { fontFamily: FONT, fontSize: 14, color: C.muted },
  small: { fontFamily: FONT, fontSize: 12, color: C.muted, marginTop: 4 },
  label: { fontFamily: FONT, fontSize: 13, color: C.muted, marginTop: 12, marginBottom: 6 },
  input: { fontFamily: FONT, fontSize: 15, color: C.ink, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 4, borderRadius: 0 },
  button: { backgroundColor: C.accent, paddingVertical: 13, alignItems: 'center', marginTop: 16, borderRadius: 0 },
  buttonText: { fontFamily: FONT, fontSize: 15, color: C.paper },
  link: { fontFamily: FONT, fontSize: 15, color: C.accent },
  error: { fontFamily: FONT, fontSize: 13, color: C.danger, marginTop: 8 },
  rule: { height: 1, backgroundColor: C.line, marginVertical: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 14 },
  rowTitle: { fontFamily: FONT, fontSize: 16, color: C.ink, marginBottom: 2 },
  banner: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  msg: { marginVertical: 6, maxWidth: '82%', alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, padding: 10 },
  mine: { alignSelf: 'flex-end', borderColor: C.accent },
  msgText: { fontFamily: FONT, fontSize: 15, color: C.ink },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 8 },
  emoji: { alignItems: 'center', width: 64 },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: 1, borderTopColor: C.line },
});
