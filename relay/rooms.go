package main

import (
	"encoding/json"
	"sync"
)

// ghRoom is one GitHub account. Each logged-in Mac is a separate host.
type ghRoom struct {
	mu      sync.Mutex
	macs    map[string]*client
	devices map[string]*client
}

func newGHRoom() *ghRoom {
	return &ghRoom{macs: map[string]*client{}, devices: map[string]*client{}}
}

func (r *ghRoom) registerMac(c *client) {
	r.mu.Lock()
	old := r.macs[c.macID]
	r.macs[c.macID] = c
	r.mu.Unlock()
	if old != nil && old != c {
		old.trySend(mustJSON(map[string]any{"type": "relay.replaced"}))
		old.shutdown()
	}
	r.pushMacs()
}

func (r *ghRoom) registerDevice(c *client) bool {
	r.mu.Lock()
	old := r.devices[c.id]
	if old == nil && len(r.devices) >= maxDevices {
		r.mu.Unlock()
		return false
	}
	r.devices[c.id] = c
	r.mu.Unlock()
	if old != nil && old != c {
		old.shutdown()
	}
	r.pushMacs()
	return true
}

func (r *ghRoom) unregister(c *client) {
	r.mu.Lock()
	changed := false
	if c.role == "host" {
		if current := r.macs[c.macID]; current == c {
			delete(r.macs, c.macID)
			changed = true
			note := mustJSON(map[string]any{"type": "mac.offline", "id": c.macID})
			for _, device := range r.devices {
				if device.selectedMac == c.macID {
					device.selectedMac = ""
					device.trySend(note)
				}
			}
		}
	} else if current := r.devices[c.id]; current == c {
		delete(r.devices, c.id)
	}
	r.mu.Unlock()
	if changed {
		r.pushMacs()
	}
}

func (r *ghRoom) handleDevice(c *client, msg []byte) bool {
	var body struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(msg, &body) != nil {
		return false
	}
	switch body.Type {
	case "mac.select":
		r.mu.Lock()
		host := r.macs[body.ID]
		if host == nil {
			r.mu.Unlock()
			c.trySend(mustJSON(map[string]any{"type": "error", "message": "这台 Mac 不在线"}))
			return true
		}
		c.selectedMac = body.ID
		name := host.name
		state := append([]byte(nil), host.lastState...)
		herdr := append([]byte(nil), host.lastHerdr...)
		sessions := append([]byte(nil), host.lastSessions...)
		r.mu.Unlock()
		c.trySend(mustJSON(map[string]any{"type": "mac.selected", "id": body.ID, "name": name}))
		if len(state) > 0 {
			c.trySend(state)
		}
		if len(herdr) > 0 {
			c.trySend(herdr)
		}
		if len(sessions) > 0 {
			c.trySend(sessions)
		}
		return true
	case "mac.leave":
		r.mu.Lock()
		c.selectedMac = ""
		r.mu.Unlock()
		c.trySend(mustJSON(map[string]any{"type": "mac.left"}))
		return true
	default:
		return false
	}
}

func (r *ghRoom) broadcastFrom(host *client, msg []byte) {
	cacheHost(host, msg)
	if looksLikeSessions(msg) {
		r.pushMacs()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, device := range r.devices {
		if device.selectedMac == host.macID {
			device.trySend(append([]byte(nil), msg...))
		}
	}
}

func (r *ghRoom) sendToSelected(device *client, msg []byte) {
	r.mu.Lock()
	host := r.macs[device.selectedMac]
	r.mu.Unlock()
	if host != nil {
		host.trySend(msg)
	}
}

func (r *ghRoom) pushMacs() {
	items := r.snapshot()
	note := mustJSON(map[string]any{"type": "macs", "items": items})
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, device := range r.devices {
		device.trySend(append([]byte(nil), note...))
	}
}

func (r *ghRoom) snapshot() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := make([]map[string]any, 0, len(r.macs))
	for id, host := range r.macs {
		items = append(items, map[string]any{
			"id":         id,
			"name":       host.name,
			"online":     true,
			"agentCount": host.agentCount,
		})
	}
	return items
}

func cacheHost(host *client, msg []byte) {
	var body struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(msg, &body) != nil {
		return
	}
	switch body.Type {
	case "sessions":
		host.lastSessions = append([]byte(nil), msg...)
		host.agentCount = countSessions(msg)
	case "herdr":
		host.lastHerdr = append([]byte(nil), msg...)
	case "host.state":
		host.lastState = append([]byte(nil), msg...)
	}
}

func looksLikeSessions(msg []byte) bool {
	var body struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(msg, &body) == nil && body.Type == "sessions"
}

func countSessions(msg []byte) int {
	var body struct {
		Items []json.RawMessage `json:"items"`
	}
	if json.Unmarshal(msg, &body) != nil {
		return 0
	}
	return len(body.Items)
}
