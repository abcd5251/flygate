# live-checkout spec

> GitHub issue: #16 https://github.com/abcd5251/flygate/issues/16（label `ready-for-agent`）
> 這是 issue 本文的副本；以 issue 為準。

> 基準分支：`develop`。工作分支 `feat/live-checkout`，從本機 `feat/flight-escrow` 往下長，完成後開 PR 合回 `develop`（不自動合併）。
>
> **相依（未合併）**：
> - PR #8 `chore/diana-bootstrap`（三帳號 bootstrap、ML-DSA-87 註冊；本功能需要這三個帳號與 `OWNER_MNEMONIC`／`AGENT_MNEMONIC`／`MERCHANT_MNEMONIC`）。
> - `feat/flight-escrow`（#7，tickets #9–#14）：分支目前只在本機、未推上 origin；**FlightEscrow 合約尚未部署（#14 未完成），沒有合約地址**。ticket/13 的 EVM 金鑰 helper 也尚未併進 `feat/flight-escrow`。
> - 合併順序：#8 → `feat/flight-escrow` → `feat/live-checkout`。
>
> **兩段交付（D-01）**：**A 段（本次 PR）**：Live 轉接層、伺服器端 routes、Live／Simulated 切換、標籤改寫、退回機制、不依賴測試網的自動測試。**B 段（#14 部署並跑完 e2e 之後）**：在 diana 實跑三種情境，explorer 連結記進流程文件。需求的完成標準「每個鏈上步驟都有可以在區塊瀏覽器查到的交易」列為 B 段驗收；B 段完成前，PR 描述必須明寫這一項尚未驗收。
>
> 決策紀錄：`docs/features/live-checkout/decisions.md`（D-01～D-34）；ADR-0001（伺服器簽章）、ADR-0002（agent 從 owner 帳號下單，Proposed）。
>
> 依據：D-01、D-03、D-04

## §1 Problem Statement

FlyGate 的 8 道關卡裡，跟鏈有關的步驟（授權綁定、開 window、鎖款、開票放款、退款）目前全部是模擬：`makeTx()` 產生隨機雜湊，畫面上標「Simulated tx」。評審問「鏈上部分是真的嗎？」時，我們拿不出 explorer 連結；QoreChain 也要求 agent 真的在鏈上動作。

從 presenter 的角度：我要在 Demo 裡讓評審看到真的交易雜湊、點得開的 explorer 連結，並且「Fare jumps」時錢真的沒動、「Booking fails」時錢真的退回。但測試網可能限流、逾時或出錯，我不能讓 Demo 卡死在台上；也不能讓畫面把模擬的步驟說成真的。

從 owner 的角度：Demo 沒有真的 QoreX 錢包，伺服器會用我的帳號送出真交易，我需要確定助記詞不會進到瀏覽器或 git，agent 的金鑰就算外洩，也只能在我設的支出規則內呼叫 `book()`。

依據：D-01、D-05、D-06、D-20、D-26

## §2 Solution

在 Demo 控制台加一個 **Live／Simulated 切換**（預設 Simulated）。Live 模式下：

- **/mandate（授權階段）**：瀏覽器照舊做真的 ML-DSA-87 簽章與 ML-KEM 加密；之後由 Next.js 伺服器代 owner 依序送出三筆真交易：`linkAuthenticatorMsgs`（把 agent 金鑰和支出規則綁到 owner 帳號，只放行 `FlightEscrow.book()`）→ `openEvmWindowMsg`（只放行 FlightEscrow 的 **Scoped window**）→ `setMandate`（**on-chain mandate**）。
- **/checkout（通關階段）**：
  - Ticketed：`lock` 走 `MsgExecuteEVM` → `book()`，錢從 owner 帳號出；`proof` 送出商家簽的 `confirmTicket()`，同一筆交易放款，`release` 顯示同一筆雜湊（`Released` event）。
  - Fare jumps：不送任何交易；用 `eth_call` 模擬 `book()` 拿到 `FareOverCap`（**Live read**），前後讀餘額證明錢沒動。
  - Booking fails：`lock` 真的鎖款，Duffel 模擬失敗後，送出商家簽的 `cancel()` 立刻退款，並讀退款地址餘額證明錢回來了。
- 每個真交易步驟標「Live tx · diana」並連到 explorer；唯讀查詢標「Live read」；仍是模擬的步驟才標「Simulated tx」。
- 測試網出問題時，失敗的步驟如實標 failed 並顯示鏈上錯誤碼，presenter 按「Finish in Simulated mode」從失敗那一步接著用模擬跑完；已上鏈的步驟保留「Live tx」。錢卡在合約裡時，事後用 `pnpm live:sweep` 退回 owner。
- 合約沒有地址（#14 未部署）時，Live 會被停用並顯示原因，Demo 照樣用 Simulated 跑完。

所有鏈上簽章都在伺服器（Route Handlers）做，瀏覽器不碰 SDK 與金鑰（ADR-0001）。

依據：D-01、D-02、D-05、D-06、D-09、D-12、D-13、D-16、D-17、D-18、D-20、D-24、D-26

