# FlyGate 整體流程設計

> 網頁介面全部是英文；這份文件給團隊看，用中文寫，按鈕名稱照網頁上的英文。

> 目標：評審在 3 分鐘內看懂三件事。
> 1. AI 真的會幫你訂票。
> 2. 每一筆錢都被鏈上規則管住。
> 3. 就算私鑰被偷、量子電腦來了，錢也不會被拿走。

## 設計原則

| 原則 | 做法 |
|---|---|
| **看起來像真的訂票網站** | 版面沿用大家熟悉的 OTA 樣式：藍色主視覺、白色搜尋卡、左側功能列、日期價格列、航班列表、藍色價格。評審不用學就看得懂。 |
| **讓看不見的閘門看得見** | 簽署後頂部一直顯示「授權狀態列」（已花／上限／到期／agent 私鑰狀態）。每張航班卡片底部都有閘門結果。下單時用逐步的「通關進度」呈現。 |
| **AI 理解，程式決定** | 畫面上分成兩種角色：藍色是 **Agent**，負責理解需求、排序航班；綠色是 **閘門**，用固定的程式和鏈上規則決定能不能買。右側動態紀錄寫明是誰做了什麼。 |
| **每個「出事」都有畫面** | 票價變動會被閘門擋下；下單失敗會自動退款；私鑰外洩有攻擊演習。這三段是贏過其他作品的關鍵。 |
| **誠實標示真假** | 簽章與加密在瀏覽器裡實際計算，標成紫色「Real crypto」；鏈上交易目前是模擬的，標成灰色「Simulated tx」。 |

## 六個畫面

| # | 路徑 | 畫面 | 評審要看到什麼 | 對應評分項目 |
|---|---|---|---|---|
| 1 | `/` | 首頁搜尋 | 一句話「Taipei to Tokyo, Dec 20, economy, refundable, max $400」自動拆成欄位，下方即時顯示 6 條鏈上規則 | 清晰度、原創性 |
| 2 | `/mandate` | 簽署授權 | 授權畫成登機證；表格說明每個條件對應哪個 QoreChain 機制；QoreX 錢包用 ML-DSA-87 簽章，並用 ML-KEM-1024 加密護照 | QoreChain 技術、後量子正確性 |
| 3 | `/search` | Agent 比價 | 8 個報價逐一過閘門：不可退、超過上限、商務艙、日期不符的全部擋下並寫出原因。Agent 從通過的航班中選一班，說明理由，然後倒數 5 秒自動下單 | 能照描述運作、AI 理解／程式決定 |
| 4 | `/checkout` | 閘門通關 | 8 道關卡逐步打勾：商家簽報價 → `pqcVerify` → 規則比對 → 鎖款 → Duffel 下單 → 開票 → 開票證明 → 放款 | 能照描述運作、QoreChain 技術 |
| 5 | `/ticket` | 電子機票 | 訂位代號、登機證樣式的電子票，下方列出 8 筆可獨立驗證的證明 | 清晰度 |
| 6 | `/drill` | 私鑰外洩演習 | 拿外洩的 agent 私鑰發動 5 次攻擊（含 Q-Day），全部被鏈上擋下；你用一個 ML-DSA-87 簽名撤銷 agent，第 6 次攻擊也失敗 | 後量子正確性、原創性 |

## 流程圖

```mermaid
sequenceDiagram
    actor U as 你（QoreX）
    participant A as FlyGate Agent
    participant G as 閘門（規則引擎）
    participant M as 商家服務
    participant D as Duffel 測試模式
    participant C as QoreChain（FlightEscrow）

    U->>C: ML-DSA-87 簽署授權：綁定 agent 私鑰、支出規則、限範圍 window
    U->>M: 護照資料以 ML-KEM-1024 加密
    A->>M: 查詢報價
    M->>D: offer request
    D-->>M: 8 個 offers
    M-->>A: 報價
    A->>G: 逐一檢查（票價、退票、艙等、日期、航線）
    G-->>A: 4 個通過、4 個擋下
    A->>A: 在通過的航班裡排序，選 ZZ 101
    M-->>A: ML-DSA-87 簽署的報價
    A->>C: MsgExecuteEVM → FlightEscrow.book()
    C->>C: pqcVerify 驗商家簽章、檢查上限，鎖款
    M->>D: 建立訂單（解密護照）
    D-->>M: 訂位代號
    M->>C: ML-DSA-87 簽署的開票證明
    C->>M: 驗過才放款
```

出事的分支：

- **票價變動**：商家報價變成 US$428，規則比對失敗，agent 停在付款之前。畫面提供「Book FA 802 · US$389 instead」和「Back to search」。
- **下單失敗**：錢已鎖進合約，但 Duffel 下單失敗，合約自動退款，畫面提供「Search again」。

## 狀態機

```
授權草稿 ──簽署──▶ 已簽署
                   │
                   ▼
Agent：讀取授權 → 查價 → 閘門檢查 → 排序 → 倒數 ──▶ 交給下單
                                        └─暫停─▶ 你自己選
                   │
                   ▼
下單：報價 → 驗簽 → 規則 ─失敗─▶ 已擋下（錢沒動）
                     │
                     ▼
                   鎖款 → 下單 ─失敗─▶ 退款（錢回來）
                           │
                           ▼
                     開票 → 開票證明 → 放款 ──▶ 出票成功
```

狀態集中在 `src/lib/store.tsx`，並存進 sessionStorage，重新整理頁面也不會中斷 Demo。

