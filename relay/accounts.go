package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type deviceRec struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Secret  string `json:"secret"`
	Created int64  `json:"created"`
	Revoked bool   `json:"revoked"`
}

type accountRec struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	HostSecret string      `json:"hostSecret"`
	Devices    []deviceRec `json:"devices"`
}

type accountBook struct {
	path string
	mu   sync.Mutex
	rec  accountRec
}

func loadBook(path, hostSecret string) (*accountBook, error) {
	book := &accountBook{
		path: path,
		rec: accountRec{
			ID:         "local",
			Name:       "herdr+",
			HostSecret: hostSecret,
			Devices:    []deviceRec{},
		},
	}
	if path == "" {
		return book, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return book, book.saveLocked()
		}
		return book, err
	}
	var rec accountRec
	if err := json.Unmarshal(raw, &rec); err != nil {
		return book, err
	}
	if rec.HostSecret == "" {
		rec.HostSecret = hostSecret
	}
	if rec.ID == "" {
		rec.ID = "local"
	}
	if rec.Name == "" {
		rec.Name = "herdr+"
	}
	book.rec = rec
	return book, nil
}

func (b *accountBook) saveLocked() error {
	if b.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(b.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(b.rec, "", "  ")
	if err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, b.path)
}

func (b *accountBook) name() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rec.Name
}

func (b *accountBook) identify(role, token string) (id, name string, code int, msg string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	token = strings.TrimSpace(token)
	if role == "host" {
		if secretEq(b.rec.HostSecret, token) {
			return "host", b.rec.Name, 0, ""
		}
		return "", "", 401, "主机钥匙无效"
	}
	if role != "device" {
		return "", "", 400, "role 必须是 host 或 device"
	}
	if secretEq(b.rec.HostSecret, token) {
		return "", "", 403, "这是主机钥匙，不能登录手机。请用电脑上的配对码。"
	}
	for _, device := range b.rec.Devices {
		if device.Revoked {
			continue
		}
		if secretEq(device.Secret, token) {
			return device.ID, device.Name, 0, ""
		}
	}
	return "", "", 401, "配对码无效"
}

func (b *accountBook) exchange(token, name string) (string, string, int, string) {
	if _, _, code, _ := b.identify("device", token); code == 0 {
		return strings.TrimSpace(token), b.name(), 0, ""
	}
	if _, _, code, _ := b.identify("host", token); code != 0 {
		return "", "", 401, "配对码无效"
	}
	name = sanitize(name, 40)
	if name == "" {
		name = "手机"
	}
	b.mu.Lock()
	for _, device := range b.rec.Devices {
		if !device.Revoked && device.Name == name && device.Secret != "" {
			secret := device.Secret
			account := b.rec.Name
			b.mu.Unlock()
			return secret, account, 0, ""
		}
	}
	b.mu.Unlock()
	device, err := b.issue(name)
	if err != nil {
		return "", "", 429, err.Error()
	}
	return device.Secret, b.name(), 0, ""
}

func (b *accountBook) issue(name string) (deviceRec, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	active := 0
	for _, device := range b.rec.Devices {
		if !device.Revoked {
			active++
		}
	}
	if active >= maxDevices {
		return deviceRec{}, errBusy("配对设备已满")
	}
	name = sanitize(name, 40)
	if name == "" {
		name = "手机"
	}
	device := deviceRec{
		ID:      "d" + randomHex(4),
		Name:    name,
		Secret:  randomHex(24),
		Created: time.Now().Unix(),
	}
	b.rec.Devices = append(b.rec.Devices, device)
	return device, b.saveLocked()
}

func (b *accountBook) ensureOne(name string) (deviceRec, bool, error) {
	b.mu.Lock()
	for _, device := range b.rec.Devices {
		if !device.Revoked {
			b.mu.Unlock()
			return deviceRec{}, false, nil
		}
	}
	b.mu.Unlock()
	device, err := b.issue(name)
	return device, err == nil, err
}

func (b *accountBook) revoke(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := range b.rec.Devices {
		if b.rec.Devices[i].ID == id && !b.rec.Devices[i].Revoked {
			b.rec.Devices[i].Revoked = true
			b.rec.Devices[i].Secret = ""
			_ = b.saveLocked()
			return true
		}
	}
	return false
}

func (b *accountBook) rename(name string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	name = sanitize(name, 40)
	if name == "" {
		return
	}
	b.rec.Name = name
	_ = b.saveLocked()
}

func (b *accountBook) activeSecrets() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]map[string]any, 0)
	for _, device := range b.rec.Devices {
		if device.Revoked || device.Secret == "" {
			continue
		}
		out = append(out, map[string]any{
			"id":      device.ID,
			"name":    device.Name,
			"secret":  device.Secret,
			"created": device.Created,
		})
	}
	return out
}

func (b *accountBook) publicDevices(online func(string) bool) []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]map[string]any, 0)
	for _, device := range b.rec.Devices {
		if device.Revoked {
			continue
		}
		out = append(out, map[string]any{
			"id":     device.ID,
			"name":   device.Name,
			"online": online(device.ID),
		})
	}
	return out
}

func secretEq(want, got string) bool {
	if len(want) == 0 || len(want) != len(got) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

type statusError struct{ msg string }

func (e statusError) Error() string { return e.msg }

func errBusy(msg string) error { return statusError{msg: msg} }
