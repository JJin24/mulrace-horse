# 5G 賽馬轉播及互動系統（雙 Tello）

此專案提供一套可落地的 **雙 Tello 直播 + 官方控制 + 觀眾互動投票** 平台：
- 官方入口：馬匹管理、賽事狀態控制、投票建立、雙機控制、Gamepad 手把操作
- 觀眾入口：雙畫面直播、即時投票（Kahoot 類型）與票數同步
- 後端：Fastify + Socket.IO + SQLite（WAL）
- 無人機客戶端：Python + djitellopy + OpenCV（可切換模擬串流）

## 架構

1. `src/server.js`：HTTP + Socket.IO Server（角色入口、投票、控制、畫面轉發）
2. `src/db.js`：SQLite schema 與資料存取
3. `public/`：官方頁與觀眾頁
4. `tello-client/tello_bridge.py`：與兩台 Tello 通訊並回傳影像/狀態

## 快速啟動

### 1) 啟動 Server

```bash
npm install
copy .env.example .env
npm run start
```

開啟：
- 官方頁：`http://localhost:3000/official`
- 觀眾頁：`http://localhost:3000/audience`

### 2) 啟動 Tello Bridge Client

```bash
cd tello-client
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set SERVER_URL=http://localhost:3000
set BRIDGE_ACCESS_KEY=bridge-1234
set TELLO_DRONES_JSON=[{"id":"drone-1","label":"Tello #1","host":"192.168.10.1"},{"id":"drone-2","label":"Tello #2","host":"192.168.10.2"}]
python tello_bridge.py
```

> 若現場尚未接上實機，可先用模擬模式：
```bash
set SIMULATE_STREAM=true
python tello_bridge.py
```

## 使用說明

1. 官方頁登入 `OFFICIAL_ACCESS_KEY`
2. 新增馬匹與設定賽事狀態
3. 建立投票題目與選項
4. Tello Bridge 連線後，官方與觀眾頁都會看到雙機畫面
5. 官方可直接按鈕控制，或啟用手把輸入（A: 起飛 / B: 降落）

## 高併發處理策略

- Socket.IO 使用 websocket-only，降低傳輸協商負擔
- 影像幀以可調 FPS 與 JPEG 壓縮轉發，降低頻寬占用
- 控制命令加入最小間隔限流，避免暴衝
- SQLite 使用 WAL + busy timeout，提升多連線讀寫穩定性

## 安全提醒

- 正式環境務必更換 `OFFICIAL_ACCESS_KEY` 與 `BRIDGE_ACCESS_KEY`
- 飛行前請完成場地安全檢查、禁飛區檢查與 failsafe 設定
# mulrace-horse