## §3 User Stories

**授權階段（/mandate）**

1. As a presenter, I want 在 Live 模式簽 mandate 時，伺服器真的送出 link、window、`setMandate` 三筆交易, so that 評審在 explorer 上看得到授權是真的上鏈。
2. As an owner, I want agent 的 coin-60 金鑰以 authenticator 身分綁到我的帳號, so that agent 能代我下單，卻不能自由花我的錢。
3. As an owner, I want 支出規則的 `allowedEvmCalls` 只放行 FlightEscrow 的 `book()` selector, so that agent 金鑰外洩也不能呼叫 `setMandate` 或 `revokeMandate` 調高自己的上限。
4. As an owner, I want 單筆上限等於票價上限、每日上限等於單筆上限乘以票數, so that agent 最多只能花我授權的金額。
5. As an owner, I want authenticator 的到期時間等於 mandate 的到期時間, so that agent 的權限會自動結束。
6. As an owner, I want 開一個只放行 FlightEscrow、限制交易數與總金額、最多約 1 小時的 window, so that 我帳號能送出的 EVM 交易被限縮在這次 Demo 需要的範圍。
7. As an owner, I want 每次更新支出規則都送完整的一份, so that 整批取代時不會意外刪掉規則。
8. As an owner, I want 畫面誠實顯示付款地址（owner 帳號 qor1／0x）與退款地址（owner EVM 地址 0x）是兩個地址, so that 我知道錢從哪裡出、退到哪裡。
9. As a presenter, I want 第二輪 Demo 簽 mandate 時，鏈上 `maxTickets` 自動算成「已用張數 + 本次張數」, so that 第二輪不會因為 `TicketQuotaExhausted` 失敗，畫面仍顯示「1 ticket」。
10. As a presenter, I want 查不到已用張數時 Live 簽署直接失敗並說明原因, so that 系統不會猜一個數字寫上鏈。
11. As a presenter, I want WalletModal 在 Live 模式標「Demo owner key (server)」, so that 我對評審說的話屬實：簽鏈上交易的是伺服器上的 Demo owner 金鑰，不是真錢包。
12. As a presenter, I want /mandate 的 Live 步驟失敗時有「Sign in Simulated mode instead」, so that Demo 能繼續。
13. As a presenter, I want 如果探測證明 window 管不到 `MsgExecuteEVM`，規則表的「Scoped window」說明改成它實際管住的東西, so that 畫面不會誇大 window 的保護範圍。

**通關階段（/checkout）**

14. As a presenter, I want Ticketed 情境的 `lock` 和 `proof` 各送一筆真交易, so that 評審能在 explorer 看到鎖款與放款。
15. As an owner, I want `book()` 透過 `MsgExecuteEVM` 從我帳號的 0x 地址發出, so that 票錢真的從我的錢包付出，而不是 agent 自己的錢。
16. As a presenter, I want `release` 步驟顯示和 `proof` 同一筆雜湊、說明「`Released` event · `confirmTicket()`」, so that 畫面符合合約在同一筆交易裡放款的事實。
17. As a presenter, I want `verify` 步驟對 `pqcVerify` 預編譯做 `eth_call` 並標「Live read」, so that 評審看到簽章是鏈上驗過的，卻不用多付一筆手續費。
18. As a merchant, I want quote、TicketProof、CancelProof 都用我 bootstrap 註冊上鏈的那把 ML-DSA-87 金鑰簽, so that 合約用 `pqcKeyStatus` 讀到的公鑰驗得過。
19. As a presenter, I want Fare jumps 情境不送任何交易，而是用 `eth_call` 顯示合約回傳的 `FareOverCap`, so that 我能證明合約也會擋下，而且錢沒動（連手續費都沒花）。
20. As an owner, I want Fare jumps 前後各讀一次我的鏈上餘額並顯示「Balance unchanged」, so that 「錢沒動」有鏈上證據。
21. As a presenter, I want Booking fails 情境先真的鎖款，再用商家簽的 CancelProof 送 `cancel()` 立刻退款, so that 評審看到錢鎖進去又退回來，不用乾等 ticket window 過期。
22. As an owner, I want Booking fails 後讀一次退款地址的餘額, so that 「錢退回」有鏈上證據。
23. As a merchant, I want `confirmTicket()` 和 `cancel()` 由 agent 的 EOA 代送，權限只來自我的簽章, so that 我的 EVM signer 不需要另外補款。
24. As a presenter, I want 這兩步的 actor 仍標「Merchant」，細節列加註「submitted by agent」, so that 畫面說清楚誰簽、誰送。
25. As a presenter, I want 畫面仍顯示 US$389，旁邊加註「≈ 3.89 QOR on diana」, so that 訂票網站的外觀不變，而 owner 約 60 QOR 的餘額付得起。

**標籤與連結**

