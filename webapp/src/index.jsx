const React = window.React;
const {useEffect, useState} = React;

const PLUGIN_ID = 'com.github.morraycage.read-receipts';
const PROP = 'read_receipt';
const NOTICE_PROP = 'read_receipt_notice';
const API = `/plugins/${PLUGIN_ID}/api/v1`;

let store = null;

// ---- server calls -------------------------------------------------------

function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
    return m ? m[1] : '';
}

async function call(path, opts = {}) {
    const res = await fetch(API + path, {
        credentials: 'same-origin',
        ...opts,
        headers: {'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf(), ...(opts.headers || {})},
    });
    if (!res.ok) {
        throw new Error(`${res.status}`);
    }
    return res.status === 204 ? null : res.json();
}

// ---- receipt cache shared by every rendered post ---------------------------

const cache = new Map(); // post id -> receipt view
const listeners = new Map(); // post id -> Set(fn)
let queue = new Set();
let timer = null;

function emit(id) {
    (listeners.get(id) || []).forEach((fn) => fn(cache.get(id)));
}

function put(view) {
    cache.set(view.post_id, view);
    emit(view.post_id);
}

function request(id) {
    queue.add(id);
    if (!timer) {
        timer = setTimeout(flush, 60);
    }
}

async function flush() {
    const ids = [...queue];
    queue = new Set();
    timer = null;
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
            const out = await call(`/receipts?post_ids=${chunk.join(',')}`);
            Object.values(out || {}).forEach(put);
        } catch (e) {
            // Leave the posts without status; the next reconnect retries.
        }
    }
}

function useReceipt(postId) {
    const [view, setView] = useState(cache.get(postId));
    useEffect(() => {
        let set = listeners.get(postId);
        if (!set) {
            set = new Set();
            listeners.set(postId, set);
        }
        set.add(setView);
        if (!cache.has(postId)) {
            request(postId);
        }
        return () => set.delete(setView);
    }, [postId]);
    return view;
}

// ---- "seen" reporting ------------------------------------------------------

const lastSent = new Map(); // channel id -> ms

function focused() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

// The server keeps a short pending list per user, so a report costs one
// key read when nothing is pending. Throttled per channel.
function reportViewed() {
    if (!store || !focused()) {
        return;
    }
    const state = store.getState();
    const channelId = state.entities.channels.currentChannelId;
    if (!channelId) {
        return;
    }
    const now = Date.now();
    if (now - (lastSent.get(channelId) || 0) < 1500) {
        return;
    }
    lastSent.set(channelId, now);
    call('/viewed', {method: 'POST', body: JSON.stringify({channel_id: channelId}), headers: {'Content-Type': 'application/json'}}).catch(() => {});
}

// ---- rendering -------------------------------------------------------------

const C = {
    grey: 'rgba(var(--center-channel-color-rgb), 0.56)',
    blue: 'var(--button-bg, #1c58d9)',
};

function Ticks({double, color}) {
    return (
        <svg width={double ? 18 : 12} height='12' viewBox={double ? '0 0 18 12' : '0 0 12 12'} style={{verticalAlign: '-1px'}} aria-hidden='true'>
            <path d='M1 6.5l3 3L11 2.5' fill='none' stroke={color} strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round'/>
            {double && <path d='M7 9.5L14 2.5' fill='none' stroke={color} strokeWidth='1.6' strokeLinecap='round'/>}
        </svg>
    );
}

// Follows the user's "Clock display" setting like the rest of Mattermost.
function hour12() {
    const prefs = store ? store.getState().entities.preferences.myPreferences : {};
    const p = prefs && prefs['display_settings--use_military_time'];
    return !(p && p.value === 'true');
}

function fmt(ms) {
    if (!ms) {
        return '';
    }
    const d = new Date(ms);
    const today = new Date();
    const t = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', hour12: hour12()});
    return d.toDateString() === today.toDateString() ? t : `${d.toLocaleDateString([], {day: 'numeric', month: 'short'})} ${t}`;
}

