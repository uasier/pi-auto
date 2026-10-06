// herdr-relay is a room forwarder. It does not speak to Herdr and does not log payloads.
//
// Devices join with a GitHub session. The host secret only identifies the legacy room.
// A device code cannot open a host session, and the host secret cannot log in a phone.
package main

import (
	"crypto/tls"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed static
var staticEmbed embed.FS

const (
	maxMessage  = 12 << 20
	maxDevices  = 8
	writeWait   = 10 * time.Second
	pongWait    = 90 * time.Second
	pingEvery   = 25 * time.Second
	deviceBurst = 48
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8787", "listen address")
	certFile := flag.String("cert", "", "TLS certificate PEM")
	keyFile := flag.String("key", "", "TLS private key PEM")
	tokenFlag := flag.String("token", "", "room token (prefer -token-file)")
	tokenFile := flag.String("token-file", "", "file containing the host secret")
	accountsPath := flag.String("accounts", "/var/lib/herdr-relay/accounts.json", "account store")
	publicURL := flag.String("public-url", "https://154.36.168.192:8443", "public origin used for GitHub callback")
	flag.Parse()

	token := strings.TrimSpace(*tokenFlag)
	if *tokenFile != "" {
		raw, err := os.ReadFile(*tokenFile)
		if err != nil {
			log.Fatalf("read token: %v", err)
		}
		token = strings.TrimSpace(string(raw))
	}
	if token == "" {
		token = strings.TrimSpace(os.Getenv("RELAY_TOKEN"))
	}
	if len(token) < 16 {
		log.Fatal("host secret must be at least 16 characters; set -token-file or RELAY_TOKEN")
	}
	book, err := loadBook(*accountsPath, token)
	if err != nil {
		log.Fatalf("accounts: %v", err)
	}
	hub := newHub(book)
	hub.github = loadGitHub(*publicURL)
	hub.sessions = newSessionStore("/var/lib/herdr-relay/sessions.json")
	server := &http.Server{
		Addr:              *listen,
		Handler:           hub.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
	log.Printf("herdr-relay listening on %s tls=%v", *listen, *certFile != "")
	if *certFile != "" || *keyFile != "" {
		if *certFile == "" || *keyFile == "" {
			log.Fatal("cert and key must be set together")
		}
		err = server.ListenAndServeTLS(*certFile, *keyFile)
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type hub struct {
	book     *accountBook
	sessions *sessionStore
	github   githubApp
	logins   *gitHubLogin
	mu       sync.Mutex
	host     *client
	devices  map[string]*client
	rooms    map[string]*ghRoom
}

func newHub(book *accountBook) *hub {
	return &hub{
		book:     book,
		sessions: newSessionStore(""),
		logins:   newGitHubLogin(),
		devices:  map[string]*client{},
		rooms:    map[string]*ghRoom{},
	}
}

func (h *hub) handler() http.Handler {
	static, err := fs.Sub(staticEmbed, "static")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(static))
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		setHeaders(w)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
	mux.HandleFunc("/v1/login", h.login)
	mux.HandleFunc("/v1/auth/config", h.authConfig)
	mux.HandleFunc("/v1/auth/github/device", h.startGitHubDevice)
	mux.HandleFunc("/v1/auth/github/poll", h.pollGitHubDevice)
	mux.HandleFunc("/v1/auth/logout", h.logout)
	mux.HandleFunc("/auth/github", h.startGitHubWeb)
	mux.HandleFunc("/auth/github/callback", h.finishGitHubWeb)
	mux.HandleFunc("/v1/ws", h.serveWS)
	mux.Handle("/", files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setHeaders(w)
		mux.ServeHTTP(w, r)
	})
}

func setHeaders(w http.ResponseWriter) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

func (h *hub) login(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	token := r.URL.Query().Get("token")
	if token == "" && r.Body != nil {
		var body struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		token = body.Token
	}
	role := r.URL.Query().Get("role")
	if role == "" {
		role = "device"
	}
	_, name, code, msg := h.book.identify(role, token)
	if code != 0 {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": msg})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "role": role, "accountName": name})
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	if sessionID := r.URL.Query().Get("session"); sessionID != "" {
		h.serveGitHub(w, r, sessionID)
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		if auth, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
			token = strings.TrimSpace(auth)
		}
	}
	role := r.URL.Query().Get("role")
	id, name, code, msg := h.book.identify(role, token)
	if code != 0 {
		http.Error(w, msg, code)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessage)
	if queryName := sanitize(r.URL.Query().Get("name"), 40); role == "host" && queryName != "" {
		name = queryName
	}
	c := newClient(conn, role, name)
	c.id = id
	if role == "device" && !h.registerDevice(c) {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "too many devices"), time.Now().Add(writeWait))
		_ = conn.Close()
		return
	}
	if role == "host" {
		h.registerHost(c)
	}
	go c.writeLoop()
	h.welcome(c)
	if role == "host" {
		h.sendAccount(c)
	}
	c.readLoop(h)
}