26. As a judge, I want 每個步驟清楚標示「Real crypto」「Live tx · diana」「Live read」或「Simulated tx」, so that 我分得出哪些是真的。
27. As a judge, I want 點「Live tx」的雜湊就打開 explorer, so that 我能自己查證。
28. As a judge, I want 失敗或執行失敗的交易不標「Live tx」而顯示鏈上錯誤碼, so that 畫面不會把失敗說成成功。
29. As a presenter, I want /checkout 側欄、/ticket 的 Proofs 區塊、WalletModal 裡寫死的「simulated」文字跟著模式改, so that Live 模式下沒有自相矛盾的說明。
30. As a presenter, I want /checkout 側欄的 Escrow 地址在 Live 模式顯示真的合約地址, so that 評審看到的地址就是 explorer 上那一個。
31. As a presenter, I want explorer 連結的 tooltip 提醒「Explorer: switch to Testnet」, so that 評審打開後知道要切到測試網。

**切換與退回**

32. As a presenter, I want 切換鈕放在 PresenterPanel 的「Chain」區塊、預設 Simulated, so that 不設定也能跑完 Demo。
33. As a presenter, I want Live 模式下 Header 有「Live · diana」小標章, so that 評審隨時知道現在是哪個模式。
34. As a presenter, I want Live 不可用時切換鈕停用並顯示原因（例如「Live unavailable: FlightEscrow not deployed」）, so that 我在上台前就知道問題在哪。
35. As a presenter, I want booking 進行中或簽章視窗打開時切換鈕鎖住, so that 模式不會在流程中途改變。
36. As an owner, I want 用 Simulated 簽的 mandate 在 Live 模式下不能拿去送真交易，畫面要求「Re-sign your mandate in Live mode」, so that 模擬資料和真交易不會混在一起。
37. As a presenter, I want Reset demo 時保留目前的模式, so that 每次重來不用重新切換。
38. As a presenter, I want Live 步驟遇到 30 秒逾時、RPC 錯誤或 revert 時，標 failed、顯示錯誤碼，並提供「Finish in Simulated mode」, so that Demo 能照常跑完，卻不會無聲地把後面的模擬步驟說成真的。
39. As an owner, I want `lock` 成功後才失敗時，畫面顯示 bookingId 並提示「Refunds after the ticket window」, so that 我知道錢暫時鎖在合約裡、之後會退回。
40. As a developer, I want `pnpm live:sweep` 找出已過期限、還在 Locked 的 booking 並逐一呼叫 `refund()`, so that 卡住的錢一律回到 owner。

**可用性、安全與冪等**

41. As a presenter, I want `/api/live/status` 檢查 `LIVE_MODE`、三組助記詞、合約地址與 code、EVM chain id 9800、商家 PQC 金鑰、各帳號餘額, so that Live 只有在真的跑得起來時才能選。
42. As a developer, I want 合約地址從伺服器環境變數讀取，Live 模式絕不拿假地址當預設值, so that 不會對一個不存在的合約送交易。
43. As an owner, I want 助記詞只存在伺服器環境，Live 模組 import 進 client 時 build 直接失敗, so that 金鑰不會進到瀏覽器 bundle。
44. As a developer, I want `pnpm check:bundle` 在 build 後掃描靜態檔，發現金鑰或 SDK 特徵字串就失敗, so that 有人誤 import 時一定被攔下。
45. As an owner, I want Live routes 只在 `LIVE_MODE=on` 時啟用、否則回 404, so that 伺服器不會變成任何人都能用的簽章服務。
46. As an owner, I want routes 只接受 `offerId`、`scenario`、`bookingId` 這類結構化參數，calldata、金額、收款人都由伺服器自己組, so that client 不能讓伺服器簽任意交易。
47. As an owner, I want 廣播一律不重試、伺服器以 `(step, bookingId)` 做冪等, so that StrictMode、重複點擊、多個分頁都不會造成重複付款。
48. As a presenter, I want 重新整理後，進行中的步驟向伺服器查這筆 booking 的鏈上狀態，而不是再送一次, so that 頁面重載不會重送交易。
49. As a presenter, I want 每筆 Live 交易等到上鏈才算完成，但動畫節奏和 Simulated 差不多, so that Demo 不會變慢，畫面也不會在交易失敗前就顯示成功。
50. As a developer, I want 第一張 ticket 是 diana 探測腳本 `pnpm live:probe`, so that `MsgExecuteEVM` 的 `msg.sender`、coin-60 signer 的前置條件、selector 規則、explorer 是否認 0x 雜湊，在寫完整條流程前就先驗證。
51. As a developer, I want 送件路徑保留 `authenticator`／`eoa` 設定點, so that 探測證明 authenticator lane 走不通時，可以退回 #14 驗證過的 EOA lane。
52. As a developer, I want 不依賴測試網的自動測試，用假的鏈驗證三種情境的廣播次數與冪等, so that CI 不用打 diana。

依據：D-02、D-05～D-30、D-32、D-33

## §4 Implementation Decisions

### §4.1 交付邊界、合約地址與相依

