package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("Mattermost-User-Id")
	if userID == "" {
		http.Error(w, "not authenticated", http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/receipts":
		p.handleReceipts(w, r, userID)
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/viewed":
		p.handleViewed(w, r, userID)
	default:
		http.NotFound(w, r)
	}
}

// GET /api/v1/receipts?post_ids=a,b,c: receipts of the caller's own posts only.
func (p *Plugin) handleReceipts(w http.ResponseWriter, r *http.Request, userID string) {
	ids := strings.Split(r.URL.Query().Get("post_ids"), ",")
	if len(ids) > 200 {
		ids = ids[:200]
	}
	out := map[string]ReceiptView{}
	for _, id := range ids {
		if !model.IsValidId(id) {
			continue
		}
		rc, err := p.getReceipt(id)
		if err != nil || rc == nil || rc.SenderID != userID {
			continue
		}
		out[id] = rc.view(p)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// POST /api/v1/viewed {"channel_id": "..."}: the caller is looking at the
// channel with the window in focus.
func (p *Plugin) handleViewed(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		ChannelID string `json:"channel_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || !model.IsValidId(body.ChannelID) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if _, appErr := p.API.GetChannelMember(body.ChannelID, userID); appErr != nil {
		http.Error(w, "not a member", http.StatusForbidden)
		return
	}
	p.markViewed(userID, body.ChannelID)
	w.WriteHeader(http.StatusNoContent)
}