func sanitize(raw string, n int) string {
	raw = strings.TrimSpace(raw)
	var b strings.Builder
	for _, r := range raw {
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
		if b.Len() >= n {
			break
		}
	}
	return b.String()
}

type client struct {
	conn         *websocket.Conn
	role         string
	id           string
	name         string
	login        string
	avatar       string
	room         *ghRoom
	macID        string
	selectedMac  string
	agentCount   int
	lastSessions []byte
	lastHerdr    []byte
	lastState    []byte
	send         chan []byte
	done         chan struct{}
	once         sync.Once
	mu           sync.Mutex
	tokens       int
	stamp        time.Time
}

var clientSeq uint64
var clientSeqMu sync.Mutex

func newClient(conn *websocket.Conn, role, name string) *client {
	clientSeqMu.Lock()
	clientSeq++
	id := role + "-" + itoa(clientSeq)
	clientSeqMu.Unlock()
	buf := 32
	if role == "host" {
		buf = 128
	}
	return &client{
		conn:   conn,
		role:   role,
		id:     id,
		name:   name,
		send:   make(chan []byte, buf),
		done:   make(chan struct{}),
		tokens: deviceBurst,
		stamp:  time.Now(),
	}
}

func (c *client) allow() bool {
	if c.role == "host" {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	elapsed := now.Sub(c.stamp).Seconds()
	c.stamp = now
	c.tokens += int(elapsed * 30)
	if c.tokens > deviceBurst {
		c.tokens = deviceBurst
	}
	if c.tokens <= 0 {
		return false
	}
	c.tokens--
	return true
}

func (c *client) trySend(msg []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case <-c.done:
	case c.send <- msg:
	default:
		// ANSI 增量和控制消息不能静默丢弃，断线后由客户端重新同步。
		c.shutdown()
	}
}