- 分兩段交付，見開頭說明。A 段的 PR 不宣稱「每個鏈上步驟都有 explorer 可查的交易」，這一項是 B 段驗收。
- 合約地址從伺服器環境變數 `FLIGHT_ESCROW_ADDRESS` 讀取；另加 `FLIGHT_ESCROW_DEPLOY_BLOCK`（給 §4.4 查 log 用）。環境範例檔加這兩個空白欄位。以下任一情況 Live 判定為不可用：未設定、不是合法 0x 地址、`eth_getCode` 為空、EVM chain id 不是 9800。
- Live 模式不能拿瀏覽器常數裡的假 escrow 地址當預設值。本功能**不改**該常數；Simulated 模式繼續用它當佔位地址。
- 與 #14 的重疊：release 與 refund 步驟的說明文字直接採用 #14／#7 的寫法（release：「`Released` event · `confirmTicket()`」；失敗退款：「`FlightEscrow.cancel()`」）。誰先合併，另一邊合併時採用同一段文字。PR 描述要列出這個重疊。
- ticket/13 的 EVM 金鑰 helper（每個角色的 coin-60 signer）等它併進 `feat/flight-escrow` 後再 merge 進來，不複製程式碼。

依據：D-01、D-02、D-03、D-04

### §4.2 金鑰邊界與簽章位置

- **所有 Live 鏈上簽章都在 Next.js Route Handlers（Node runtime）做**，金鑰從伺服器環境變數 `OWNER_MNEMONIC`、`AGENT_MNEMONIC`、`MERCHANT_MNEMONIC` 推導，絕不加 `NEXT_PUBLIC_` 前綴。瀏覽器完全不 import `@qorechain/sdk`；瀏覽器只保留現有的 Demo 用 ML-DSA-87 簽章與 ML-KEM 加密（「Real crypto」）。見 ADR-0001。
- owner 沒有真錢包：WalletModal 介面不變，前兩步仍在瀏覽器做真簽章與加密，之後的鏈上交易由伺服器用 `OWNER_MNEMONIC` 代簽，當作 QoreX 錢包的替身；Live 模式下標章改為「Demo owner key (server)」。
- 防外洩三道防線：(1) 伺服器端 Live 模組集中在一個 server-only 目錄，每個模組第一行 `import "server-only"`（新增 `server-only` 套件），client 誤 import 時 build 失敗；(2) 新增 `pnpm check:bundle`：`next build` 後掃描 client 靜態輸出，出現 `MNEMONIC`、`qorechain-evm-auth`、`@qorechain/sdk` 特徵字串就失敗；(3) `.env*` 不進 git，只放行只列變數名稱的範例檔。API 回應只回傳公開資料（地址、雜湊、錯誤碼）。
- 濫用防護：只有 `LIVE_MODE=on` 時 Live routes 才啟用，否則一律 404。Live 只在 presenter 本機 `pnpm dev`／`pnpm start` 使用，不部署到公開主機。routes 只接受結構化參數（`offerId`、`scenario`、`bookingId`），quote、calldata、金額、收款人都由伺服器從 Demo offers 和 mandate 組出來。
- 伺服器端 Live 模組可以 import 共用編碼模組與 bootstrap 的純函式，但**不能** import bootstrap 的環境檔讀寫模組（它會產生並寫入助記詞）。

依據：D-05、D-06、D-07、D-08、D-31

### §4.3 帳號拓樸與送件路徑（lane）

- **`book()` 走 authenticator lane 的 `MsgExecuteEVM`**（**Linked agent key**）：
  - agent 金鑰是 agent 助記詞的 coin-60 secp256k1 金鑰，以 20-byte ETH 地址綁定（scheme `secp256k1`，擁有證明用 `signAuthenticatorLinkEip191`）。
  - agent 對 `evmAuthSignBytesV2` 簽章；digest 版本用 `resolveEvmAuthDigestVersion` 確認，nonce 用 `fetchAuthNonce` 讀。
  - **Relayer** 是 agent 的 bootstrap 帳號（coin-118 qor1，已註冊 ML-DSA-87、有餘額），負責混合簽章並付手續費。
  - 合約呼叫從 owner 帳號的 0x 地址發出，`msg.value` 從 owner 錢包出。
  - 廣播後一定呼叫 `assertAuthenticatorExecutionsSucceeded`（code 0 也可能是失敗的執行）。
- **`setMandate(agent, mandate)` 由 owner 的 coin-60 EVM signer 以一般 EVM 交易送出**，`agent` 參數填 owner 帳號的 0x 地址（也就是 `book()` 的 `msg.sender`）。合約記下的 owner（退款去向）是 owner 的 EVM signer。畫面分兩行：「付款：owner 帳號 qor1…／0x…」、「退款：owner EVM 地址 0x…」，都標「your wallet」。驗收「錢退回」比對退款地址的餘額。見 ADR-0002。
- **`confirmTicket()` 與 `cancel()` 由 agent 的 coin-60 EOA 送出**（合約不檢查 `msg.sender`，權限來自商家簽章）。
- **diana 探測是第一張 ticket**：`pnpm live:probe` 以小額交易和一份臨時探測合約（或 #14 的合約）確認：(1) `MsgExecuteEVM` 的 `msg.sender`；(2) coin-60 signer 送 EVM 交易的前置條件（PQC 註冊、window）；(3) 帶 selector 的 `allowedEvmCalls` 是否生效；(4) explorer 是否認 0x EVM 交易雜湊；(5) noble 產生的商家簽章能被鏈上公鑰驗過（`verifyMessage` 與 `pqcVerify` 的 `eth_call`）。結果寫進流程文件的「diana 測試網實測記錄」。
- 轉接層保留 `lane: "authenticator" | "eoa"` 設定點。探測證明 authenticator lane 走不通時，退回 EOA lane（agent 的 coin-60 EOA 直接呼叫 `book()`），畫面改標「agent EOA」，PR 描述說明偏離需求的原因。探測結果可能推翻本節與 §4.4 的 window 設定。

