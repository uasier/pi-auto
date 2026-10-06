package main

import (
	"encoding/json"
	"sort"
	"sync"
)

// 房间锁同时保护连接归属、主机缓存和消息入队顺序。
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
	for _, device := range r.devices {
		if device.selectedMac == c.macID {
			r.peerLocked(c, device, "join")
			// 同一台 Mac 的新连接没有旧连接的终端订阅，要求设备重新同步。
			r.selectedLocked(device, c)
		}
	}
	r.pushMacsLocked()
	r.mu.Unlock()
	if old != nil && old != c {
		old.shutdown()
	}
}

func (r *ghRoom) registerDevice(c *client) bool {
	r.mu.Lock()
	old := r.devices[c.id]
	if old == nil && len(r.devices) >= maxDevices {
		r.mu.Unlock()
		return false
	}
	if old != nil {
		oldMac := r.macs[old.selectedMac]
		old.selectedMac = ""
		r.peerLocked(oldMac, old, "leave")
	}
	r.devices[c.id] = c
	r.mu.Unlock()
	if old != nil && old != c {
		old.shutdown()
	}
	return true
}

func (r *ghRoom) unregister(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c.role == "host" {
		if r.macs[c.macID] != c {
			return
		}
		delete(r.macs, c.macID)
		for _, device := range r.devices {
			if device.selectedMac == c.macID {
				device.selectedMac = ""
				device.trySend(mustJSON(map[string]any{"type": "mac.offline", "id": c.macID}))
			}
		}
		r.pushMacsLocked()
	} else if r.devices[c.id] == c {
		delete(r.devices, c.id)
		r.peerLocked(r.macs[c.selectedMac], c, "leave")
	}
}

func (r *ghRoom) peerLocked(host, device *client, event string) {
	if host == nil {
		return
	}
	host.trySend(mustJSON(map[string]any{
		"type": "relay.peer", "event": event, "role": "device",
		"id": device.id, "name": device.name, "devices": r.deviceCountLocked(host.macID),
	}))
}

func (r *ghRoom) deviceCountLocked(macID string) int {
	count := 0
	for _, device := range r.devices {
		if device.selectedMac == macID {
			count++
		}
	}
	return count
}

func (r *ghRoom) selectedLocked(device, host *client) {
	device.trySend(mustJSON(map[string]any{"type": "mac.selected", "id": host.macID, "name": host.name}))
	for _, msg := range [][]byte{host.lastState, host.lastHerdr, host.lastSessions} {
		if len(msg) > 0 {
			device.trySend(msg)
		}
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
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.devices[c.id] != c {
		return true
	}
	switch body.Type {
	case "mac.select":
		host := r.macs[body.ID]
		if host == nil {
			c.trySend(mustJSON(map[string]any{"type": "error", "message": "这台 Mac 不在线"}))
			return true
		}
		if c.selectedMac != body.ID {
			old := r.macs[c.selectedMac]
			c.selectedMac = body.ID
			r.peerLocked(old, c, "leave")
			r.peerLocked(host, c, "join")
		}
		r.selectedLocked(c, host)
		return true
	case "mac.leave":
		old := r.macs[c.selectedMac]
		c.selectedMac = ""
		r.peerLocked(old, c, "leave")
		c.trySend(mustJSON(map[string]any{"type": "mac.left"}))
		return true
	case "ping":
		c.trySend(mustJSON(map[string]any{"type": "pong"}))
		return true
	default:
		return false
	}
}

func (r *ghRoom) broadcastFrom(host *client, msg []byte) {
	var meta struct {
		Type string `json:"type"`
		To   string `json:"to"`
	}
	if json.Unmarshal(msg, &meta) != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.macs[host.macID] != host {
		return
	}
	if meta.To != "" {
		if device := r.devices[meta.To]; device != nil && device.selectedMac == host.macID {
			device.trySend(msg)
		}
		return
	}
	cacheHost(host, msg, meta.Type)
	if meta.Type == "sessions" {
		r.pushMacsLocked()
	}
	for _, device := range r.devices {
		if device.selectedMac == host.macID {
			device.trySend(msg)
		}
	}
}

func (r *ghRoom) sendToSelected(device *client, msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.devices[device.id] != device {
		return
	}
	if host := r.macs[device.selectedMac]; host != nil {
		host.trySend(msg)
	} else {
		device.trySend(mustJSON(map[string]any{"type": "error", "message": "请先选择一台在线的 Mac"}))
	}
}

func (r *ghRoom) pushMacsLocked() {
	note := mustJSON(map[string]any{"type": "macs", "items": r.snapshotLocked()})
	for _, device := range r.devices {
		device.trySend(note)
	}
}

func (r *ghRoom) snapshot() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshotLocked()
}

func (r *ghRoom) snapshotLocked() []map[string]any {
	items := make([]map[string]any, 0, len(r.macs))
	for id, host := range r.macs {
		items = append(items, map[string]any{
			"id": id, "name": host.name, "online": true, "agentCount": host.agentCount,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i]["id"].(string) < items[j]["id"].(string) })
	return items
}

func (r *ghRoom) welcome(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.trySend(mustJSON(map[string]any{
		"type": "relay.welcome", "role": c.role, "self": c.id,
		"accountName": c.login, "avatar": c.avatar, "login": c.login,
		"macs": r.snapshotLocked(), "devices": r.deviceCountLocked(c.macID),
	}))
	if c.role == "device" {
		c.trySend(mustJSON(map[string]any{"type": "macs", "items": r.snapshotLocked()}))
	}
}

// 缓存只在房间锁内更新，保证选择 Mac 时的快照与后续增量顺序一致。
func cacheHost(host *client, msg []byte, kind string) {
	switch kind {
	case "sessions":
		host.lastSessions = append([]byte(nil), msg...)
		host.agentCount = countSessions(msg)
	case "herdr":
		host.lastHerdr = append([]byte(nil), msg...)
	case "host.state":
		host.lastState = append([]byte(nil), msg...)
	}
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