func (c *client) shutdown() {
	c.once.Do(func() {
		close(c.done)
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	defer c.shutdown()
	for {
		select {
		case <-c.done:
			return
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) readLoop(h *hub) {
	defer h.unregister(c)
	defer c.shutdown()
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		if !c.allow() {
			continue
		}
		if len(msg) == 0 || msg[0] != '{' {
			continue
		}
		if c.role == "host" {
			if c.room == nil && h.handleAccount(c, msg) {
				continue
			}
			if c.room != nil {
				c.room.broadcastFrom(c, msg)
			} else {
				h.broadcastDevices(msg)
			}
			continue
		}
		if c.room != nil && c.room.handleDevice(c, msg) {
			continue
		}
		if accountCommand(msg) {
			continue
		}
		wrapped, err := wrapDevice(c.id, msg)
		if err != nil {
			continue
		}
		if c.room != nil {
			c.room.sendToSelected(c, wrapped)
		} else {
			h.sendHost(wrapped)
		}
	}
}

func wrapDevice(id string, payload []byte) ([]byte, error) {
	var inner json.RawMessage
	if err := json.Unmarshal(payload, &inner); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"type":    "relay.deliver",
		"from":    id,
		"payload": inner,
	})
}

func (h *hub) registerHost(c *client) {
	h.mu.Lock()
	old := h.host
	h.host = c
	h.mu.Unlock()
	if old != nil {
		old.trySend(mustJSON(map[string]any{"type": "relay.replaced"}))
		old.shutdown()
	}
	h.broadcastDevices(mustJSON(map[string]any{"type": "relay.peer", "event": "join", "role": "host"}))
	log.Printf("host connected id=%s", c.id)
}

func (h *hub) registerDevice(c *client) bool {
	h.mu.Lock()
	old := h.devices[c.id]
	if old == nil && len(h.devices) >= maxDevices {
		h.mu.Unlock()
		return false
	}
	h.devices[c.id] = c
	host := h.host
	h.mu.Unlock()
	if old != nil && old != c {
		old.shutdown()
	}
	if host != nil {
		host.trySend(mustJSON(map[string]any{
			"type":  "relay.peer",
			"event": "join",
			"role":  "device",
			"id":    c.id,
			"name":  c.name,
		}))
	}
	log.Printf("device connected id=%s", c.id)
	return true
}

func (h *hub) unregister(c *client) {
	if c.room != nil {
		c.room.unregister(c)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.role == "host" {
		if h.host == c {
			h.host = nil
			note := mustJSON(map[string]any{"type": "relay.peer", "event": "leave", "role": "host"})
			for _, d := range h.devices {
				d.trySend(note)
			}
			log.Printf("host left id=%s", c.id)
		}
		return
	}
	if current, ok := h.devices[c.id]; ok && current == c {
		delete(h.devices, c.id)
		if h.host != nil {
			h.host.trySend(mustJSON(map[string]any{
				"type":  "relay.peer",
				"event": "leave",
				"role":  "device",
				"id":    c.id,
			}))
		}
		log.Printf("device left id=%s", c.id)
	}
}

func (h *hub) welcome(c *client) {
	h.mu.Lock()
	hostOnline := h.host != nil
	devices := len(h.devices)
	h.mu.Unlock()
	c.trySend(mustJSON(map[string]any{
		"type":        "relay.welcome",
		"role":        c.role,
		"self":        c.id,
		"accountName": h.book.name(),
		"hostOnline":  hostOnline,
		"devices":     devices,
	}))
}

func (h *hub) sendAccount(c *client) {
	c.trySend(mustJSON(map[string]any{
		"type":        "account.devices",
		"accountName": h.book.name(),
		"devices":     h.book.publicDevices(h.deviceOnline),
	}))
}

func (h *hub) deviceOnline(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.devices[id]
	return ok
}

func (h *hub) handleAccount(c *client, msg []byte) bool {
	var body struct {
		Type string `json:"type"`
		Name string `json:"name"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(msg, &body); err != nil || !strings.HasPrefix(body.Type, "account.") {
		return false
	}
	switch body.Type {
	case "account.issue", "account.revoke":
		c.trySend(mustJSON(map[string]any{"type": "error", "message": "配对码已停用，请用 GitHub 登录"}))
		return true
	case "account.rename":
		h.book.rename(body.Name)
	case "account.list":
	default:
		c.trySend(mustJSON(map[string]any{"type": "error", "message": "未知账号操作"}))
		return true
	}
	h.sendAccount(c)
	return true
}

func (h *hub) dropDevice(id string) {
	h.mu.Lock()
	device := h.devices[id]
	delete(h.devices, id)
	h.mu.Unlock()
	if device != nil {
		device.trySend(mustJSON(map[string]any{"type": "error", "message": "这台设备的配对码已作废"}))
		device.shutdown()
	}
}

func accountCommand(msg []byte) bool {
	var body struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(msg, &body) == nil && strings.HasPrefix(body.Type, "account.")
}

func (h *hub) sendHost(msg []byte) {
	h.mu.Lock()
	host := h.host
	h.mu.Unlock()
	if host == nil {
		return
	}
	host.trySend(msg)
}

func (h *hub) broadcastDevices(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, d := range h.devices {
		d.trySend(append([]byte(nil), msg...))
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"error","message":"encode"}`)
	}
	return b
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
