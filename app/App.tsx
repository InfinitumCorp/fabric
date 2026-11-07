import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import Matrix, { Message, PeerStatusNative, RoomSummary, Session } from './modules/fabric-matrix/src/FabricMatrixModule';
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
  ...refusalText,
};
const msg = (e: unknown) => ERR[(e as { code?: string })?.code ?? ''] ?? 'Something went wrong.';

type Route = { name: 'list' } | { name: 'new' } | { name: 'chat'; room: RoomSummary } | { name: 'settings' };

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
  else if (route.name === 'list') body = <ChatList go={setRoute} />;
  else if (route.name === 'new') body = <NewChat go={setRoute} />;
  else if (route.name === 'chat') body = <Conversation room={route.room} back={() => setRoute({ name: 'list' })} />;
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
  const [user, setUser] = useState('');
  const pw = useRef('');
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await Matrix!.login(hs.trim(), user.trim(), pw.current);
      await Matrix!.startSync();
      onDone(s);
    } catch (e) { setErr(msg(e)); }
    finally { pw.current = ''; input.current?.clear(); setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={s.pad} behavior="padding">
      <Text style={s.brand}>FabriC++</Text>
      <Text style={s.p}>Private, end-to-end encrypted messages.</Text>
      <Text style={s.label}>Server</Text>
      <TextInput style={s.input} value={hs} onChangeText={setHs} autoCapitalize="none" autoCorrect={false} />
      <Text style={s.label}>User name</Text>
      <TextInput style={s.input} value={user} onChangeText={setUser} autoCapitalize="none" autoCorrect={false} testID="user" />
      <Text style={s.label}>Password</Text>
      <TextInput ref={input} style={s.input} secureTextEntry onChangeText={(v) => { pw.current = v; }} autoCapitalize="none" testID="password" />
      {err ? <Text style={s.error}>{err}</Text> : null}
      <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={submit} disabled={busy || !user} />
      <Text style={s.small}>New accounts are created by the server administrator. Registration is closed.</Text>
    </KeyboardAvoidingView>
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

function Conversation({ room, back }: { room: RoomSummary; back: () => void }) {
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
      <Header title={room.name} left={['Back', back]} />
      <View style={s.banner}>
        <Text style={s.small}>
          {status?.encrypted ? 'End-to-end encrypted. ' : ''}{status ? trustLabel(status.identity) : 'Checking…'}
          {Matrix!.deviceVerification ? '' : '. Device verification is not available in this version yet.'}
        </Text>
        {status?.identity === 'changed' ? <Link label="Acknowledge identity change" onPress={ack} /> : null}
      </View>
      <FlatList style={{ flex: 1 }} contentContainerStyle={s.padH} data={msgs} keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={[s.msg, item.mine ? s.mine : null]}>
            <Text style={item.utd ? s.muted : s.msgText}>{item.utd ? 'Unable to decrypt' : item.body}</Text>
            {item.mine && item.state !== 'sent' ? <Text style={item.state === 'failed' ? s.error : s.small}>{item.state === 'failed' ? 'Failed' : 'Sending…'}</Text> : null}
          </View>
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
  composer: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderTopWidth: 1, borderTopColor: C.line },
});