依據：D-09、D-10、D-11、D-19、D-32

### §4.4 授權階段（/mandate）的三筆交易

- 交易順序固定：link（Cosmos 交易）→ open window（Cosmos 交易）→ `setMandate`（EVM 交易）。開 window 會推進 EVM nonce，所以 EVM 交易在開完之後才簽。
- **`linkAuthenticatorMsgs`**：`owner` 是 owner 的 qor1，`account` 省略；`scheme` 為 `secp256k1`，`pubkey` 是 agent ETH 地址 20 bytes；`permissions = ["evm"]`；`expiryUnix` 等於 mandate 的 `expiresAt`；帶 `chainId: "qorechain-diana"` 讓 SDK 先本地驗證擁有證明。只放一條 `spendingRule`：`perTxLimit` = 票價上限換算成 uqor（§4.5）、`dailyLimit` = agent 金鑰今天（UTC）已花的金額 + `perTxLimit × maxTickets`（鏈上的每日累計不會因換規則歸零；已花金額取自 owner 帳號今天成功執行的 `MsgExecuteEVM` 的 value，讀不到就失敗，D-13）、`allowedEvmCalls = ["0x<escrow>/0x<book() selector>"]`（只放行 `book()`，絕不含 `setMandate`、`revokeMandate`）、`enabled = true`。`MsgUpdateSpendingRules` 整批取代，每次送完整一份。
- **`openEvmWindowMsg`（Scoped window）**：sender 是 owner 帳號（qor1）；`allowedTargets = [FlightEscrow 地址]`；`maxTxs = mandate.maxTickets`；`maxValue` =（每張票上限 + 最大手續費）× `maxTickets`，單位 uqor、無條件進位；`blocks` = min(3,600, 距 mandate 到期的區塊數)。若探測發現 window 管不到 `MsgExecuteEVM`，仍然開 window，但 /mandate 規則表「Scoped window · allowedTargets／maxTxs」兩列的說明改成它實際管住的東西。
- **`setMandate`**：見 §4.3。鏈上 `maxTickets` 的值：伺服器從 `FLIGHT_ESCROW_DEPLOY_BLOCK` 起算這個 agent 地址的訂位——`eth_getLogs` 查到的 `Booked` 事件，加上 owner 帳號成功執行的 `MsgExecuteEVM` `book()`（authenticator 通道的 log 不會出現在 `eth_getLogs`，改用 Cosmos tx search 讀），依 bookingId 去重後減掉已 `Refunded` 的，得到 `used`；鏈上 `maxTickets = used + mandate.maxTickets`，畫面仍顯示原本的張數。log 或交易紀錄查不到（例如 RPC 限制範圍、節點已刪除舊區塊）時 Live 簽署直接失敗並說明原因，不猜數字。
- `SignedMandate` 加上 `mode` 欄位，記錄是在哪個模式簽的（§4.8）。

依據：D-10、D-12、D-13、D-25、D-29

### §4.5 金額換算與結構對應

- Live 模式 **1 US$ = 0.01 QOR**，可用伺服器環境變數 `LIVE_QOR_PER_USD` 調整。畫面仍顯示 US$ 票價，旁加註「≈ x QOR on diana」。合約的 `maxFareWei`、`priceWei` 與支出規則、window 的 uqor 金額都用同一個比例換算。（與 #7「1 QOR shown as US$1」不同：#7 的慣例只用於它自己的 e2e 腳本，本功能只在 Live 畫面換算，不改合約。）
- Demo Offer／Mandate 對應到合約 `Quote`／`Mandate`：
  - `offerId` = `keccak256(utf8(offer.id))`。
  - `origin`／`destination` 用 mandate 的城市代碼（TPE／TYO），不用機場代碼。
  - `departDay`、`departFrom`、`departTo` = 對應日期的 UTC 午夜 ÷ 86,400。
  - `cabin`：economy 0、premium 1、business 2。
  - `refundable` = `offer.refundable`。
  - `expiresAt` = 現在 + 20 分鐘；`ticketWindow` = 600 秒。
  - `merchant` = 商家 bootstrap 帳號的 0x 地址；`agent` 依 §4.3 填入。
  - `mandateHash` = 瀏覽器簽 mandate 時算出的 SHA-256（32 bytes）。
  - 鏈上 `maxTickets` 依 §4.4。
