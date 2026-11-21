// End-to-end test of com.github.morraycage.read-receipts against the local dev server.
import {readFileSync} from 'node:fs';

const BASE = 'http://localhost:8065';
const BUNDLE = process.argv[2];
const USERS = ['hr', 'alice', 'bob', 'carol'];
const PASS = (u) => `Dev-pass-1-${u}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(token, method, path, body, raw) {
    const res = await fetch(BASE + '/api/v4' + path, {
        method,
        headers: {
            ...(token ? {Authorization: `Bearer ${token}`} : {}),
            ...(raw ? {} : {'Content-Type': 'application/json'}),
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 200)}`);
    return {data: text ? JSON.parse(text) : null, headers: res.headers};
}

async function plug(token, method, path, body) {
    const res = await fetch(`${BASE}/plugins/com.github.morraycage.read-receipts/api/v1${path}`, {
        method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`plugin ${path} ${res.status}`);
    return res.status === 204 ? null : res.json();
}

const T = {}; const ID = {};
for (const u of USERS) {
    try {
        await api(null, 'POST', '/users', {username: u, email: `${u}@example.test`, password: PASS(u)});
    } catch (e) { /* exists */ }
    const res = await fetch(BASE + '/api/v4/users/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({login_id: u, password: PASS(u)})});
    T[u] = res.headers.get('token');
    ID[u] = (await res.json()).id;
}
const admin = T.hr; // first user created is system admin

// Install the bundle.
const form = new FormData();
form.append('plugin', new Blob([readFileSync(BUNDLE)]), 'bundle.tar.gz');
form.append('force', 'true');
await api(admin, 'POST', '/plugins', form, true);
await api(admin, 'POST', '/plugins/com.github.morraycage.read-receipts/enable');
const cfg = (await api(admin, 'GET', '/config')).data;
cfg.PluginSettings.Plugins['com.github.morraycage.read-receipts'] = {senderusernames: 'hr', trackdirect: true, trackgroup: true, trackchannels: false, maxrecipients: 50, retentiondays: 30, showrecipientnotice: true};
await api(admin, 'PUT', '/config', cfg);
await sleep(1500);

// Team + channels.
let team;
try { team = (await api(admin, 'POST', '/teams', {name: 'dev', display_name: 'Dev', type: 'O'})).data; } catch (e) { team = (await api(admin, 'GET', '/teams/name/dev')).data; }
for (const u of USERS) await api(admin, 'POST', `/teams/${team.id}/members`, {team_id: team.id, user_id: ID[u]}).catch(() => {});

const dm = (await api(T.hr, 'POST', '/channels/direct', [ID.hr, ID.alice])).data;
const gm = (await api(T.hr, 'POST', '/channels/group', [ID.hr, ID.alice, ID.bob, ID.carol])).data;
const pub = (await api(admin, 'POST', '/channels', {team_id: team.id, name: 'town-' + Date.now(), display_name: 'Town', type: 'O'})).data;
for (const u of ['alice', 'bob']) await api(admin, 'POST', `/channels/${pub.id}/members`, {user_id: ID[u]});


// Sender listens for receipt events.
const events = [];
const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/v4/websocket');
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({seq: 1, action: 'authentication_challenge', data: {token: T.hr}}));
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.event === 'custom_com.github.morraycage.read-receipts_receipt') events.push(JSON.parse(d.data.receipt)); };
await sleep(800);

let ok = true;
const check = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) ok = false; };

// 1. DM to offline alice: tracked, sent only.
const p1 = (await api(T.hr, 'POST', '/posts', {channel_id: dm.id, message: 'dm test'})).data;
check('DM post carries tracked prop', p1.props?.read_receipt === true && p1.props?.read_receipt_notice === true);
await sleep(500);
let r = (await plug(T.hr, 'GET', `/receipts?post_ids=${p1.id}`))[p1.id];
check('DM receipt: sent, not delivered', r && r.total === 1 && r.delivered === 0 && r.seen === 0, JSON.stringify(r && {d: r.delivered, s: r.seen}));

// 2. Only the sender can read it.
const leak = await plug(T.alice, 'GET', `/receipts?post_ids=${p1.id}`);
check('recipient cannot read sender receipts', Object.keys(leak).length === 0);

// 3. Alice connects a websocket: delivered.
// Authenticated at upgrade time, like a browser with its session cookie.
const wsA = new WebSocket(BASE.replace('http', 'ws') + '/api/v4/websocket', {headers: {Authorization: `Bearer ${T.alice}`}});
await new Promise((res, rej) => { wsA.onopen = res; wsA.onerror = rej; });
await sleep(1500);
r = (await plug(T.hr, 'GET', `/receipts?post_ids=${p1.id}`))[p1.id];
check('DM receipt: delivered after alice connects', r.delivered === 1 && r.seen === 0);
check('sender got a live delivered event', events.some((e) => e.post_id === p1.id && e.delivered === 1));

// 4. Alice views the channel through the webapp endpoint: seen.
await plug(T.alice, 'POST', '/viewed', {channel_id: dm.id});
r = (await plug(T.hr, 'GET', `/receipts?post_ids=${p1.id}`))[p1.id];
check('DM receipt: seen after alice views', r.seen === 1 && r.recipients[0].seen_at > 0);
check('sender got a live seen event', events.some((e) => e.post_id === p1.id && e.seen === 1));

// 5. Viewing a channel you are not in is refused.
let refused = false;
try { await plug(T.carol, 'POST', '/viewed', {channel_id: dm.id}); } catch (e) { refused = e.message.includes('403'); }
check('viewed refused for non-member', refused);

// 6. GM with alice online: alice delivered at post time, others not.
const p2 = (await api(T.hr, 'POST', '/posts', {channel_id: gm.id, message: 'gm test'})).data;
await sleep(500);
r = (await plug(T.hr, 'GET', `/receipts?post_ids=${p2.id}`))[p2.id];
check('GM receipt: 3 recipients, alice delivered at once', r.total === 3 && r.delivered === 1, JSON.stringify({d: r.delivered, s: r.seen}));

// 7. Mobile-style fallback: bob marks the channel viewed with the core API (no plugin call), sweep picks it up.
await api(T.bob, 'POST', '/channels/members/me/view', {channel_id: gm.id});
console.log('      waiting for the 30 s sweep...');
let swept = false;
for (let i = 0; i < 40 && !swept; i++) {
    await sleep(1000);
    r = (await plug(T.hr, 'GET', `/receipts?post_ids=${p2.id}`))[p2.id];
    swept = r.recipients.find((x) => x.username === 'bob')?.seen_at > 0;
}
check('GM receipt: bob seen through the sweep fallback', swept, JSON.stringify({d: r.delivered, s: r.seen}));

// 8. Public channels are off by default.
const p3 = (await api(T.hr, 'POST', '/posts', {channel_id: pub.id, message: 'channel test'})).data;
check('public channel post not tracked', !p3.props?.read_receipt);

// 9. Non-sender DM not tracked.
const dm2 = (await api(T.alice, 'POST', '/channels/direct', [ID.alice, ID.bob])).data;
const p4 = (await api(T.alice, 'POST', '/posts', {channel_id: dm2.id, message: 'peer dm'})).data;
check('message from a non-sender not tracked', !p4.props?.read_receipt);

// 10. Deleting the post removes the receipt.
await api(T.hr, 'DELETE', `/posts/${p1.id}`);
await sleep(300);
const gone = await plug(T.hr, 'GET', `/receipts?post_ids=${p1.id}`);
check('receipt removed with the post', Object.keys(gone).length === 0);

ws.close(); wsA.close();
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