function SenderStatus({post}) {
    const v = useReceipt(post.id);
    const [open, setOpen] = useState(false);
    if (!v) {
        return null;
    }
    const all = v.total;
    let label;
    let color = C.grey;
    let double = true;
    if (v.seen === all) {
        label = all === 1 ? 'Seen' : 'Seen by everyone';
        color = C.blue;
    } else if (v.seen > 0) {
        label = `Seen by ${v.seen} of ${all}`;
        color = C.blue;
    } else if (v.delivered > 0) {
        label = all === 1 ? 'Delivered' : `Delivered to ${v.delivered} of ${all}`;
    } else {
        label = 'Sent';
        double = false;
    }
    const single = all === 1 ? v.recipients[0] : null;
    const when = single ? fmt(single.seen_at || single.delivered_at) : '';

    return (
        <div style={{fontSize: 12, color: C.grey, marginTop: 2, userSelect: 'none'}}>
            <span
                role='button'
                tabIndex={0}
                onClick={() => setOpen(!open)}
                onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)}
                style={{cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4}}
                title='Show who received and saw this message'
            >
                <Ticks double={double} color={color}/>
                <span>{label}{when ? ` · ${when}` : ''}</span>
            </span>
            {open && (
                <div style={{display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 16, rowGap: 2, marginTop: 4, paddingLeft: 22}}>
                    {v.recipients.map((r) => (
                        <React.Fragment key={r.user_id}>
                            <span style={{color: 'var(--center-channel-color)'}}>{r.name || r.username}</span>
                            {r.seen_at ? <span style={{color: C.blue}}>Seen {fmt(r.seen_at)}</span> : <span>{r.delivered_at ? `Delivered ${fmt(r.delivered_at)}` : 'Not delivered yet'}</span>}
                        </React.Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}

function RecipientNotice() {
    return (
        <div style={{fontSize: 11, color: C.grey, marginTop: 2}} title='The sender sees when this message reaches you and when you open the conversation.'>
            <svg width='12' height='12' viewBox='0 0 24 24' style={{verticalAlign: '-2px', marginRight: 4}} aria-hidden='true'>
                <path d='M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 110-8 4 4 0 010 8z' fill='currentColor'/>
            </svg>
            Read receipt on
        </div>
    );
}

// The PostMessageAttachment slot passes only the post id.
function ReceiptLine(props) {
    const post = props.post || (store && store.getState().entities.posts.posts[props.postId]);
    if (!post || !post.props || !post.props[PROP] || !store) {
        return null;
    }
    const me = store.getState().entities.users.currentUserId;
    if (post.user_id === me) {
        return <SenderStatus post={post}/>;
    }
    return post.props[NOTICE_PROP] ? <RecipientNotice/> : null;
}

// ---- registration ----------------------------------------------------------

class PluginClass {
    initialize(registry, s) {
        store = s;
        registry.registerPostMessageAttachmentComponent(ReceiptLine);

        registry.registerWebSocketEventHandler(`custom_${PLUGIN_ID}_receipt`, (msg) => {
            let v = msg.data && msg.data.receipt;
            if (typeof v === 'string') {
                try {
                    v = JSON.parse(v);
                } catch (e) {
                    return;
                }
            }
            if (v && v.post_id) {
                put(v);
            }
        });

        registry.registerWebSocketEventHandler('posted', (msg) => {
            try {
                const post = JSON.parse(msg.data.post);
                const state = store.getState();
                if (post.props && post.props[PROP] && post.user_id !== state.entities.users.currentUserId &&
                    post.channel_id === state.entities.channels.currentChannelId) {
                    setTimeout(() => reportViewed(), 300);
                }
            } catch (e) {
                // Not a post we care about.
            }
        });

        registry.registerReconnectHandler(() => {
            [...cache.keys()].forEach(request);
            reportViewed();
        });

        let channel = null;
        this.unsubscribe = store.subscribe(() => {
            const cur = store.getState().entities.channels.currentChannelId;
            if (cur !== channel) {
                channel = cur;
                setTimeout(() => reportViewed(), 500);
            }
        });
        this.onFocus = () => reportViewed();
        window.addEventListener('focus', this.onFocus);
        document.addEventListener('visibilitychange', this.onFocus);
    }

    uninitialize() {
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        window.removeEventListener('focus', this.onFocus);
        document.removeEventListener('visibilitychange', this.onFocus);
    }
}

window.registerPlugin(PLUGIN_ID, new PluginClass());