- 編碼全部走既有的共用 escrow 編碼模組，不另寫一套。
- **商家金鑰**：用 `derivePqcCanonical(merchantQor1, MERCHANT_MNEMONIC)` 推導、bootstrap 已註冊上鏈的那一把，把 secretKey 交給共用編碼模組的簽章函式；**不用**只給 ffi 測試用的固定 seed 金鑰函式。

依據：D-14、D-15、D-32

### §4.6 通關階段：三種情境對應到鏈上結果

| 步驟 | Ticketed | Fare jumps | Booking fails |
|---|---|---|---|
| quote | 伺服器以商家金鑰對鏈上格式 Quote 做真 ML-DSA-87 簽章（不送交易） | 同左，價格 US$428 | 同 Ticketed |
| verify | `pqcVerify` 的 `eth_call`，Live read | 同左 | 同左 |
| rules | 鏈下 gate 檢查 | 鏈下 gate 擋下；改用 `eth_call` 模擬 `book()`（428 quote、等額 value、從 lane 的 sender）顯示 `FareOverCap(maxFareWei, priceWei)`，Live read，無雜湊；前後讀 owner 餘額顯示「Balance unchanged: x QOR」 | 鏈下 gate 通過 |
| lock | **真交易** `MsgExecuteEVM` → `book()` | 不執行 | **真交易** `book()` |
| order / ticket | 模擬 Duffel 與 PNR | — | order 模擬 Duffel 失敗 |
| proof | **真交易**：商家簽 TicketProof，agent EOA 送 `confirmTicket()` | — | — |
| release | 不另送交易，顯示 proof 的雜湊，「`Released` event」 | — | — |
| refund | — | — | **真交易**：商家簽 `CancelProof{bookingId, reasonCode: 1}`，agent EOA 送 `cancel()`，合約發出 `Refunded(Cancelled)`；讀退款地址餘額確認錢回來 |

- Ticketed 共 2 筆真交易（加上 /mandate 的 3 筆）；Fare jumps 0 筆廣播；Booking fails 是 `book` + `cancel` 2 筆。
- Fare jumps 不送會 revert 的真交易，因為會花手續費，等於錢動了。
- 失敗退款用 `cancel()` 不用 `refund()`：`refund()` 要等 ticket window 過期，只留給事後清理（§4.8）。兩種模式的 refund 步驟說明都改成「`FlightEscrow.cancel()`」。
- `confirmTicket`／`cancel` 的 actor 標「Merchant」，細節列加註「submitted by agent」。

依據：D-16、D-17、D-18、D-19

### §4.7 畫面標籤、資料形狀與 explorer 連結

- `SourceTag` 由真／假兩種改成四種：「Real crypto」（瀏覽器算出的簽章或加密）、「Live tx · diana」（已上鏈交易，可點開 explorer）、「Live read」（`eth_call` 或 REST 唯讀查詢）、「Simulated tx」。只有廣播後 code 為 0，且（authenticator lane）執行結果也成功的交易才能標「Live tx」；失敗的交易顯示鏈上錯誤碼。
- 跟著模式改的寫死文字：/checkout 側欄「Chain txs are simulated in this demo; signatures are real.」；/ticket Proofs 區塊的說明，以及「Escrow payment」「Payout」兩列的 real 旗標改為看該筆交易是否 live（「Payout」說明改為「`Released` event · `confirmTicket()`」）；WalletModal 標章（§4.2）；/checkout 側欄的 Escrow 地址（Live 顯示真地址）。`/drill` 維持模擬，原說明保留。
- 資料形狀：`ChainTx` 加 `source: "simulated" | "live"`、`explorerUrl?`、`lane?: "cosmos" | "evm"`；`BookingStep` 加 `source?`、`explorerUrl?`，Live read 步驟另帶 `readResult?`。`makeTx()` 保留，只用於 Simulated。Live 交易紀錄由 API 回應組成。sessionStorage key 維持 `flygate-demo-v1`，新欄位都有預設值，舊資料由初始狀態補齊。
- explorer 連結一律 `${QORE_EXPLORER_URL}/tx/${hash}`，base URL 由 `/api/live/status` 提供（預設 `https://explore.qore.network`）。Cosmos 交易（link、window、`MsgExecuteEVM`）用 Cosmos 雜湊；一般 EVM 交易（`setMandate`、`confirmTicket`、`cancel`）用 0x 雜湊。explorer 不認 0x 雜湊時（由探測確認），改用該 EVM 交易所在 Cosmos 交易的雜湊。`HashText` 有 `explorerUrl` 時變成連結，tooltip「Explorer: switch to Testnet」。

依據：D-06、D-20、D-21、D-22、D-23

### §4.8 Live／Simulated 切換、可用性與退回

