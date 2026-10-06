package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (h *hub) authConfig(w http.ResponseWriter, _ *http.Request) {
	setHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":        h.github.ready(),
		"login":     "/auth/github",
		"device":    "/v1/auth/github/device",
		"callback":  h.github.callbackURL(),
		"setupHint": "在 GitHub 新建 OAuth App，回调填 " + h.github.callbackURL() + "，并勾选 Enable Device Flow。把 Client ID 和 Secret 写到 /etc/herdr-relay/github.env",
	})
}

func (h *hub) startGitHubDevice(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	if !h.github.ready() || h.github.clientSecret == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": "服务器还没有配置 GitHub OAuth"})
		return
	}
	var body struct {
		Client string `json:"client"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	state := h.rememberOAuth(normalizeClient(body.Client))
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":           true,
		"pollId":       state,
		"authorizeUrl": h.github.authorizeURL(state),
		"interval":     2,
	})
}

func (h *hub) pollGitHubDevice(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	var body struct {
		PollID string `json:"pollId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.PollID == "" {
		body.PollID = r.URL.Query().Get("pollId")
	}
	h.logins.mu.Lock()
	wait := h.logins.states[body.PollID]
	h.logins.mu.Unlock()
	if wait == nil || time.Now().After(wait.expires) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": "登录已失效，请重试"})
		return
	}
	if wait.done != nil {
		_ = json.NewEncoder(w).Encode(sessionJSON(*wait.done))
		return
	}
	if wait.err != "" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": wait.err})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "pending": true})
}

func (h *hub) rememberOAuth(clientName string) string {
	state := "st" + randomHex(16)
	h.logins.mu.Lock()
	h.logins.states[state] = &oauthWait{client: clientName, expires: time.Now().Add(10 * time.Minute)}
	h.logins.mu.Unlock()
	return state
}

func (h *hub) startGitHubWeb(w http.ResponseWriter, r *http.Request) {
	if !h.github.ready() || h.github.clientSecret == "" {
		http.Error(w, "GitHub 登录还没配置完成", http.StatusServiceUnavailable)
		return
	}
	state := h.rememberOAuth(normalizeClient(r.URL.Query().Get("client")))
	http.Redirect(w, r, h.github.authorizeURL(state), http.StatusFound)
}

func (h *hub) finishGitHubWeb(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	h.logins.mu.Lock()
	wait := h.logins.states[state]
	h.logins.mu.Unlock()
	if wait == nil || time.Now().After(wait.expires) {
		http.Error(w, "登录状态已过期", http.StatusBadRequest)
		return
	}
	if denied := r.URL.Query().Get("error"); denied != "" {
		wait.err = "已取消 GitHub 登录"
		http.Error(w, wait.err, http.StatusUnauthorized)
		return
	}
	token, err := h.github.exchangeCode(r.URL.Query().Get("code"))
	if err != nil {
		wait.err = err.Error()
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	user, err := fetchGitHubUser(token)
	if err != nil {
		wait.err = err.Error()
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	sess := sessionFromUser(user, wait.client)
	h.sessions.put(sess)
	wait.done = &sess
	log.Printf("github login %s client=%s", sess.Login, sess.Client)
	if wait.client == "web" {
		http.Redirect(w, r, "/#session="+url.QueryEscape(sess.ID)+"&login="+url.QueryEscape(sess.Login), http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>已登录</title><body style='font:16px/1.5 sans-serif;background:#0b0d11;color:#e7ebf2;display:grid;place-items:center;height:100vh'><p>已用 " + sess.Login + " 登录。回到 herdr+ 即可，不用输入验证码。</p>"))
}

func (h *hub) logout(w http.ResponseWriter, r *http.Request) {
	setHeaders(w)
	var body struct {
		Session string `json:"session"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Session != "" {
		h.sessions.delete(body.Session)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (h *hub) serveGitHub(w http.ResponseWriter, r *http.Request, sessionID string) {
	sess, ok := h.sessions.get(sessionID)
	if !ok {
		http.Error(w, "请先用 GitHub 登录", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessage)
	room := h.room(sess.GitHubID)
	c := newClient(conn, sess.Role, sess.Name)
	c.login = sess.Login
	c.avatar = sess.Avatar
	c.room = room
	if sess.Role == "host" {
		macID := sanitize(r.URL.Query().Get("mac"), 64)
		if macID == "" {
			macID = sess.Client + ":" + sess.GitHubID
		}
		macName := sanitize(r.URL.Query().Get("name"), 40)
		if macName == "" {
			macName = sess.Name
		}
		c.macID = macID
		c.id = "mac:" + macID
		c.name = macName
		room.registerMac(c)
	} else {
		c.id = sess.Client + ":" + randomHex(6)
		if !room.registerDevice(c) {
			_ = conn.Close()
			return
		}
	}
	go c.writeLoop()
	room.welcome(c)
	log.Printf("github %s connected as %s", sess.Login, sess.Role)
	c.readLoop(h)
}

func (h *hub) room(githubID string) *ghRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[githubID]
	if room == nil {
		room = newGHRoom()
		h.rooms[githubID] = room
	}
	return room
}

func sessionJSON(sess authSession) map[string]any {
	return map[string]any{
		"ok":          true,
		"pending":     false,
		"session":     sess.ID,
		"login":       sess.Login,
		"name":        sess.Name,
		"avatar":      sess.Avatar,
		"role":        sess.Role,
		"accountName": sess.Login,
	}
}

func normalizeClient(name string) string {
	switch strings.TrimSpace(name) {
	case "desktop", "android", "web":
		return name
	default:
		return "web"
	}
}

func roleForClient(name string) string {
	if name == "desktop" {
		return "host"
	}
	return "device"
}
