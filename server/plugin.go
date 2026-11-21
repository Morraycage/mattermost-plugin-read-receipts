package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

// PropTracked marks a post whose receipts are tracked. The webapp reads it
// to draw the status for the sender and the notice for recipients.
const PropTracked = "read_receipt"

// PropNotice tells the recipients' webapp to show the "read receipt on" mark.
const PropNotice = "read_receipt_notice"

type configuration struct {
	SenderUsernames     string
	SenderRoles         string
	TrackDirect         bool
	TrackGroup          bool
	TrackChannels       bool
	MaxRecipients       int
	RetentionDays       int
	ShowRecipientNotice bool
}

type Plugin struct {
	plugin.MattermostPlugin

	cfgLock   sync.RWMutex
	cfg       *configuration
	senderIDs map[string]bool
	roles     map[string]bool

	// conns counts live websocket connections per user (this node).
	connLock sync.Mutex
	conns    map[string]int

	// mu serialises every read-modify-write on the KV store (single node).
	mu sync.Mutex

	stop chan struct{}
	done chan struct{}
}

func (p *Plugin) config() *configuration {
	p.cfgLock.RLock()
	defer p.cfgLock.RUnlock()
	if p.cfg == nil {
		return &configuration{}
	}
	return p.cfg
}

func (p *Plugin) OnConfigurationChange() error {
	cfg := &configuration{}
	if err := p.API.LoadPluginConfiguration(cfg); err != nil {
		return err
	}
	if cfg.MaxRecipients <= 0 {
		cfg.MaxRecipients = 50
	}
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = 30
	}

	ids := map[string]bool{}
	for _, name := range splitList(cfg.SenderUsernames) {
		u, appErr := p.API.GetUserByUsername(strings.TrimPrefix(name, "@"))
		if appErr != nil {
			p.API.LogWarn("unknown sender username", "username", name)
			continue
		}
		ids[u.Id] = true
	}
	roles := map[string]bool{}
	for _, r := range splitList(cfg.SenderRoles) {
		roles[r] = true
	}

	p.cfgLock.Lock()
	p.cfg, p.senderIDs, p.roles = cfg, ids, roles
	p.cfgLock.Unlock()
	return nil
}

func (p *Plugin) OnActivate() error {
	p.conns = map[string]int{}
	p.stop = make(chan struct{})
	p.done = make(chan struct{})
	go p.sweepLoop()
	return nil
}

func (p *Plugin) OnDeactivate() error {
	if p.stop != nil {
		close(p.stop)
		<-p.done
	}
	return nil
}

func (p *Plugin) isSender(user *model.User) bool {
	p.cfgLock.RLock()
	defer p.cfgLock.RUnlock()
	if p.senderIDs[user.Id] {
		return true
	}
	for _, r := range strings.Fields(user.Roles) {
		if p.roles[r] {
			return true
		}
	}
	return false
}

// recipientsFor returns the users who should acknowledge a post, or nil when
// the post is not tracked.
func (p *Plugin) recipientsFor(post *model.Post) []string {
	if post.Type != "" || post.IsSystemMessage() {
		return nil
	}
	cfg := p.config()
	sender, appErr := p.API.GetUser(post.UserId)
	if appErr != nil || sender.IsBot || !p.isSender(sender) {
		return nil
	}
	ch, appErr := p.API.GetChannel(post.ChannelId)
	if appErr != nil {
		return nil
	}
	switch ch.Type {
	case model.ChannelTypeDirect:
		if !cfg.TrackDirect {
			return nil
		}
	case model.ChannelTypeGroup:
		if !cfg.TrackGroup {
			return nil
		}
	default:
		if !cfg.TrackChannels {
			return nil
		}
	}

	var ids []string
	for page := 0; ; page++ {
		members, appErr := p.API.GetChannelMembers(ch.Id, page, 200)
		if appErr != nil {
			return nil
		}
		for _, m := range members {
			if m.UserId != post.UserId {
				ids = append(ids, m.UserId)
			}
		}
		if len(members) < 200 || len(ids) > cfg.MaxRecipients {
			break
		}
	}
	if len(ids) == 0 || len(ids) > cfg.MaxRecipients {
		return nil
	}

	users, appErr := p.API.GetUsersByIds(ids)
	if appErr != nil {
		return nil
	}
	out := make([]string, 0, len(users))
	for _, u := range users {
		if !u.IsBot && u.DeleteAt == 0 {
			out = append(out, u.Id)
		}
	}
	return out
}

func (p *Plugin) MessageWillBePosted(_ *plugin.Context, post *model.Post) (*model.Post, string) {
	if p.recipientsFor(post) != nil {
		post.AddProp(PropTracked, true)
		if p.config().ShowRecipientNotice {
			post.AddProp(PropNotice, true)
		}
	}
	return post, ""
}