- 切換鈕放在 PresenterPanel 的「Chain」區塊，Simulated／Live 兩段，存在 `DemoState.mode`，**預設 Simulated**。Live 模式下 Header 加「Live · diana」小標章。
- booking 進行中或簽章視窗打開時，切換鈕鎖住。`/checkout` 發現 `signed.mode !== state.mode` 時顯示空狀態「Re-sign your mandate in Live mode」。Reset demo 保留 mode。
- **`/api/live/status`** 判定 Live 可用的條件：`LIVE_MODE=on`；三組助記詞都在；§4.1 的合約地址檢查通過；EVM chain id 9800；商家 `pqcKeyStatus` 為 registered、algorithmId 1、possessionProven true，且公鑰和商家助記詞推導出的一致；owner 餘額夠付一張上限票價加手續費；relayer 與會送件的 signer 都有餘額。結果快取 30 秒，只回傳公開地址、explorer base URL 與失敗原因。讀取遇限流沿用 bootstrap 的重試方式。不可用時 Live 選項停用並顯示原因（例如「Live unavailable: FlightEscrow not deployed」）。
- **不做無聲自動退回**。Live 步驟遇 30 秒逾時、RPC 錯誤或 revert 時，該步驟標 failed 並顯示鏈上錯誤碼；callout 提供「Finish in Simulated mode」，按下後切到 Simulated，從失敗那一步接著跑完：之後步驟標「Simulated tx」，已上鏈步驟保留「Live tx」。/mandate 失敗時提供「Sign in Simulated mode instead」。
- 失敗發生在 `lock` 成功之後：畫面顯示 bookingId，提示「Refunds after the ticket window」。新增 `pnpm live:sweep`：找出已過期限、仍是 Locked 的 booking，逐一呼叫 `refund()`，錢一律退回 owner。

依據：D-02、D-24、D-25、D-26、D-27

### §4.9 冪等、跨回合狀態與節奏

- **廣播一律不重試**，只有讀取可以重試（沿用 bootstrap 規則）。
- 伺服器在記憶體以 `(step, bookingId)` 為 key 存冪等表；同一個 key 再進來直接回傳上次結果，不重送。`bookingId` 在送出前就能從 quote 算出（共用編碼模組的 `bookingId()`）。/mandate 的三筆交易也以等價的 key（例如 mandate hash + step）冪等。
- client 把步驟的 running 狀態和 bookingId 存在 sessionStorage；重新整理後向伺服器查這筆 booking 的狀態（從 `Booked`、`Released`、`Refunded` 事件推導；authenticator 通道沒有可查的 `Booked`，改用 owner 帳號成功執行的 `MsgExecuteEVM` `book()`，D-29），而不是再送一次。
- 每筆交易等到上鏈才算完成（SDK 廣播後等待；diana 約 1 秒出塊）。每個步驟保留原本的最短動畫時間；每步最多等 30 秒，逾時進入 §4.8 的退回流程。Speed 在 Live 模式只影響動畫。

依據：D-28、D-30

### §4.10 程式結構（模組邊界）

- 瀏覽器端的 chain 模組只留瀏覽器也能安全使用的內容（常數、`shortAddr`、模擬 helper），加一個 **`ChainPort` 介面**：`setupMandate`、`lockFunds`、`confirmTicket`、`cancelBooking`、`checkFareCap`、`status`。兩份實作：`simulatedChain`（用 `makeTx`）與 `liveChain`（fetch `/api/live/*`）。頁面依 `state.mode` 取得對應實作；`checkout`、`mandate` 頁面只改 switch 裡跟鏈有關的幾個 case，畫面元件盡量不改。
- 伺服器端：一個 server-only 的 **Live 服務**，對外操作與 `ChainPort` 一一對應（setupMandate、lockFunds、confirmTicket、cancelBooking、checkFareCap、status、查 booking 狀態），內部依賴一個**伺服器端鏈介面**（廣播 Cosmos 訊息、送 EVM 交易、`eth_call`、`eth_getLogs`、讀餘額與 PQC 狀態）。正式實作用 `@qorechain/sdk`／viem 連 diana；測試用 `FakeChain`。Live 服務在建立時接收鏈介面、設定（環境變數）與時鐘，Route Handlers 只是把 HTTP 請求轉成服務呼叫的薄轉接層（含 `LIVE_MODE` 404 檢查與參數驗證）。
- 新增 package scripts：`live:probe`、`live:sweep`、`check:bundle`，以及跑 node:test 的測試指令（沿用 ticket/13 的 `test:scripts` 寫法）。

依據：D-07、D-08、D-31、D-33

## §5 Testing Decisions

