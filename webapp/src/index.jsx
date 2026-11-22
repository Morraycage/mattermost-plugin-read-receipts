const React = window.React;
const {useEffect, useRef, useState} = React;
const ReactDOM = window.ReactDOM;

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

function summary(v) {
    const all = v.total;
    if (v.seen === all) {
        return {label: all === 1 ? 'Seen' : 'Seen by everyone', color: C.blue, double: true};
    }
    if (v.seen > 0) {
        return {label: `Seen by ${v.seen} of ${all}`, color: C.blue, double: true};
    }
    if (v.delivered > 0) {
        return {label: all === 1 ? 'Delivered' : `Delivered to ${v.delivered} of ${all}`, color: C.grey, double: true};
    }
    return {label: 'Sent', color: C.grey, double: false};
}

// The post body clips overflow, so the detail is drawn in a fixed layer on
// <body>. It opens below the ticks so it never covers the post's hover menu
// (reactions, reply...), which sits above them. Without room below, it opens
// above the post and its menu.
function Detail({v, label, anchor}) {
    const r = anchor.getBoundingClientRect();
    const height = 28 + (18 * v.recipients.length);
    const view = anchor.closest('.post-list__dynamic, .post-list__content') || document.documentElement;
    const limit = Math.min(window.innerHeight, view.getBoundingClientRect().bottom);
    let pos;
    if (r.bottom + 4 + height <= limit) {
        pos = {top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right)};
    } else {
        // The hover menu straddles the top edge of the post (about 30 px above
        // it), and may not be rendered yet: clear that band.
        const post = anchor.closest('.post');
        const top = post ? post.getBoundingClientRect().top : r.top;
        pos = {bottom: window.innerHeight - top + 30, right: Math.max(8, window.innerWidth - r.right)};
    }
    const box = (
        <div
            role='tooltip'
            style={{
                position: 'fixed', ...pos, zIndex: 1000,
                fontSize: 12, lineHeight: '16px', background: 'var(--center-channel-bg, #fff)', color: 'var(--center-channel-color)',
                border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)', borderRadius: 4,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)', padding: '6px 10px', whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
        >
            <div style={{fontWeight: 600, marginBottom: v.recipients.length ? 4 : 0}}>{label}</div>
            <div style={{display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 16, rowGap: 2}}>
                {v.recipients.map((x) => (
                    <React.Fragment key={x.user_id}>
                        <span>{x.name || x.username}</span>
                        {x.seen_at ? <span style={{color: C.blue}}>Seen {fmt(x.seen_at)}</span> : <span style={{color: C.grey}}>{x.delivered_at ? `Delivered ${fmt(x.delivered_at)}` : 'Not delivered yet'}</span>}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
    return ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(box, document.body) : box;
}

// Only the ticks are shown, like other messengers; the detail opens on hover
// (or on click / Enter, which also keeps it open).
function SenderStatus({post}) {
    const v = useReceipt(post.id);
    const [hover, setHover] = useState(false);
    const [pinned, setPinned] = useState(false);
    const anchor = useRef(null);
    const open = hover || pinned;
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        // The bubble is fixed on the page: close it when the list moves.
        const close = () => {
            setHover(false);
            setPinned(false);
        };
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [open]);
    if (!v) {
        return null;
    }
    const {label, color, double} = summary(v);

    return (
        <div style={{position: 'relative', height: 0, fontSize: 12, lineHeight: '14px', userSelect: 'none'}}>
            <span
                ref={anchor}
                role='button'
                tabIndex={0}
                aria-label={label}
                aria-expanded={open}
                onClick={() => setPinned(!pinned)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setPinned(!pinned)}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                onBlur={() => setPinned(false)}
                style={{cursor: 'pointer', position: 'absolute', right: 0, bottom: 3, display: 'inline-flex', alignItems: 'center', padding: '1px 2px'}}
            >
                <Ticks double={double} color={color}/>
                {open && anchor.current && <Detail v={v} label={label} anchor={anchor.current}/>}
            </span>
        </div>
    );
}

function RecipientNotice() {
    const text = 'Read receipt on: the sender sees when this message reaches you and when you open the conversation.';
    return (
        <div style={{position: 'relative', height: 0, lineHeight: '14px', color: C.grey}}>
            <span title={text} aria-label={text} role='img' style={{position: 'absolute', right: 0, bottom: 3, display: 'inline-flex', padding: '1px 2px', cursor: 'help', opacity: 0.7}}>
                <svg width='12' height='12' viewBox='0 0 24 24' aria-hidden='true'>
                    <path d='M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 110-8 4 4 0 010 8z' fill='currentColor'/>
                </svg>
            </span>
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
