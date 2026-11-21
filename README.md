# Read Receipts for Mattermost

Sent, delivered and seen status on messages from chosen senders (HR, IT, management), with the detail per recipient.

## Statuses

| Status | Meaning |
|---|---|
| Sent | The message is stored. |
| Delivered | The recipient had a Mattermost client connected (web, desktop or mobile) after the message was sent. |
| Seen | The recipient opened the conversation with the window in focus after the message was sent. Mobile apps count through the channel's last viewed time, checked every 30 s. |

None of these proves the text was read.

The sender sees the ticks under their message. A click on them lists every recipient with the time. Updates arrive live over the websocket. Recipients see a small "Read receipt on" mark on tracked messages (setting `Tell recipients`, on by default).

## Settings (System Console > Plugins > Read Receipts)

- `Senders (usernames)`, `Senders (roles)`: whose messages are tracked. Nobody by default.
- `Direct messages` (on), `Group messages` (on), `Public and private channels` (off).
- `Maximum recipients` (50): bigger conversations are not tracked.
- `Retention (days)` (30): receipts expire after this.

## How it works

- `MessageWillBePosted` marks tracked posts with the `read_receipt` prop, so no request is needed to know a post is tracked.
- `MessageHasBeenPosted` stores the receipt in the plugin KV store (`r_<post id>`, expiring) and a short pending list per recipient (`p_<user id>`).
- Delivered: `OnWebSocketConnect` for that recipient, or a live connection at posting time.
- Seen: the webapp posts `/api/v1/viewed` when the user is on a channel with the window focused (channel switch, focus, new tracked post). A 30 s sweep covers clients without the webapp by comparing the channel's `LastViewedAt`.
- `GET /api/v1/receipts?post_ids=` only returns receipts of the caller's own posts.

Single node only: state changes are serialised by an in-process lock.

## Install

Download the bundle from the [releases](https://github.com/Morraycage/mattermost-plugin-read-receipts/releases), then upload it in System Console > Plugins > Plugin Management (plugin uploads must be enabled), or with mmctl:

```
mmctl plugin add com.github.morraycage.read-receipts-<version>.tar.gz
mmctl plugin enable com.github.morraycage.read-receipts
```

Then list the senders in the plugin settings. Mattermost 10.0 or later, Linux amd64 or arm64.

## Build

```
make            # dist/com.github.morraycage.read-receipts-<version>.tar.gz
```

Needs Go 1.22+ and Node 20+.

## Test

`test/compose.yml` starts a throwaway Mattermost on http://localhost:8065. `test/e2e.mjs` creates test users, installs the bundle and checks every status:

```
docker compose -p rrdev -f test/compose.yml up -d
node test/e2e.mjs dist/com.github.morraycage.read-receipts-<version>.tar.gz
docker compose -p rrdev -f test/compose.yml down -v
```

## License

MIT