- **測試 seam（假設，待使用者審查）**：唯一的自動化 seam 是**伺服器端 Live 服務的對外操作**（§4.10，與 `/api/live/*` 一一對應），唯一的測試替身是邊界上的 **`FakeChain`**（實作伺服器端鏈介面，記錄每一次廣播與讀取，可設定回傳成功、revert、逾時、執行失敗）。選這個 seam 是因為它是不碰 Next.js runtime 與測試網的最高點：Route Handlers 只是薄轉接層，瀏覽器端 `liveChain` 只是 fetch。使用者不在場，這個選擇由 agent 依 D-33 自行決定，標為待審查的假設。
- 好的測試只斷言外部可觀察的結果：服務回傳的步驟結果（source、雜湊、explorer URL、錯誤碼），以及 `FakeChain` 收到的廣播／讀取清單與其解碼後的參數；不斷言內部函式怎麼切。
- 必測案例（透過同一個 seam）：
  - Ticketed：剛好 2 筆廣播（`book` 經 `MsgExecuteEVM`、`confirmTicket` 經 EOA），release 回傳與 proof 同一筆雜湊。
  - Fare jumps：0 筆廣播、1 次 `book()` 的 `eth_call`（回傳 `FareOverCap`）、前後各 1 次餘額讀取。
  - Booking fails：`book` + `cancel` 2 筆廣播，CancelProof 的 reasonCode 為 1。
  - /mandate：link → window → `setMandate` 的順序；支出規則的 `allowedEvmCalls` 只含 `book()` selector；`perTxLimit`、`dailyLimit`、window `maxValue`、`blocks` 依 §4.4 計算；鏈上 `maxTickets = used + mandate.maxTickets`；log 查不到時失敗而不猜。
  - 對應與換算（透過 `FakeChain` 收到的 calldata 斷言）：US$389 → 3.89 QOR 的 `priceWei`、城市代碼、unix day、cabin、`offerId`、`ticketWindow` 600。
  - 同一個冪等 key 送兩次只廣播一次；廣播失敗不重試。
  - 執行失敗（code 0 但 authenticator 執行失敗）不標「Live tx」並帶錯誤碼；逾時回傳 failed。
  - `status`：合約地址缺少／不合法／無 code／chain id 錯誤／商家金鑰不符／餘額不足時回報不可用並帶原因；回應不含任何金鑰材料。
- 若某個純函式（例如 explorer URL、US$ 換算）透過 seam 不好觀察，允許用 node:test 直接測它（D-33 (1)），但不為此另開新 seam。
- 測試工具：`node:test` + `tsx --test`，沿用 ticket/13 `test:scripts` 的寫法；因為 Live 模組第一行是 `import "server-only"`，測試要用 `react-server` 匯出條件執行（或等價設定），讓它解析成空模組。
- `pnpm check:bundle`（§4.2）屬 build 層級的檢查，不是程式 seam。
- 合約行為交給 #9–#12 的 Foundry 測試，本功能不重複測。
- Prior art：#7 的 Foundry 測試（只在邊界放替身：mock 預編譯）、`contracts/test/ffi` 的 TS 編碼交叉驗證、ticket/13 的 node:test 腳本測試。
- 手動驗收（不進 CI，D-01 B 段）：一份 diana runbook，三種情境各跑一次，explorer 連結記進流程文件；`pnpm live:probe` 結果也記在同處。

依據：D-01、D-07、D-11、D-28、D-33

## §6 Out of Scope

- `/drill` 的真攻擊交易；鏈上撤銷 agent（`revokeMandate`、`MsgRevokeAuthenticator`）。`/drill` 在 Live 模式維持模擬。
- Duffel API、Claude 解析（order、ticket 步驟維持模擬）。
- 真正的 QoreX 錢包整合。
- 主網、ERC-20。
- 修改 FlightEscrow 合約（包括加 `ticketsUsed` 查詢函式、改退款對象）。
- 改用 `refund()` 的逾期退款 Demo 流程（只做 `pnpm live:sweep` 清理腳本）。
- 修改瀏覽器常數中的假 escrow 地址、部署合約（屬於 #14）。
- 把 Live 部署到公開主機。

依據：D-03、D-08、D-21、D-34

## §7 Further Notes

- **B 段驗收（#14 部署後）**：設定 `FLIGHT_ESCROW_ADDRESS`／`FLIGHT_ESCROW_DEPLOY_BLOCK`，跑 `pnpm live:probe`，依 runbook 在 diana 跑完三種情境，確認每個鏈上步驟都有 explorer 查得到的交易、Fare jumps 錢沒動、Booking fails 錢退回，記錄進流程文件。
- **需優先審查的決策**：跨功能衝突 D-03（與 #14 前端範圍重疊）、D-14（與 #7「1 QOR = US$1」不同）；假設 × 影響高 D-06、D-08、D-10、D-11、D-26、D-29。ADR-0001、ADR-0002 都是 Proposed。
- **探測可能推翻的內容**：§4.3 的 lane 與 `msg.sender`、§4.4 的 window 開在誰身上、§4.7 的 0x 雜湊連結。實作時探測結果若與本 spec 不符，以探測為準並在 PR 描述說明，必要時用 /revise-decision 更新決策。
- 測試 seam（§5）是 agent 的假設，待使用者審查。
- 現有 SDK 文件位置（實作參考，非決策）：`@qorechain/sdk` 型別定義中的 EVM lane、`executeEvmMsg`、`linkAuthenticatorMsgs`、`assertAuthenticatorExecutionsSucceeded`、`SpendingRule`、`OpenEvmWindowParams`。
- Next.js 16 的 Route Handlers、環境變數、server-only 規則以 repo 內 `node_modules/next/dist/docs/` 為準。

依據：D-01、D-03、D-06、D-08、D-10、D-11、D-14、D-26、D-29、D-33
