package main

import (
	"encoding/json"
	"sort"

	"github.com/mattermost/mattermost/server/public/model"
)

// Receipt is stored per post under "r_<post id>".
type Receipt struct {
	PostID     string          `json:"post_id"`
	ChannelID  string          `json:"channel_id"`
	SenderID   string          `json:"sender_id"`
	CreateAt   int64           `json:"create_at"`
	Recipients map[string]*Ack `json:"recipients"`
}

type Ack struct {
	DeliveredAt int64 `json:"delivered_at,omitempty"`
	SeenAt      int64 `json:"seen_at,omitempty"`
}

// Pending posts per recipient live under "p_<user id>" and the set of users
// with pending posts under "pending_users". Both are small: entries leave as
// soon as the recipient has seen the post or the receipt expires.
const pendingUsersKey = "pending_users"

func receiptKey(postID string) string { return "r_" + postID }
func pendingKey(userID string) string { return "p_" + userID }

func (p *Plugin) getReceipt(postID string) (*Receipt, error) {
	b, appErr := p.API.KVGet(receiptKey(postID))
	if appErr != nil {
		return nil, appErr
	}
	if b == nil {
		return nil, nil
	}
	r := &Receipt{}
	if err := json.Unmarshal(b, r); err != nil {
		return nil, err
	}
	return r, nil
}

func (p *Plugin) saveReceipt(r *Receipt) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	ttl := int64(p.config().RetentionDays) * 24 * 3600
	if _, appErr := p.API.KVSetWithOptions(receiptKey(r.PostID), b, model.PluginKVSetOptions{ExpireInSeconds: ttl}); appErr != nil {
		return appErr
	}
	return nil
}

func (p *Plugin) getList(key string) []string {
	b, appErr := p.API.KVGet(key)
	if appErr != nil || b == nil {
		return nil
	}
	var out []string
	_ = json.Unmarshal(b, &out)
	return out
}

func (p *Plugin) setList(key string, list []string) {
	if len(list) == 0 {
		_ = p.API.KVDelete(key)
		return
	}
	b, _ := json.Marshal(list)
	_, _ = p.API.KVSetWithOptions(key, b, model.PluginKVSetOptions{})
}

func (p *Plugin) getPending(userID string) []string { return p.getList(pendingKey(userID)) }

func (p *Plugin) pendingUsers() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.getList(pendingUsersKey)
}

func (p *Plugin) addPending(userID, postID string) {
	list := p.getPending(userID)
	if !contains(list, postID) {
		p.setList(pendingKey(userID), append(list, postID))
	}
	users := p.getList(pendingUsersKey)
	if !contains(users, userID) {
		p.setList(pendingUsersKey, append(users, userID))
	}
}

func (p *Plugin) removePending(userID, postID string) {
	list := remove(p.getPending(userID), postID)
	p.setList(pendingKey(userID), list)
	if len(list) == 0 {
		p.setList(pendingUsersKey, remove(p.getList(pendingUsersKey), userID))
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func remove(list []string, v string) []string {
	out := list[:0]
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// ReceiptView is what the sender's webapp gets.
type ReceiptView struct {
	PostID     string          `json:"post_id"`
	Total      int             `json:"total"`
	Delivered  int             `json:"delivered"`
	Seen       int             `json:"seen"`
	Recipients []RecipientView `json:"recipients"`
}

type RecipientView struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	Name        string `json:"name"`
	DeliveredAt int64  `json:"delivered_at,omitempty"`
	SeenAt      int64  `json:"seen_at,omitempty"`
}

func (r *Receipt) view(p *Plugin) ReceiptView {
	v := ReceiptView{PostID: r.PostID, Total: len(r.Recipients)}
	ids := make([]string, 0, len(r.Recipients))
	for id := range r.Recipients {
		ids = append(ids, id)
	}
	names := map[string]*model.User{}
	if users, appErr := p.usersByIds(ids); appErr == nil {
		for _, u := range users {
			names[u.Id] = u
		}
	}
	for _, id := range ids {
		a := r.Recipients[id]
		rv := RecipientView{UserID: id, DeliveredAt: a.DeliveredAt, SeenAt: a.SeenAt}
		if u := names[id]; u != nil {
			rv.Username = u.Username
			rv.Name = u.GetFullName()
		}
		if a.DeliveredAt != 0 {
			v.Delivered++
		}
		if a.SeenAt != 0 {
			v.Seen++
		}
		v.Recipients = append(v.Recipients, rv)
	}
	sort.Slice(v.Recipients, func(i, j int) bool {
		a, b := v.Recipients[i], v.Recipients[j]
		if (a.SeenAt == 0) != (b.SeenAt == 0) {
			return a.SeenAt != 0
		}
		return a.Username < b.Username
	})
	return v
}

// usersByIds wraps GetUsersByIds, which servers before 9.x do not have: the
// RPC then fails silently with an empty list, so fall back to one call per id.
func (p *Plugin) usersByIds(ids []string) ([]*model.User, *model.AppError) {
	if len(ids) == 0 {
		return nil, nil
	}
	if users, appErr := p.API.GetUsersByIds(ids); appErr == nil && len(users) > 0 {
		return users, nil
	}
	var out []*model.User
	for _, id := range ids {
		u, appErr := p.API.GetUser(id)
		if appErr != nil {
			if appErr.StatusCode == 404 {
				continue
			}
			return nil, appErr
		}
		out = append(out, u)
	}
	return out, nil
}