## Demo 控制台（給上台的人）

右下角藍色圓鈕，或按鍵盤 **D**。

- **Next booking scenario**：Ticketed／Fare jumps／Booking fails。觸發一次後會自動回到 Ticketed，方便接著示範改訂。
- **Speed**：錄影用 1×，現場趕時間用 2×。
- **Jump to**：直接跳到任一畫面。
- **Reset demo**：清空狀態回到首頁。

## 3 分鐘 Demo 怎麼點

開場前：控制台先選好「Fare jumps」。這樣一次流程就能同時示範「被擋下」和「改訂成功」。

| 時間 | 動作 | 畫面 |
|---|---|---|
| 0:00–0:20 | 首頁不點任何東西，講痛點 | `/` |
| 0:20–0:45 | Parse → Create mandate → Sign with QoreX → Sign | `/` → `/mandate` |
| 0:45–1:15 | Let the agent book，讓它自己查價、過閘門、排序、倒數下單 | `/search` |
| 1:15–1:50 | 商家報價漲到 US$428，閘門擋下，錢沒動 → Book FA 802 · US$389 instead → 8 道關卡全過 → 自動跳到電子機票 | `/checkout` → `/ticket` |
| 1:50–2:05 | 播一段事先錄好的「下單失敗、自動退款」10 秒片段（控制台選「Booking fails」錄製） | 錄影 |
| 2:05–2:40 | Start breach drill → Start attack → Revoke agent (ML-DSA-87) → Attack again with old key | `/drill` |
| 2:40–3:00 | 回到電子機票頁的 Proofs 區塊收尾 | `/ticket#proofs` |

錄影時把控制台的動畫速度設成 1×；現場時間不夠就切到 2×。

## 哪些是真的，哪些是模擬

| 項目 | 目前 | 接上真實服務的做法 |
|---|---|---|
| ML-DSA-87 簽章（授權、報價、開票證明、撤銷） | **真的**，`@noble/post-quantum` 在瀏覽器執行 | owner 改由 QoreX 錢包簽；商家金鑰放在商家伺服器 |
| `pqcVerify` 驗證 | **真的演算法**，在瀏覽器驗 | 改成 FlightEscrow 合約呼叫預編譯 `0x…0a01` |
| ML-KEM-1024 護照加密 | **真的**，KEM ＋ AES-256-GCM | 商家 KEM 公鑰用 `MsgRegisterKEMKey` 註冊上鏈 |
| 閘門規則檢查 | **真的**，`src/lib/gate.ts` | 保留，並在合約裡重複檢查 |
| 一句話解析 | 規則式解析（`parseIntent`） | 換成 Claude，解析結果仍要經過同一個閘門 |
| 航班報價、訂單 | 模擬資料（Duffel Airways ＋ 虛構航空公司） | Next.js route handler 呼叫 Duffel 測試模式 API |
| 鏈上交易（綁定、規則、window、鎖款、放款、退款） | 模擬，交易雜湊是隨機值 | `@qorechain/sdk`：`linkAuthenticatorMsgs`、`openEvmWindowMsg`、`MsgExecuteEVM` |
| 攻擊錯誤碼 | 取自 QoreChain 文件 | 在 diana 測試網實際送出攻擊交易 |

## 接上真實服務的順序

QoreChain 規定 agent 必須真的在鏈上動作，所以要按這個順序把模擬換掉：

1. **鏈上部分**（`src/lib/chain.ts`）：建立 owner、agent、商家三個 diana 帳號；用 `ensurePqcRegistered` 註冊 ML-DSA-87；`linkAuthenticatorMsgs` 綁定 agent 私鑰與支出規則；`openEvmWindowMsg` 開限範圍 window。
2. **FlightEscrow 合約**：`book()` 呼叫 `pqcVerify` 驗商家報價並鎖款；`confirmTicket()` 驗開票證明後放款；`refund()` 逾時或失敗時退款。用 Foundry 寫測試。
3. **Duffel**：新增 `src/app/api/offers/route.ts` 與 `src/app/api/orders/route.ts`，金鑰只放在伺服器環境變數 `DUFFEL_TEST_TOKEN`。
4. **攻擊演習**：把 `runOne()` 改成真的用 agent 私鑰送交易，錯誤碼直接顯示鏈上回傳的結果。
5. **Claude**：把 `parseIntent()` 換成 Claude，排序理由也由 Claude 產生；閘門與合約不變。

## 檔案地圖

```
src/
  app/
    page.tsx            首頁搜尋（一句話解析、閘門條件）
    mandate/page.tsx    簽署授權（ML-DSA-87、ML-KEM-1024）
    search/page.tsx     Agent 比價（閘門檢查、排序、倒數下單）
    checkout/page.tsx   閘門通關（8 道關卡、擋下、退款）
    ticket/page.tsx     電子機票與鏈上證明
    drill/page.tsx      私鑰外洩演習
  components/           Header、GateBar、FlowSteps、FlightCard、AgentFeed、WalletModal、PresenterPanel…
  lib/
    gate.ts             閘門規則（決定能不能買）
    mandate.ts          授權格式、一句話解析、規則對照
    pq.ts               ML-DSA-87 / ML-KEM-1024（真的）
    chain.ts            QoreChain 模擬層（之後換成 SDK）
    booking.ts          通關步驟定義
    offers.ts           Demo 航班資料
    store.tsx           Demo 狀態
```
