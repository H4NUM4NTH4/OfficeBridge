import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const EXPIRATIONS = [
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '3 hours', value: 180 },
  { label: '12 hours', value: 720 },
  { label: '24 hours', value: 1440 },
];

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function userHeaders(userId, extra = {}) {
  return { 'X-User-Id': userId, ...extra };
}

function Icon({ name, size = 20, strokeWidth = 1.8 }) {
  const paths = {
    bridge: <><path d="M3 17h18M5 17v-3a7 7 0 0 1 14 0v3"/><path d="M8 17v-3m8 3v-3M3 7h4m10 0h4M7 4l2 3m8-3-2 3"/></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    file: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/></>,
    download: <><path d="M12 4v12m-5-5 5 5 5-5"/><path d="M4 18v3h16v-3"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    trash: <><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zm4 4h3v3h-3zm0-4h3m-7 7v-3"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7"/></>,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.file}</svg>;
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><Icon name="bridge" size={22} /></span><span>Office<span className="brand-strong">Bridge</span></span></div>;
}

function Notice({ notice, onClose }) {
  if (!notice) return null;
  return <div className={`notice notice-${notice.type}`} role="status"><span>{notice.message}</span><button className="icon-button" onClick={onClose} aria-label="Dismiss message"><Icon name="close" size={16} /></button></div>;
}

