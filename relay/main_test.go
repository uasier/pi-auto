package main

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testHub(t *testing.T) *hub {
	t.Helper()
	book, err := loadBook("", "test-token-value-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	return newHub(book)
}

func TestGitHubSessionSharesRoom(t *testing.T) {
	hub := testHub(t)
	hub.sessions.put(authSession{ID: "hostsess", GitHubID: "42", Login: "uasier", Name: "uasier", Role: "host", Client: "desktop", Expires: time.Now().Add(time.Hour).Unix()})
	hub.sessions.put(authSession{ID: "websess", GitHubID: "42", Login: "uasier", Name: "uasier", Role: "device", Client: "web", Expires: time.Now().Add(time.Hour).Unix()})
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws"
	host, _, err := websocket.DefaultDialer.Dial(base+"?session=hostsess&mac=mbp&name=MacBook", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	dev, _, err := websocket.DefaultDialer.Dial(base+"?session=websess", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer dev.Close()
	if !readType(t, dev, "macs") {
		t.Fatal("device should see mac list before any conversation")
	}
	if err := dev.WriteMessage(websocket.TextMessage, []byte(`{"type":"mac.select","id":"mbp"}`)); err != nil {
		t.Fatal(err)
	}
	if !readType(t, dev, "mac.selected") {
		t.Fatal("select mac")
	}
	if err := host.WriteMessage(websocket.TextMessage, []byte(`{"type":"sessions","items":[]}`)); err != nil {
		t.Fatal(err)
	}
	if !readType(t, dev, "sessions") {
		t.Fatal("conversation starts only after a mac is selected")
	}
}

func TestHostSecretCannotLoginDevice(t *testing.T) {
	hub := testHub(t)
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws"
	bad, resp, err := websocket.DefaultDialer.Dial(base+"?role=device&token=test-token-value-0123456789", nil)
	if err == nil {
		bad.Close()
		t.Fatal("host secret must not open a device session")
	}
	if resp == nil || resp.StatusCode != 403 {
		t.Fatalf("status=%v err=%v", resp, err)
	}
}

func readType(t *testing.T, conn *websocket.Conn, kind string) bool {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return false
		}
		if strings.Contains(string(msg), `"type":"`+kind+`"`) {
			return true
		}
	}
}
