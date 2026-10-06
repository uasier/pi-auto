package main

import (
	"encoding/json"
	"sync"
	"testing"
)

func roomHost(r *ghRoom, id string) *client {
	c := newClient(nil, "host", id)
	c.macID = id
	r.registerMac(c)
	return c
}

func roomDevice(t *testing.T, r *ghRoom) *client {
	t.Helper()
	c := newClient(nil, "device", "手机")
	if !r.registerDevice(c) {
		t.Fatal("无法加入房间")
	}
	return c
}

func drainClient(c *client) {
	for len(c.send) > 0 {
		<-c.send
	}
}

func nextMessage(t *testing.T, c *client, kind string) map[string]any {
	t.Helper()
	for len(c.send) > 0 {
		var body map[string]any
		if err := json.Unmarshal(<-c.send, &body); err != nil {
			t.Fatal(err)
		}
		if body["type"] == kind {
			return body
		}
	}
	t.Fatalf("没有收到 %s", kind)
	return nil
}

func selectMac(r *ghRoom, c *client, id string) {
	r.handleDevice(c, mustJSON(map[string]any{"type": "mac.select", "id": id}))
}

func TestRoomCachesJSONRegardlessOfFieldOrder(t *testing.T) {
	r := newGHRoom()
	h := roomHost(r, "mac")
	r.broadcastFrom(h, []byte(`{"items":[{"paneId":"一个超过四十八个字节的终端标识和路径","title":"会话"}], "type" : "sessions"}`))
	d := roomDevice(t, r)
	if got := r.snapshot()[0]["agentCount"]; got != 1 {
		t.Fatalf("会话数 = %v", got)
	}
	selectMac(r, d, "mac")
	if len(nextMessage(t, d, "sessions")["items"].([]any)) != 1 {
		t.Fatal("缓存不完整")
	}
}

func TestRoomSelectionAndDisconnectNotifyHosts(t *testing.T) {
	r := newGHRoom()
	a, b := roomHost(r, "a"), roomHost(r, "b")
	d := roomDevice(t, r)
	selectMac(r, d, "a")
	join := nextMessage(t, a, "relay.peer")
	if join["event"] != "join" || join["devices"] != float64(1) {
		t.Fatalf("加入通知：%v", join)
	}
	selectMac(r, d, "a")
	if len(a.send) != 0 {
		t.Fatal("重复选择不应增加设备")
	}
	selectMac(r, d, "b")
	leave := nextMessage(t, a, "relay.peer")
	if leave["event"] != "leave" || leave["devices"] != float64(0) {
		t.Fatalf("切换通知：%v", leave)
	}
	nextMessage(t, b, "relay.peer")
	r.unregister(d)
	leave = nextMessage(t, b, "relay.peer")
	if leave["event"] != "leave" || leave["id"] != d.id || leave["devices"] != float64(0) {
		t.Fatalf("断线通知：%v", leave)
	}
}

func TestRoomRepliesOnlyReachSelectedRecipient(t *testing.T) {
	r := newGHRoom()
	host, other := roomHost(r, "a"), roomHost(r, "b")
	first, second := roomDevice(t, r), roomDevice(t, r)
	selectMac(r, first, "a")
	selectMac(r, second, "a")
	drainClient(first)
	drainClient(second)
	reply := mustJSON(map[string]any{"type": "term.frame", "to": first.id, "bytes": "YWJj"})
	r.broadcastFrom(host, reply)
	nextMessage(t, first, "term.frame")
	if len(second.send) != 0 {
		t.Fatal("定向回放串到了另一设备")
	}
	r.broadcastFrom(other, reply)
	if len(first.send) != 0 {
		t.Fatal("回复来自未选择的 Mac")
	}
}

func TestReplacingHostResynchronizesAndIgnoresOldConnection(t *testing.T) {
	r := newGHRoom()
	old := roomHost(r, "mac")
	d := roomDevice(t, r)
	selectMac(r, d, "mac")
	drainClient(d)
	fresh := roomHost(r, "mac")
	nextMessage(t, d, "mac.selected")
	nextMessage(t, fresh, "relay.peer")
	drainClient(d)
	r.broadcastFrom(old, []byte(`{"type":"sessions","items":[{}]}`))
	r.unregister(old)
	if len(d.send) != 0 || r.snapshot()[0]["agentCount"] != 0 {
		t.Fatal("旧连接污染了新状态")
	}
	select {
	case <-old.done:
	default:
		t.Fatal("旧连接未关闭")
	}
}

func TestRoomRejectsInputWithoutMacAndHandlesHeartbeat(t *testing.T) {
	r := newGHRoom()
	d := roomDevice(t, r)
	r.sendToSelected(d, []byte(`{"type":"term.input"}`))
	nextMessage(t, d, "error")
	if !r.handleDevice(d, []byte(`{"type":"ping"}`)) {
		t.Fatal("心跳不应依赖选择 Mac")
	}
	nextMessage(t, d, "pong")
}

func TestSlowClientDisconnectsInsteadOfLosingMessages(t *testing.T) {
	c := newClient(nil, "device", "慢连接")
	for i := 0; i <= cap(c.send); i++ {
		c.trySend([]byte(`{"type":"term.frame"}`))
	}
	select {
	case <-c.done:
	default:
		t.Fatal("队列溢出不应静默丢弃增量")
	}
}

func TestRoomConcurrentCacheAndSelection(t *testing.T) {
	r := newGHRoom()
	h := roomHost(r, "mac")
	d := roomDevice(t, r)
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			r.broadcastFrom(h, []byte(`{"type":"sessions","items":[{}]}`))
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			selectMac(r, d, "mac")
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			r.snapshot()
		}
	}()
	workers.Wait()
}
