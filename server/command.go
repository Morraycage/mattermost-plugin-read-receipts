package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const commandTrigger = "receipts"

// The mobile apps do not run webapp plugins, so the ticks never show there.
// /receipts gives the same information as an ephemeral reply, which works on
// every client.
func (p *Plugin) registerCommand() error {
	return p.API.RegisterCommand(&model.Command{
		Trigger:          commandTrigger,
		DisplayName:      "Read Receipts",
		Description:      "Show the read receipts of your last messages in this conversation.",
		AutoComplete:     true,
		AutoCompleteDesc: "Show the read receipts of your last messages in this conversation",
		AutoCompleteHint: "[number of messages, default 5]",
	})
}

func (p *Plugin) ExecuteCommand(_ *plugin.Context, args *model.CommandArgs) (*model.CommandResponse, *model.AppError) {
	count := 5
	if f := strings.Fields(args.Command); len(f) > 1 {
		n, err := strconv.Atoi(f[1])
		if err != nil || n < 1 {
			return ephemeral("Usage: `/receipts [number of messages]`, for example `/receipts 10`."), nil
		}
		count = min(n, 20)
	}

	loc := time.UTC
	if u, appErr := p.API.GetUser(args.UserId); appErr == nil {
		if l, err := time.LoadLocation(u.GetPreferredTimezone()); err == nil {
			loc = l
		}
	}

	list, appErr := p.API.GetPostsForChannel(args.ChannelId, 0, 200)
	if appErr != nil {
		return nil, appErr
	}
	var blocks []string
	for _, id := range list.Order {
		post := list.Posts[id]
		if post == nil || post.UserId != args.UserId {
			continue
		}
		if tracked, _ := post.GetProp(PropTracked).(bool); !tracked {
			continue
		}
		r, err := p.getReceipt(id)
		if err != nil || r == nil {
			continue
		}
		blocks = append(blocks, formatReceipt(post, r.view(p), loc))
		if len(blocks) == count {
			break
		}
	}
	if len(blocks) == 0 {
		return ephemeral("None of your recent messages in this conversation has a read receipt."), nil
	}
	// Oldest first, like the conversation.
	for i, j := 0, len(blocks)-1; i < j; i, j = i+1, j-1 {
		blocks[i], blocks[j] = blocks[j], blocks[i]
	}
	return ephemeral(strings.Join(blocks, "\n\n")), nil
}

func ephemeral(text string) *model.CommandResponse {
	return &model.CommandResponse{ResponseType: model.CommandResponseTypeEphemeral, Text: text}
}

func formatReceipt(post *model.Post, v ReceiptView, loc *time.Location) string {
	var b strings.Builder
	fmt.Fprintf(&b, "**%s** · %s\n", excerpt(post.Message), stamp(post.CreateAt, loc))

	var seen, delivered, waiting []string
	for _, r := range v.Recipients {
		name := r.Name
		if name == "" {
			name = "@" + r.Username
		}
		switch {
		case r.SeenAt != 0:
			seen = append(seen, name+" "+stamp(r.SeenAt, loc))
		case r.DeliveredAt != 0:
			delivered = append(delivered, name)
		default:
			waiting = append(waiting, name)
		}
	}
	var lines []string
	if v.Total > 1 {
		lines = append(lines, fmt.Sprintf("Seen by %d of %d", v.Seen, v.Total))
	}
	if len(seen) > 0 {
		lines = append(lines, "✓✓ Seen: "+strings.Join(seen, ", "))
	}
	if len(delivered) > 0 {
		lines = append(lines, "✓✓ Delivered: "+strings.Join(delivered, ", "))
	}
	if len(waiting) > 0 {
		lines = append(lines, "✓ Sent, not delivered: "+strings.Join(waiting, ", "))
	}
	b.WriteString(strings.Join(lines, "\n"))
	return b.String()
}

func excerpt(msg string) string {
	msg = strings.Join(strings.Fields(msg), " ")
	if msg == "" {
		return "(attachment)"
	}
	// Keep markdown from the original message out of the bold title.
	msg = strings.NewReplacer("*", "", "_", "", "`", "", "~", "").Replace(msg)
	if utf8.RuneCountInString(msg) > 60 {
		msg = string([]rune(msg)[:60]) + "…"
	}
	return msg
}

func stamp(ms int64, loc *time.Location) string {
	t := time.UnixMilli(ms).In(loc)
	now := time.Now().In(loc)
	if t.YearDay() == now.YearDay() && t.Year() == now.Year() {
		return t.Format("15:04")
	}
	return t.Format("Jan 2 15:04")
}
