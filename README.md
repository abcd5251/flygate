# FlyGate

AI agent 幫你訂機票，每一筆錢都受鏈上規則限制。你只簽一次授權，agent 在條件內自己比價、下單；錢先鎖在合約，商家開票後才放款。授權和報價用 ML-DSA-87 簽章，護照用 ML-KEM-1024 加密。

這個 repo 目前是 **前端與整體流程**。簽章、加密、閘門規則是真的；鏈上交易和航班資料是模擬的，接上真實服務的方式寫在 [docs/FLOW.md](docs/FLOW.md)。

## 執行

```bash
pnpm install
pnpm dev --port 3100
```

打開 http://localhost:3100 。右下角藍色圓鈕（或按 **D**）是 Demo 控制台，可以切換 Ticketed／Fare jumps／Booking fails 三種情境、調整速度、跳頁、重設。介面全部是英文。

## 畫面

| 路徑 | 畫面 |
|---|---|
| `/` | 首頁：一句話解析成條件，即時顯示會變成哪些鏈上規則 |
| `/mandate` | 簽署授權：QoreX 錢包以 ML-DSA-87 簽章、ML-KEM-1024 加密護照 |
| `/search` | Agent 比價：每個報價過閘門，Agent 只在通過的航班裡排序並自動下單 |
| `/checkout` | 閘門通關：8 道關卡；票價變動會擋下、下單失敗會退款 |
| `/ticket` | 電子機票與 8 筆可驗證的證明 |
| `/drill` | 私鑰外洩演習：5 次攻擊（含 Q-Day）全部被擋，撤銷後再試也失敗 |

## 文件

- [docs/FLOW.md](docs/FLOW.md)：整體流程設計、狀態機、Demo 點擊路線、真與模擬對照、接上真實服務的順序
- [docs/PITCH.md](docs/PITCH.md)：簡報結構、3 分鐘影片分段、評審 Q&A

## 技術

Next.js 16（App Router）、React 19、Tailwind CSS 4、`@noble/post-quantum`（ML-DSA-87、ML-KEM-1024）、`lucide-react`。
