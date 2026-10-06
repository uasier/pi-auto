package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type githubApp struct {
	clientID     string
	clientSecret string
	publicURL    string
}

func loadGitHub(publicURL string) githubApp {
	values := map[string]string{}
	raw, err := os.ReadFile("/etc/herdr-relay/github.env")
	if err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, ok := strings.Cut(line, "=")
			if ok {
				values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
			}
		}
	}
	if values["GITHUB_CLIENT_ID"] == "" {
		values["GITHUB_CLIENT_ID"] = os.Getenv("GITHUB_CLIENT_ID")
	}
	if values["GITHUB_CLIENT_SECRET"] == "" {
		values["GITHUB_CLIENT_SECRET"] = os.Getenv("GITHUB_CLIENT_SECRET")
	}
	if publicURL == "" {
		publicURL = values["PUBLIC_URL"]
	}
	if publicURL == "" {
		publicURL = "https://154.36.168.192:8443"
	}
	return githubApp{
		clientID:     values["GITHUB_CLIENT_ID"],
		clientSecret: values["GITHUB_CLIENT_SECRET"],
		publicURL:    strings.TrimRight(publicURL, "/"),
	}
}

func (g githubApp) ready() bool {
	return g.clientID != ""
}

func (g githubApp) callbackURL() string {
	return g.publicURL + "/auth/github/callback"
}

type gitHubUser struct {
	ID     int64  `json:"id"`
	Login  string `json:"login"`
	Name   string `json:"name"`
	Avatar string `json:"avatar_url"`
}

type authSession struct {
	ID       string `json:"id"`
	GitHubID string `json:"githubId"`
	Login    string `json:"login"`
	Name     string `json:"name"`
	Avatar   string `json:"avatar"`
	Role     string `json:"role"`
	Client   string `json:"client"`
	Expires  int64  `json:"expires"`
}

type sessionStore struct {
	path string
	mu   sync.Mutex
	all  map[string]authSession
}

func newSessionStore(path string) *sessionStore {
	store := &sessionStore{path: path, all: map[string]authSession{}}
	if path == "" {
		return store
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return store
	}
	var saved []authSession
	if json.Unmarshal(raw, &saved) == nil {
		now := time.Now().Unix()
		for _, item := range saved {
			if item.Expires > now {
				store.all[item.ID] = item
			}
		}
	}
	return store
}

func (s *sessionStore) put(item authSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.all[item.ID] = item
	s.saveLocked()
}

func (s *sessionStore) get(id string) (authSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.all[id]
	if !ok || item.Expires < time.Now().Unix() {
		delete(s.all, id)
		return authSession{}, false
	}
	return item, true
}

func (s *sessionStore) delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.all, id)
	s.saveLocked()
}

func (s *sessionStore) saveLocked() {
	if s.path == "" {
		return
	}
	items := make([]authSession, 0, len(s.all))
	for _, item := range s.all {
		items = append(items, item)
	}
	raw, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, append(raw, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

type pendingGitHub struct {
	deviceCode string
	interval   time.Duration
	expires    time.Time
	lastPoll   time.Time
	client     string
	role       string
	done       *authSession
	err        string
}

type oauthWait struct {
	client  string
	expires time.Time
	done    *authSession
	err     string
}

type gitHubLogin struct {
	mu      sync.Mutex
	pending map[string]*pendingGitHub
	states  map[string]*oauthWait
}

func newGitHubLogin() *gitHubLogin {
	return &gitHubLogin{pending: map[string]*pendingGitHub{}, states: map[string]*oauthWait{}}
}

func (g githubApp) authorizeURL(state string) string {
	query := url.Values{}
	query.Set("client_id", g.clientID)
	query.Set("redirect_uri", g.callbackURL())
	query.Set("scope", "read:user")
	query.Set("state", state)
	return "https://github.com/login/oauth/authorize?" + query.Encode()
}

func (g githubApp) startDevice() (deviceCode, userCode, verificationURI string, interval int, err error) {
	if !g.ready() {
		return "", "", "", 0, fmt.Errorf("服务器还没有配置 GitHub OAuth")
	}
	form := url.Values{}
	form.Set("client_id", g.clientID)
	form.Set("scope", "read:user")
	req, err := http.NewRequest(http.MethodPost, "https://github.com/login/device/code", strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", "", 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", "", 0, err
	}
	defer res.Body.Close()
	var body struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		Interval        int    `json:"interval"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", "", "", 0, err
	}
	if body.Error != "" {
		return "", "", "", 0, fmt.Errorf("%s", body.ErrorDesc)
	}
	if body.Interval <= 0 {
		body.Interval = 5
	}
	return body.DeviceCode, body.UserCode, body.VerificationURI, body.Interval, nil
}

func (g githubApp) pollDevice(deviceCode string) (token string, pending bool, err error) {
	form := url.Values{}
	form.Set("client_id", g.clientID)
	form.Set("device_code", deviceCode)
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	if g.clientSecret != "" {
		form.Set("client_secret", g.clientSecret)
	}
	req, err := http.NewRequest(http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	switch body.Error {
	case "", "authorization_pending":
		if body.AccessToken != "" {
			return body.AccessToken, false, nil
		}
		return "", true, nil
	case "slow_down":
		return "", true, nil
	case "expired_token":
		return "", false, fmt.Errorf("授权已过期，请重新登录")
	case "access_denied":
		return "", false, fmt.Errorf("已取消 GitHub 登录")
	default:
		return "", false, fmt.Errorf("%s", body.Error)
	}
}

func (g githubApp) exchangeCode(code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", g.clientID)
	form.Set("client_secret", g.clientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", g.callbackURL())
	req, err := http.NewRequest(http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.AccessToken == "" {
		if body.Error == "" {
			body.Error = "GitHub 没有返回令牌"
		}
		return "", fmt.Errorf("%s", body.Error)
	}
	return body.AccessToken, nil
}

func fetchGitHubUser(token string) (gitHubUser, error) {
	req, err := http.NewRequest(http.MethodGet, "https://api.github.com/user", nil)
	if err != nil {
		return gitHubUser{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "herdr-plus")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return gitHubUser{}, err
	}
	defer res.Body.Close()
	var user gitHubUser
	if err := json.NewDecoder(res.Body).Decode(&user); err != nil {
		return gitHubUser{}, err
	}
	if user.ID == 0 || user.Login == "" {
		return gitHubUser{}, fmt.Errorf("GitHub 用户信息无效")
	}
	return user, nil
}

func sessionFromUser(user gitHubUser, clientName string) authSession {
	role := "device"
	if clientName == "desktop" {
		role = "host"
	}
	if user.Name == "" {
		user.Name = user.Login
	}
	return authSession{
		ID:       "s" + randomHex(24),
		GitHubID: fmt.Sprintf("%d", user.ID),
		Login:    user.Login,
		Name:     user.Name,
		Avatar:   user.Avatar,
		Role:     role,
		Client:   clientName,
		Expires:  time.Now().Add(30 * 24 * time.Hour).Unix(),
	}
}