func (p *Plugin) MessageHasBeenPosted(_ *plugin.Context, post *model.Post) {
	if tracked, _ := post.GetProp(PropTracked).(bool); !tracked {
		return
	}
	recipients := p.recipientsFor(post)
	if recipients == nil {
		return
	}
	r := &Receipt{
		PostID:     post.Id,
		ChannelID:  post.ChannelId,
		SenderID:   post.UserId,
		CreateAt:   post.CreateAt,
		Recipients: map[string]*Ack{},
	}
	for _, id := range recipients {
		r.Recipients[id] = &Ack{}
	}

	// Recipients with a live client get the post right now. The connection
	// count is exact; the status covers connections opened before activation.
	now := model.GetMillis()
	p.connLock.Lock()
	for _, id := range recipients {
		if p.conns[id] > 0 {
			r.Recipients[id].DeliveredAt = now
		}
	}
	p.connLock.Unlock()
	statuses, _ := p.API.GetUserStatusesByIds(recipients)
	for _, s := range statuses {
		if s.Status != model.StatusOffline && !s.Manual {
			r.Recipients[s.UserId].DeliveredAt = now
		}
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.saveReceipt(r); err != nil {
		p.API.LogError("save receipt", "post_id", post.Id, "err", err.Error())
		return
	}
	for _, id := range recipients {
		if r.Recipients[id].SeenAt == 0 {
			p.addPending(id, post.Id)
		}
	}
	p.notify(r)
}

func (p *Plugin) MessageHasBeenDeleted(_ *plugin.Context, post *model.Post) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if r, _ := p.getReceipt(post.Id); r != nil {
		for id := range r.Recipients {
			p.removePending(id, post.Id)
		}
		_ = p.API.KVDelete(receiptKey(post.Id))
	}
}

// OnWebSocketConnect: a client of this user is now online, so every pending
// post addressed to them has reached a device.
func (p *Plugin) OnWebSocketConnect(_, userID string) {
	if userID == "" {
		return
	}
	p.connLock.Lock()
	p.conns[userID]++
	p.connLock.Unlock()
	p.markForUser(userID, func(r *Receipt, a *Ack, now int64) bool {
		if a.DeliveredAt == 0 {
			a.DeliveredAt = now
			return true
		}
		return false
	})
}

func (p *Plugin) OnWebSocketDisconnect(_, userID string) {
	p.connLock.Lock()
	if p.conns[userID] > 1 {
		p.conns[userID]--
	} else {
		delete(p.conns, userID)
	}
	p.connLock.Unlock()
}

// markViewed is called by the webapp when the user is looking at a channel
// with the window in focus.
func (p *Plugin) markViewed(userID, channelID string) {
	p.markForUser(userID, func(r *Receipt, a *Ack, now int64) bool {
		if r.ChannelID != channelID || a.SeenAt != 0 {
			return false
		}
		a.SeenAt = now
		if a.DeliveredAt == 0 {
			a.DeliveredAt = now
		}
		return true
	})
}

func (p *Plugin) markForUser(userID string, fn func(*Receipt, *Ack, int64) bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := model.GetMillis()
	for _, postID := range p.getPending(userID) {
		r, err := p.getReceipt(postID)
		if err != nil || r == nil {
			p.removePending(userID, postID)
			continue
		}
		a := r.Recipients[userID]
		if a == nil {
			p.removePending(userID, postID)
			continue
		}
		if !fn(r, a, now) {
			continue
		}
		if err := p.saveReceipt(r); err != nil {
			continue
		}
		if a.SeenAt != 0 {
			p.removePending(userID, postID)
		}
		p.notify(r)
	}
}

// sweepLoop covers clients without the webapp (mobile apps): the channel's
// last viewed time counts as seen. It also drops expired receipts.
func (p *Plugin) sweepLoop() {
	defer close(p.done)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-t.C:
			p.sweep()
		}
	}
}

func (p *Plugin) sweep() {
	retention := int64(p.config().RetentionDays) * 24 * 3600 * 1000
	for _, userID := range p.pendingUsers() {
		p.mu.Lock()
		now := model.GetMillis()
		viewed := map[string]int64{}
		for _, postID := range p.getPending(userID) {
			r, _ := p.getReceipt(postID)
			if r == nil || r.Recipients[userID] == nil || now-r.CreateAt > retention {
				p.removePending(userID, postID)
				continue
			}
			last, ok := viewed[r.ChannelID]
			if !ok {
				if m, appErr := p.API.GetChannelMember(r.ChannelID, userID); appErr == nil {
					last = m.LastViewedAt
				}
				viewed[r.ChannelID] = last
			}
			if last < r.CreateAt {
				continue
			}
			a := r.Recipients[userID]
			a.SeenAt = last
			if a.DeliveredAt == 0 || a.DeliveredAt > last {
				a.DeliveredAt = last
			}
			if p.saveReceipt(r) == nil {
				p.removePending(userID, postID)
				p.notify(r)
			}
		}
		p.mu.Unlock()
	}
}

func (p *Plugin) notify(r *Receipt) {
	// The RPC layer only carries plain types: send the view as JSON text.
	b, err := json.Marshal(r.view(p))
	if err != nil {
		return
	}
	p.API.PublishWebSocketEvent("receipt", map[string]any{"receipt": string(b)},
		&model.WebsocketBroadcast{UserId: r.SenderID})
}

func splitList(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}