function App() {
  const searchCode = new URLSearchParams(window.location.search).get('room') || '';
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem('officebridge-session') || 'null'); } catch { return null; } })();
  const [view, setView] = useState(searchCode ? 'join' : saved ? 'room' : 'home');
  const [session, setSession] = useState(saved);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [createForm, setCreateForm] = useState({ name: '', displayName: '', expirationMinutes: 60 });
  const [joinForm, setJoinForm] = useState({ code: searchCode.toUpperCase(), displayName: '' });

  const showNotice = useCallback((message, type = 'success') => {
    setNotice({ message, type });
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  const home = () => {
    setSession(null);
    setPending(null);
    sessionStorage.removeItem('officebridge-session');
    history.replaceState(null, '', window.location.pathname);
    setFormError('');
    setView('home');
  };

  async function createRoom(event) {
    event.preventDefault();
    setBusy(true); setFormError('');
    try {
      const result = await request('/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      });
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${result.room.code}`;
      const qrCode = await QRCode.toDataURL(shareUrl, { width: 280, margin: 1, color: { dark: '#172e40', light: '#ffffff' } });
      setPending({ room: result.room, user: result.user, qrCode, shareUrl });
      setView('created');
    } catch (error) { setFormError(error.message); }
    finally { setBusy(false); }
  }

  async function joinRoom(event) {
    event.preventDefault();
    setBusy(true); setFormError('');
    const code = joinForm.code.trim().toUpperCase();
    if (!joinForm.displayName.trim()) { setFormError('Add a display name to join the room.'); setBusy(false); return; }
    if (!/^[23456789A-HJ-NP-Z]{8}$/.test(code)) { setFormError('Enter the 8-character room code.'); setBusy(false); return; }
    try {
      const result = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: joinForm.displayName.trim() }),
      });
      enterRoom({ room: result.room, user: result.user });
    } catch (error) {
      const message = error.status === 404 ? 'We couldn’t find that room. Check the code and try again.'
        : error.status === 410 ? 'This room has expired. Ask the host to create a new one.'
          : error.message;
      setFormError(message);
    } finally { setBusy(false); }
  }

  function enterRoom(nextSession) {
    setSession(nextSession);
    sessionStorage.setItem('officebridge-session', JSON.stringify(nextSession));
    history.replaceState(null, '', window.location.pathname);
    setPending(null); setFormError(''); setView('room');
  }

  return <div className="app-shell">
    <header className="site-header"><button className="brand-button" onClick={home} aria-label="OfficeBridge home"><Brand /></button><div className="header-note"><span className="status-pip" /> Temporary rooms. Easy sharing.</div></header>
    <Notice notice={notice} onClose={() => setNotice(null)} />
    <main className="main-content">
      {view === 'home' && <Home onCreate={() => { setFormError(''); setView('create'); }} onJoin={() => { setFormError(''); setView('join'); }} />}
      {view === 'create' && <CreateView form={createForm} setForm={setCreateForm} error={formError} busy={busy} onSubmit={createRoom} onBack={() => setView('home')} />}
      {view === 'join' && <JoinView form={joinForm} setForm={setJoinForm} error={formError} busy={busy} onSubmit={joinRoom} onBack={() => setView('home')} />}
      {view === 'created' && pending && <CreatedView pending={pending} onEnter={() => enterRoom(pending)} onHome={home} onNotice={showNotice} />}
      {view === 'room' && session && <RoomView key={`${session.room.code}-${session.user.id}`} session={session} onExit={home} onNotice={showNotice} />}
    </main>
    <footer className="site-footer"><span>Made for the moments you need to move something across.</span><span>Temporary by design <span className="footer-dot">·</span> Private by room code</span></footer>
  </div>;
}

function Home({ onCreate, onJoin }) {
  return <section className="home-view">
    <div className="home-copy"><div className="eyebrow"><span className="eyebrow-line" /> A small bridge between your devices</div>
      <h1>Share files between devices, <span>without the hassle.</span></h1>
      <p className="lead">Drop files, notes, or snippets into a temporary room. Bring another device in with a quick code or scan.</p>
      <div className="home-actions"><button className="button button-primary button-large" onClick={onCreate}>Create Room <Icon name="arrow" size={18} /></button><button className="button button-secondary button-large" onClick={onJoin}>Join Room <span className="button-arrow">→</span></button></div>
      <div className="home-footnote"><span className="tiny-check"><Icon name="check" size={13} /></span> No account. No setup. Just share.</div>
    </div>
    <div className="hero-illustration" aria-hidden="true"><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="hero-glow"/><div className="device device-laptop"><div className="device-screen"><div className="screen-top"><i/><i/><i/></div><div className="screen-content"><span className="screen-label">A shared room</span><div className="screen-file"><span className="mini-file-icon">▤</span><span><b>project-notes.pdf</b><small>2.4 MB · just now</small></span><span className="mini-arrow">↓</span></div><div className="screen-file"><span className="mini-file-icon mint">⌘</span><span><b>ideas.md</b><small>4 KB · just now</small></span><span className="mini-arrow">↓</span></div><div className="screen-presence"><span className="avatar avatar-blue">J</span><span className="avatar avatar-orange">M</span><span className="avatar avatar-green">A</span><span>3 people here</span></div></div></div><div className="device-base"/></div><div className="device device-phone"><div className="phone-notch"/><div className="phone-screen"><div className="phone-header"><span>OB</span><span>•••</span></div><div className="phone-room">Studio share<small>ROOM CODE</small><b>H7KQ2B9M</b></div><div className="phone-drop"><span>↥</span><b>Drop it here</b><small>Files appear instantly</small></div><div className="phone-user"><span className="avatar avatar-orange">M</span><span><b>Maya joined</b><small>just now</small></span><i className="online-dot"/></div></div></div><div className="floating-chip chip-secure"><span>✦</span> Link by code</div><div className="floating-chip chip-fast"><span>↗</span> Here in seconds</div></div>
    <div className="home-bottom"><div><span className="bottom-icon"><Icon name="clock" size={18}/></span><span><b>Rooms fade away</b><small>Files are temporary, too.</small></span></div><div><span className="bottom-icon bottom-icon-lilac"><Icon name="qr" size={18}/></span><span><b>One scan is all it takes</b><small>Pick up on any device.</small></span></div><div><span className="bottom-icon bottom-icon-peach"><Icon name="spark" size={18}/></span><span><b>Everything stays together</b><small>Files and notes in one room.</small></span></div></div>
  </section>;
}

function FormFrame({ eyebrow, title, description, onBack, children }) {
  return <section className="form-view"><button className="back-link" onClick={onBack}>← <span>Back</span></button><div className="form-card"><div className="form-card-mark"><Icon name="bridge" size={22}/></div><div className="eyebrow form-eyebrow">{eyebrow}</div><h1>{title}</h1><p className="form-description">{description}</p>{children}</div></section>;
}

function CreateView({ form, setForm, error, busy, onSubmit, onBack }) {
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <FormFrame eyebrow="Start a shared space" title="Create a room" description="Give your room a name, then invite anyone with the code." onBack={onBack}>
    <form className="stack-form" onSubmit={onSubmit}>
      <label>Room name<input autoFocus maxLength="80" value={form.name} onChange={update('name')} placeholder="e.g. Saturday project" required /></label>
      <label>Your display name<input maxLength="40" value={form.displayName} onChange={update('displayName')} placeholder="What should we call you?" required /></label>
      <label>Room expires<select value={form.expirationMinutes} onChange={update('expirationMinutes')}>{EXPIRATIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><span className="field-hint">The room and its files are deleted when it expires.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary submit-button" disabled={busy}>{busy ? <><span className="spinner"/> Creating room…</> : <>Create room <Icon name="arrow" size={18}/></>}</button>
    </form>
  </FormFrame>;
}

function JoinView({ form, setForm, error, busy, onSubmit, onBack }) {
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: key === 'code' ? event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : event.target.value }));
  return <FormFrame eyebrow="You’re invited" title="Join a room" description="Enter the 8-character code shared with you." onBack={onBack}>
    <form className="stack-form" onSubmit={onSubmit}>
      <label>Room code<input className="code-input" autoFocus autoComplete="off" maxLength="8" value={form.code} onChange={update('code')} placeholder="AB12CD34" /></label>
      <label>Your display name<input maxLength="40" value={form.displayName} onChange={update('displayName')} placeholder="What should we call you?" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-primary submit-button" disabled={busy}>{busy ? <><span className="spinner"/> Joining room…</> : <>Join room <Icon name="arrow" size={18}/></>}</button>
    </form>
    <div className="join-help"><Icon name="qr" size={17}/> You can also scan the room’s QR code on your phone.</div>
  </FormFrame>;
}

function copyText(value, onNotice) {
  navigator.clipboard?.writeText(value).then(() => onNotice('Copied to clipboard.')).catch(() => onNotice('Could not access clipboard.', 'error'));
}

function CreatedView({ pending, onEnter, onHome, onNotice }) {
  return <section className="created-view"><div className="created-card"><div className="created-heading"><span className="success-mark"><Icon name="check" size={24}/></span><div><div className="eyebrow">Your room is ready</div><h1>{pending.room.name}</h1></div></div><div className="created-content"><div className="invite-code"><span>ROOM CODE</span><strong>{pending.room.code}</strong><button className="button button-small button-secondary" onClick={() => copyText(pending.room.code, onNotice)}><Icon name="copy" size={16}/> Copy code</button></div><div className="qr-card"><img src={pending.qrCode} alt={`QR code to join ${pending.room.name}`} /><span>Scan to join this room</span></div></div><div className="share-url"><span><Icon name="link" size={16}/>{pending.shareUrl}</span><button className="icon-button" onClick={() => copyText(pending.shareUrl, onNotice)} aria-label="Copy invite link"><Icon name="copy" size={17}/></button></div><div className="created-actions"><button className="button button-primary" onClick={onEnter}>Enter room <Icon name="arrow" size={18}/></button><button className="button button-quiet" onClick={onHome}>Back home</button></div></div><p className="created-note"><Icon name="clock" size={16}/> This room expires {new Date(pending.room.expiresAt).toLocaleString()}.</p></section>;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function timeAgo(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fileKind(file) {
  const mime = file.mimeType || '';
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('zip') || mime.includes('compressed')) return 'Archive';
  if (mime.includes('text') || /\.(txt|md|csv|log)$/i.test(file.originalFilename)) return 'Text';
  return 'File';
}

function RoomView({ session, onExit, onNotice }) {
  const [room, setRoom] = useState(session.room);
  const [users, setUsers] = useState([]);
  const [memberNames, setMemberNames] = useState({ [session.user.id]: session.user.displayName });
  const [files, setFiles] = useState([]);
  const [texts, setTexts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [roomError, setRoomError] = useState('');
  const [uploading, setUploading] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('');
  const [sharing, setSharing] = useState(false);
  const [qr, setQr] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fileInput = useRef(null);
  const socketRef = useRef(null);
  const joinUrl = useMemo(() => `${window.location.origin}${window.location.pathname}?room=${room.code}`, [room.code]);
  const remaining = useRoomCountdown(room.expiresAt);
  const namesRef = useRef(memberNames);
  namesRef.current = memberNames;

  const upsertFile = useCallback((file) => setFiles((current) => current.some((item) => item.id === file.id) ? current : [file, ...current]), []);
  const upsertText = useCallback((text) => setTexts((current) => current.some((item) => item.id === text.id) ? current : [...current, text]), []);

  useEffect(() => {
    let alive = true;
    async function loadRoom() {
      setLoading(true); setRoomError('');
      try {
        const headers = userHeaders(session.user.id);
        const [info, fileResult, textResult] = await Promise.all([
          request(`/api/rooms/${encodeURIComponent(session.room.code)}`, { headers }),
          request(`/api/rooms/${encodeURIComponent(session.room.code)}/files`, { headers }),
          request(`/api/rooms/${encodeURIComponent(session.room.code)}/texts`, { headers }),
        ]);
        if (!alive) return;
        setRoom(info.room);
        setFiles(fileResult.files);
        setTexts(textResult.texts);
        setMemberNames((current) => ({ ...current, ...Object.fromEntries(info.members.map((member) => [member.id, member.displayName])) }));
        const generated = await QRCode.toDataURL(joinUrl, { width: 320, margin: 1, color: { dark: '#172e40', light: '#ffffff' } });
        if (alive) setQr(generated);
      } catch (error) {
        if (alive) setRoomError(error.status === 410 ? 'This room has expired.' : error.status === 403 ? 'This room session is no longer available. Join again with the room code.' : error.message);
      } finally { if (alive) setLoading(false); }
    }
    loadRoom();
    return () => { alive = false; };
  }, [session, joinUrl]);

  useEffect(() => {
    if (roomError) return undefined;
    const socket = io(API_BASE || undefined, { auth: { roomCode: room.code, userId: session.user.id }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (error) => { setConnected(false); onNotice(error.message || 'Could not connect to the room.', 'error'); });
    socket.on('users:present', ({ users: current = [] }) => setUsers(current));
    socket.on('user:joined', ({ user }) => {
      if (!user?.id) return;
      setMemberNames((current) => ({ ...current, [user.id]: user.displayName }));
      setUsers((current) => current.some((item) => item.id === user.id) ? current : [...current, user]);
    });
    socket.on('user:left', ({ userId }) => setUsers((current) => current.filter((user) => user.id !== userId)));
    socket.on('file:uploaded', ({ file }) => upsertFile(file));
    socket.on('file:deleted', ({ fileId }) => setFiles((current) => current.filter((file) => file.id !== fileId)));
    socket.on('text:shared', ({ text }) => upsertText(text));
    socket.on('room:expired', () => setRoomError('This room has expired.'));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [room.code, session.user.id, roomError, onNotice, upsertFile, upsertText]);

  const uploadFiles = async (selectedFiles) => {
    const items = [...selectedFiles];
    for (const [index, selected] of items.entries()) {
      const uploadId = `${Date.now()}-${index}-${selected.name}`;
      setUploading((current) => [...current, { id: uploadId, name: selected.name, file: selected, progress: 0, error: '' }]);
      try {
        const file = await uploadWithProgress(selected, room.code, session.user.id, (progress) => {
          setUploading((current) => current.map((item) => item.id === uploadId ? { ...item, progress } : item));
        });
        upsertFile(file);
        setUploading((current) => current.filter((item) => item.id !== uploadId));
      } catch (error) {
        setUploading((current) => current.map((item) => item.id === uploadId ? { ...item, error: error.message, progress: 0 } : item));
      }
    }
  };

  async function shareText(event) {
    event.preventDefault();
    if (!content.trim()) return;
    setSharing(true);
    try {
      const result = await request(`/api/rooms/${encodeURIComponent(room.code)}/texts`, {
        method: 'POST', headers: userHeaders(session.user.id, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ content, language: language || undefined }),
      });
      upsertText(result.text); setContent(''); onNotice('Shared with the room.');
    } catch (error) { onNotice(error.message, 'error'); }
    finally { setSharing(false); }
  }

  async function downloadFile(file) {
    try {
      const response = await fetch(`${API_BASE}/api/rooms/${encodeURIComponent(room.code)}/files/${encodeURIComponent(file.id)}`, { headers: userHeaders(session.user.id) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Could not download file.'); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.originalFilename; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { onNotice(error.message, 'error'); }
  }

  async function deleteFile(file) {
    try {
      await request(`/api/rooms/${encodeURIComponent(room.code)}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers: userHeaders(session.user.id) });
      setFiles((current) => current.filter((item) => item.id !== file.id)); setConfirmDelete(null); onNotice('File removed from the room.');
    } catch (error) { onNotice(error.message, 'error'); }
  }

  if (roomError) return <section className="error-state"><div className="error-symbol">!</div><div className="eyebrow">Room unavailable</div><h1>{roomError}</h1><button className="button button-primary" onClick={onExit}>Back to OfficeBridge</button></section>;

  return <section className="room-view">
    <div className="room-topbar"><div><div className="room-breadcrumb"><button onClick={onExit}><Brand compact /></button><span>/</span><span>{room.name}</span></div><h1 className="room-title">{room.name}</h1><div className="room-meta"><span className="code-pill"><span>ROOM</span><b>{room.code}</b></span><span className="meta-divider"/><span className="expiry-meta"><Icon name="clock" size={15}/>{remaining}</span></div></div><div className="room-top-actions"><span className={`connection-badge ${connected ? 'is-connected' : ''}`}><i/>{connected ? 'Live' : 'Connecting'}</span><button className="button button-secondary invite-button" onClick={() => setShowQr(true)}><Icon name="qr" size={17}/> Invite</button><button className="button button-quiet exit-button" onClick={onExit}>Leave room <span>↗</span></button></div></div>
    {loading && <div className="loading-banner"><span className="spinner"/> Loading room…</div>}
    <div className="room-layout">
      <div className="room-main-column">
        <section className="panel upload-panel"><div className="panel-heading"><div><span className="section-kicker">01 <i>—</i> Share files</span><h2>Drop it in the room.</h2><p>Everyone here can download what you share.</p></div><div className="panel-heading-icon"><Icon name="upload" size={21}/></div></div>
          <div className={`drop-zone ${dragging ? 'drop-active' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); uploadFiles(event.dataTransfer.files); }}><div className="drop-icon"><Icon name="upload" size={22}/></div><div><b>Drag files here to share</b><span>or <button type="button" className="text-link" onClick={() => fileInput.current?.click()}>browse files</button> from your device</span><small>Room upload limit applies to each file</small></div><input ref={fileInput} type="file" multiple hidden onChange={(event) => { uploadFiles(event.target.files); event.target.value = ''; }} /></div>
          {uploading.length > 0 && <div className="upload-queue">{uploading.map((item) => <div className={`queue-item ${item.error ? 'queue-error' : ''}`} key={item.id}><div className="queue-label"><span>{item.error ? `${item.name} · upload failed` : item.name}</span><b>{item.error || `${item.progress}%`}</b></div><div className="progress-track"><i style={{ width: `${item.progress}%` }}/></div>{item.error && <div className="upload-error-actions"><button className="text-link" onClick={() => { setUploading((current) => current.filter((upload) => upload.id !== item.id)); uploadFiles([item.file]); }}>Try again</button><button className="text-link" onClick={() => setUploading((current) => current.filter((upload) => upload.id !== item.id))}>Dismiss</button></div>}</div>)}</div>}
        </section>
        <section className="panel files-panel"><div className="panel-heading compact-heading"><div><span className="section-kicker">02 <i>—</i> In this room</span><h2>Shared files <span className="count-bubble">{files.length}</span></h2></div><span className="panel-subtle">Newest first</span></div>
          {files.length === 0 ? <div className="empty-files"><span className="empty-file-icon"><Icon name="file" size={22}/></span><b>No files just yet</b><span>Shared files will show up here for everyone.</span></div> : <div className="file-list">{files.map((file) => <article className="file-row" key={file.id}><div className={`file-type-icon type-${fileKind(file).toLowerCase()}`}><Icon name="file" size={19}/></div><div className="file-details"><b title={file.originalFilename}>{file.originalFilename}</b><span>{fileKind(file)} <i>·</i> {formatSize(file.size)} <i>·</i> by {namesRef.current[file.uploaderId] || memberNames[file.uploaderId] || (file.uploaderId === session.user.id ? session.user.displayName : 'Room member')}</span></div><time>{timeAgo(file.createdAt)}</time><button className="icon-button file-action" aria-label={`Download ${file.originalFilename}`} onClick={() => downloadFile(file)}><Icon name="download" size={18}/></button><button className="icon-button file-action delete-action" aria-label={`Delete ${file.originalFilename}`} onClick={() => setConfirmDelete(file)}><Icon name="trash" size={17}/></button></article>)}</div>}
        </section>
        <section className="panel text-panel"><div className="panel-heading compact-heading"><div><span className="section-kicker">03 <i>—</i> Quick notes</span><h2>Share text or code</h2><p>A small note, a snippet, anything you want to pass along.</p></div><div className="text-icon">⌘</div></div><form onSubmit={shareText}><div className="editor-wrap"><div className="editor-toolbar"><span><i className="editor-dot dot-red"/><i className="editor-dot dot-yellow"/><i className="editor-dot dot-green"/></span><select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="">Plain text</option><option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="python">Python</option><option value="html">HTML</option><option value="css">CSS</option><option value="json">JSON</option><option value="sql">SQL</option><option value="bash">Bash</option></select></div><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={'Write a note or paste a code snippet…\n\nIt will appear here for everyone in the room.'} maxLength={50000} /></div><div className="editor-footer"><span>{content.length.toLocaleString()} / 50,000</span><button className="button button-primary button-share" disabled={sharing || !content.trim()}>{sharing ? <><span className="spinner spinner-light"/> Sharing…</> : <>Share with room <Icon name="arrow" size={16}/></>}</button></div></form>
          {texts.length > 0 && <div className="text-feed">{[...texts].reverse().map((item) => <article className="shared-note" key={item.id}><header><span className="note-author"><span className="avatar avatar-small">{(memberNames[item.userId] || (item.userId === session.user.id ? session.user.displayName : 'U')).slice(0, 1).toUpperCase()}</span><b>{memberNames[item.userId] || (item.userId === session.user.id ? session.user.displayName : 'Room member')}</b><time>{timeAgo(item.createdAt)}</time></span><div className="note-actions">{item.language && <span className="language-tag">{item.language}</span>}<button className="icon-button" onClick={() => copyText(item.content, onNotice)} aria-label="Copy shared text"><Icon name="copy" size={16}/></button></div></header><pre>{item.content}</pre></article>)}</div>}
        </section>
      </div>
      <aside className="room-side-column"><section className="panel people-panel"><div className="side-panel-title"><div><span className="section-kicker">Together now</span><h2>In this room</h2></div><span className="people-count">{users.length}</span></div><div className="people-list">{users.map((user, index) => <div className="person-row" key={user.id}><span className={`avatar avatar-${['blue', 'orange', 'green', 'lilac'][index % 4]}`}>{user.displayName?.slice(0, 1).toUpperCase()}</span><span className="person-name">{user.displayName}{user.id === session.user.id && <small>You</small>}</span><span className="online-dot" title="Online"/></div>)}</div><div className="online-caption"><span className="online-dot"/> {users.length} {users.length === 1 ? 'person' : 'people'} online</div></section>
        <section className="invite-side-card"><div className="invite-side-top"><span className="side-qr-icon"><Icon name="qr" size={17}/></span><span>Bring someone in</span></div><h3>Pick up on another device.</h3><p>Scan this room’s code with your phone camera.</p>{qr ? <button className="qr-preview-button" onClick={() => setShowQr(true)} aria-label="Enlarge room QR code"><img src={qr} alt="Room join QR code"/><span>Tap to enlarge</span></button> : <div className="qr-loading"><span className="spinner"/>Making your QR code</div>}<div className="side-room-code"><span>{room.code}</span><button className="icon-button" aria-label="Copy room code" onClick={() => copyText(room.code, onNotice)}><Icon name="copy" size={16}/></button></div><button className="button button-light-invite" onClick={() => copyText(joinUrl, onNotice)}><Icon name="link" size={16}/> Copy invite link</button></section>
        <div className="room-safety-note"><Icon name="clock" size={16}/><span><b>Temporary by design</b><small>This room expires in {remaining.toLowerCase()}.</small></span></div>
      </aside>
    </div>
    {showQr && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowQr(false); }}><section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title"><button className="icon-button modal-close" onClick={() => setShowQr(false)} aria-label="Close QR code"><Icon name="close"/></button><div className="eyebrow">Invite someone in</div><h2 id="qr-title">Scan to join {room.name}</h2>{qr && <img className="qr-large" src={qr} alt={`QR code to join ${room.name}`}/>}<p>Open your camera and point it at the code.</p><div className="modal-code">{room.code}<button className="icon-button" aria-label="Copy room code" onClick={() => copyText(room.code, onNotice)}><Icon name="copy" size={16}/></button></div><button className="button button-secondary modal-copy" onClick={() => copyText(joinUrl, onNotice)}><Icon name="link" size={16}/> Copy invite link</button></section></div>}
    {confirmDelete && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="delete-symbol"><Icon name="trash" size={19}/></div><h2 id="delete-title">Remove this file?</h2><p><b>{confirmDelete.originalFilename}</b> will be removed for everyone in the room.</p><div className="confirm-actions"><button className="button button-secondary" onClick={() => setConfirmDelete(null)}>Keep file</button><button className="button button-danger" onClick={() => deleteFile(confirmDelete)}>Remove file</button></div></section></div>}
  </section>;
}

function useRoomCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  if (!remaining) return 'Expired';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return 'Less than a minute left';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min left` : `${hours} hr left`;
}

function uploadWithProgress(file, roomCode, userId, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData(); formData.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/rooms/${encodeURIComponent(roomCode)}/files`);
    xhr.setRequestHeader('X-User-Id', userId);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch { /* backend error without JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result.file);
      else reject(new Error(result.error || 'Upload failed. Try a smaller file.'));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading.'));
    xhr.send(formData);
  });
}

export default App;
