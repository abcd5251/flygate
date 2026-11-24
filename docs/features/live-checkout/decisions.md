# live-checkout：決策紀錄

> 功能：/mandate 與 /checkout 接上 diana 測試網真交易，加 Live／Simulated 切換。
> 原始需求：`docs/features/live-checkout/request.md`。
> 進行方式：auto-grill，提問者與回答者在同一個 session 嚴格輪替（先寫問題與分支，再切換成回答者作答）。使用者不在場，所有題目由回答者自動作答。`FEATURES.md` 的 `escalate: off`，所以沒有「待確認」題目。
> 證據時點：2026-11-24，分支 `feat/live-checkout`（從本機 `feat/flight-escrow` 157cab1 開出）。

## 摘要
- 題數：34（程式碼 16／文件 9／假設 9）
- 需優先審查：6 題（假設 × 影響高）、2 題（跨功能衝突）

## 審查清單（依優先順序）
1. 跨功能衝突：D-03、D-14
2. 假設 × 影響高：D-06、D-08、D-10、D-11、D-26、D-29
3. 假設 × 影響中低：D-02、D-24、D-25

## 設計樹（分支總覽）

1. 範圍與相依：D-01～D-04
2. 簽章與金鑰位置：D-05～D-08
3. 帳號拓樸與送件路徑（lane）：D-09～D-13
4. 金額單位與資料對應：D-14～D-15
5. 情境對應到鏈上結果：D-16～D-19
6. 畫面標籤與交易連結：D-20～D-23
7. Live／Simulated 切換與退回：D-24～D-27
8. 冪等與跨回合狀態：D-28～D-30
9. 程式結構：D-31～D-32
10. 測試與範圍外：D-33～D-34

所有分支都已有結論，沒有達到 40 題上限。

## 決策

### D-01 合約還沒部署（#14 未完成），本功能這次要交付到哪裡？
- 分支：範圍與相依 > 交付邊界
- 回答：分兩段。**A 段（現在就做、可以開 PR）**：Live 轉接層、伺服器端 route handlers、Live／Simulated 切換、標籤改寫、退回機制，以及不依賴測試網的自動測試（用假的鏈實作）。**B 段（等 #14 部署並跑完 e2e 之後）**：在 diana 上實際跑一次 Demo 的三種情境，把 explorer 連結記進 `docs/FLOW.md`。需求的完成標準「每個鏈上步驟都有可以在區塊瀏覽器查到的交易」列為 B 段驗收。B 段完成前，PR 描述要明寫這一項還沒驗收。合約沒有地址時，Live 會被停用，Demo 照樣用 Simulated 跑完（見 D-02）。
- 依據：【文件】`docs/features/live-checkout/request.md`「/ship 啟動時查到的實際狀態」；GitHub #14（OPEN，驗收項目全部未勾）
- 信心：高
- 影響程度：高（決定這次 PR 能宣稱完成哪些事，也決定驗收怎麼排）
- 考慮過的其他選項：等 #14 完成才開工（會卡住整條 pipeline）；自己先部署一份合約（會和 #14 搶部署，留下兩個地址）
- 衝突：無
- 狀態：有效
- 影響到：spec 開頭（相依與交付）、spec §1、spec §2、spec §4.1、spec §5、spec §7、#26

### D-02 Live 模式從哪裡讀合約地址？缺地址時怎麼辦？
- 分支：範圍與相依 > 合約地址
- 回答：從伺服器環境變數 `FLIGHT_ESCROW_ADDRESS` 讀取（放在 `.env.local`，`.env.example` 加一個空白欄位）。另外新增 `FLIGHT_ESCROW_DEPLOY_BLOCK`，給 D-29 查 log 用。以下任何一種情況，Live 都判定為「不可用」，`/api/live/status` 會回傳原因：沒設定、不是合法的 0x 地址、`eth_getCode` 回傳空值、EVM chain id 不是 9800。切換鈕會停用，並顯示「Live unavailable: FlightEscrow not deployed」。Live 模式不能拿 `ADDRESSES.escrow` 的假地址當預設值。
- 依據：【假設】repo 裡還沒有部署紀錄的格式或路徑（#14 只說要寫一份 deployment record）。`src/lib/chain.ts:20` 的 escrow 是假地址
- 信心：中
- 影響程度：中（只是設定來源，改成讀部署紀錄檔的成本很低）
- 考慮過的其他選項：讀 #14 產生的部署紀錄檔（格式還沒定）；寫死在 `chain.ts`（需要改程式碼才能換地址，而且會和 #14 衝突，見 D-03）；`NEXT_PUBLIC_` 變數（地址本身是公開資料，但不能在執行期更換）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.1、spec §4.8、#19

### D-03 #14 的範圍也包含「換掉 `ADDRESSES.escrow`、把 release 步驟改成對應 `confirmTicket` 裡的 `Released` 事件」，和本功能要改的 `chain.ts`／`booking.ts` 重疊，怎麼分工？
- 分支：範圍與相依 > 與 flight-escrow 的重疊
- 回答：本功能**不改** `ADDRESSES.escrow` 這個常數。Simulated 模式繼續用它當畫面上的佔位地址，Live 模式改用 D-02 的地址。release 與 refund 步驟的說明文字直接採用 #14 和 #7 已經寫好的寫法：release 是「`Released` event · `confirmTicket()`」，失敗退款是「`FlightEscrow.cancel()`」（見 D-18）。兩邊誰先合併，另一邊在合併時採用同一段文字。PR 描述要列出這個重疊。
- 依據：【文件】GitHub #14「Small frontend changes」；#7「Frontend touch points (minimal)」；`src/lib/booking.ts:11-12`
- 信心：中
- 影響程度：高（跨功能衝突）
- 考慮過的其他選項：本功能直接接手 #14 的前端小改動（會改到別人的驗收項目）；等 #14 合併後再改文字（拖慢本功能）
- 衝突：與 flight-escrow（issue #14，尚未登錄在 DECISIONS-INDEX）的前端改動範圍重疊
- 狀態：有效
- 影響到：spec 開頭（相依與交付）、spec §4.1、spec §6、spec §7、#18

### D-04 PR #8 和 `feat/flight-escrow` 都還沒合併，`ticket/13-evm-keys` 的 EVM 金鑰 helper 也還沒併進 `feat/flight-escrow`。本功能怎麼處理這些相依？
- 分支：範圍與相依 > 未合併分支
- 回答：`feat/live-checkout` 維持從 `feat/flight-escrow` 往下長。需要 `scripts/evm/keys.ts`（每個角色的 coin-60 signer）時，等 ticket/13 併進 `feat/flight-escrow` 後再 merge 進來，不要複製程式碼。PR 開向 `develop`，描述裡寫明合併順序：#8 → flight-escrow → live-checkout。
- 依據：【文件】使用者記憶「PR base is develop」；`git log feat/flight-escrow..ticket/13-evm-keys` 有 2 個 commit 還沒合併；PR #8 是 OPEN
- 信心：高
- 影響程度：中（只影響合併順序與 diff 大小）
- 考慮過的其他選項：把 keys.ts 複製進來（之後會有兩份）；直接 merge ticket/13（會繞過 flight-escrow 的整合）
- 衝突：無
- 狀態：有效
- 影響到：spec 開頭（相依與交付）、spec §4.1、#17、#19

### D-05 Live 模式的鏈上交易要在哪裡簽：瀏覽器、Next.js 伺服器的 route，還是腳本？
- 分支：簽章與金鑰位置 > 簽章位置
- 回答：**全部在 Next.js Route Handlers 簽**（`src/app/api/live/*/route.ts`，Node runtime）。私鑰從伺服器端環境變數 `OWNER_MNEMONIC`、`AGENT_MNEMONIC`、`MERCHANT_MNEMONIC` 推導，這三個變數已經在 `.env.local` 裡，絕不加 `NEXT_PUBLIC_` 前綴。瀏覽器端完全不 import `@qorechain/sdk`。瀏覽器只保留現在的 Demo 用 ML-DSA-87 簽章與 ML-KEM 加密（`src/lib/pq.ts`），也就是畫面上標「Real crypto」的部分。腳本只用來做 diana 探測（D-11）和事後清理（D-26），不負責 Demo 流程本身。
- 依據：【文件】`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`（沒有 `NEXT_PUBLIC_` 前綴的變數只存在於 Node 環境）；`docs/FLOW.md`「瀏覽器打包結論」（SDK gzip 後約 560 KB，agent／商家金鑰原本就規劃放在伺服器端）；#2 user story 23（助記詞不能外流）
- 信心：高
- 影響程度：高（決定金鑰邊界與整體架構，見 ADR-0001）
- 考慮過的其他選項：owner 在瀏覽器用助記詞簽（等於把助記詞送進瀏覽器，否決）；接真正的 QoreX 錢包（目前沒有整合，範圍太大）；先用腳本跑完，畫面只顯示事先錄好的雜湊（就不是 Live 了，否決）
- 衝突：無
- 狀態：有效
- 影響到：spec §1、spec §2、spec §3、spec §4.2、#19

### D-06 Live 模式下沒有真錢包，owner 的「Sign with QoreX」實際上由誰簽？畫面要怎麼誠實標示？
- 分支：簽章與金鑰位置 > owner 簽章
- 回答：簽章視窗（WalletModal）的介面不變。前兩步仍在瀏覽器做真的 ML-DSA-87 簽章和 ML-KEM 加密。之後的鏈上交易由伺服器用 `OWNER_MNEMONIC` 代簽，當作 QoreX 錢包的替身。Live 模式下，WalletModal 標題列的「Simulated」標章改成「Demo owner key (server)」，每個鏈上步驟顯示真的交易雜湊。Simulated 模式不變。
- 依據：【假設】repo 裡沒有錢包整合。`src/components/WalletModal.tsx:22` 註明這是模擬錢包
- 信心：中
- 影響程度：高（伺服器會用 owner 的帳號送出真的交易，屬於外部副作用；也關係到對評審講的話是否屬實）
- 考慮過的其他選項：Live 模式跳過 owner 的鏈上步驟，只讓 agent 送交易（做不到需求裡的授權階段）；把標章拿掉（不誠實）；請 presenter 在終端機手動跑一支腳本（打斷 Demo）
- 衝突：無
- 狀態：有效
- 影響到：spec §1、spec §2、spec §3、spec §4.2、spec §4.7、spec §7、#20

### D-07 用什麼機制確保私鑰和助記詞不會進到瀏覽器 bundle 或 git？
- 分支：簽章與金鑰位置 > 防外洩
- 回答：三道防線。(1) 所有伺服器端 Live 模組放在 `src/server/live/`，第一行 `import "server-only"`（新增 `server-only` 套件，目前 node_modules 裡沒有）。client component 誤 import 這些模組時，build 會直接失敗。(2) 新增 `pnpm check:bundle`：`next build` 之後掃描 `.next/static`，出現 `MNEMONIC`、`qorechain-evm-auth`、`@qorechain/sdk` 這幾個特徵字串就失敗。(3) `.gitignore` 已經排除 `.env*`，只放行 `.env.example`，`.env.example` 只列變數名稱。API 回應只回傳公開資料（地址、雜湊、錯誤碼），不回傳任何金鑰材料。
- 依據：【文件】`node_modules/next/dist/docs/01-app/02-guides/data-security.md`「Preventing client-side execution of server-only code」；`.gitignore`（`.env*`、`!.env.example`）
- 信心：高
- 影響程度：高（金鑰外洩就無法挽回）
- 考慮過的其他選項：只靠變數不加 `NEXT_PUBLIC_`（只要有人在 client 端 import 就破功）；React taint API（還是 experimental）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.2、spec §4.10、spec §5、#19

### D-08 會代簽交易的 Live routes，被當成任何人都能用的「簽章服務」怎麼辦？
- 分支：簽章與金鑰位置 > 濫用防護
- 回答：只有伺服器環境變數 `LIVE_MODE=on` 時，Live routes 才會啟用，否則一律回 404。Live 只用在 presenter 本機跑 `pnpm dev` 或 `pnpm start` 的場合，不部署到公開主機。routes 只接受結構化參數（`offerId`、`scenario`、`bookingId`），quote、calldata、金額都由伺服器自己從 `DEMO_OFFERS` 和 mandate 組出來。client 端不能送任意 calldata 或指定收款人。
- 依據：【假設】repo 沒有部署設定；`docs/FLOW.md` 沒有提到 Demo 要公開部署
- 信心：中
- 影響程度：高（一旦被濫用，owner 帳號的測試幣會被花掉）
- 考慮過的其他選項：加 API token（presenter 要多管一個秘密）；只檢查 localhost 的 Host 標頭（容易被繞過）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.2、spec §4.10、spec §6、spec §7、#19

### D-09 鎖款 `FlightEscrow.book()` 走哪一條送件路徑？誰簽、誰付手續費、錢從哪個帳號出？
- 分支：帳號拓樸與 lane > book 的路徑
- 回答：照需求走 **authenticator lane 的 `MsgExecuteEVM`**。
  - agent 金鑰是 agent 助記詞的 coin-60 secp256k1 金鑰，以 20-byte ETH 地址綁定，scheme 是 `secp256k1`，用 `signAuthenticatorLinkEip191` 產生擁有證明。
  - agent 對 `evmAuthSignBytesV2` 簽章（用 `resolveEvmAuthDigestVersion` 確認 diana 要的 digest 版本，nonce 用 `fetchAuthNonce` 讀）。
  - **relayer** 是 agent 的 bootstrap 帳號（coin-118 qor1，已註冊 ML-DSA-87，也有餘額），負責混合簽章並付手續費。
  - 合約呼叫從 **owner 帳號的 0x 地址**發出，所以 `msg.value` 真的從 owner 的錢包出。
  - 廣播後一定呼叫 `assertAuthenticatorExecutionsSucceeded`，因為 code 0 的交易也可能是一次失敗的執行。
- 依據：【程式碼】`node_modules/@qorechain/sdk/dist/index.d.ts` 第 3185 行附近（EVM lane：「an EVM call/transfer from the account's 0x address」）、第 14666 行 `executeEvmMsg`（relayer 廣播並付費）、第 14863 行 `linkAuthenticatorMsgs`、第 14911 行 `assertAuthenticatorExecutionsSucceeded`；`ticket/13-evm-keys` 的 `scripts/evm/keys.ts`（account 與 signer 是兩個不同的地址）
- 信心：中（SDK 文件寫得很清楚，但還沒在 diana 上實測過）
- 影響程度：高（會從 owner 帳號送出真的付款）
- 考慮過的其他選項：agent 的 coin-60 EOA 直接送 EVM 交易（#14 e2e 的路徑，錢會從 agent 出而不是 owner，而且沒有用到需求指定的 `MsgExecuteEVM`，所以留作退路，見 D-11）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.3、#17、#20、#21

### D-10 合約把退款付給 `setMandate` 的呼叫者，但 owner 帳號的 0x 地址沒有 EVM 私鑰能簽（#13 的發現）。那 `setMandate` 由誰送、錢退到哪裡？
- 分支：帳號拓樸與 lane > mandate 與退款去向
- 回答：
  - `setMandate(agent, mandate)` 由 **owner 的 coin-60 EVM signer** 以一般 EVM 交易送出。
  - `agent` 參數填 **owner 帳號的 0x 地址**，因為在 D-09 的路徑下，`book()` 的 `msg.sender` 就是這個地址。
  - 合約記下的 `owner`，也就是退款去向，是 owner 的 EVM signer。
  - 畫面上這兩個地址都標成「your wallet」，分成「付款：owner 帳號 qor1…／0x…」與「退款：owner EVM 地址 0x…」兩行，不假裝它們是同一個地址。
  - 驗收「錢退回」時，比對的是退款地址的餘額變化。
- 依據：【假設】從 `contracts/FlightEscrow.sol:175-182`（`m.owner = msg.sender`）、`:280-285`（`_send(b.owner, …)`），以及 ticket/13 `scripts/evm/keys.ts` 的註解（coin-118 帳號沒有 EVM 私鑰）推論而來，還沒在鏈上驗證
- 信心：低
- 影響程度：高（決定真錢的流向，也決定 Demo 敘事。見 ADR-0002）
- 考慮過的其他選項：改合約，退款改付給下單的付款人（屬於 #7 的範圍，而且合約已經完成測試）；owner 另外綁一把自己的 key，透過 `MsgExecuteEVM` 送 `setMandate`（支出規則是整個帳號共用，agent 也會因此能呼叫 `setMandate`、自己調高上限，否決）；整個改走 EOA lane（D-11 的退路）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.3、spec §4.4、spec §7、#17、#20、#23、#25

### D-11 D-09 和 D-10 依賴的鏈上行為都還沒驗證過（`MsgExecuteEVM` 的 `msg.sender` 是誰、coin-60 signer 送 EVM 交易前是否也要註冊 PQC 並開 window、`allowedEvmCalls` 能不能限制到函式 selector）。怎麼降低風險？
- 分支：帳號拓樸與 lane > 未驗證的事實
- 回答：實作的**第一張 ticket 是 diana 探測腳本** `pnpm live:probe`。它用小額交易和一份臨時部署的探測合約（或 #14 的合約）確認四件事：
  1. `MsgExecuteEVM` 的 `msg.sender`。
  2. coin-60 signer 送 EVM 交易需要哪些前置條件。
  3. 帶 selector 的 `allowedEvmCalls` 有沒有效。
  4. explorer 認不認 0x EVM 交易雜湊（D-23）。

  結果寫進 `docs/FLOW.md` 的「diana 測試網實測記錄」。轉接層保留 `lane: "authenticator" | "eoa"` 這個設定點。探測證明 authenticator lane 走不通時，退回 #14 e2e 驗證過的 EOA lane（agent 的 coin-60 EOA 直接呼叫 `book()`），畫面上改標「agent EOA」，並在 PR 描述說明為什麼偏離需求。
- 依據：【假設】`node_modules/@qorechain/sdk/dist/index.d.ts` 的 window 模組說明（第 3440 行附近：「From v3.2.0 an EVM transaction is admitted only from an account that holds a registered ML-DSA key AND has opened a bounded authorisation window」）是否也適用於 coin-60 signer，目前不清楚
- 信心：中
- 影響程度：高（探測時會送出真交易；探測結果也可能推翻 D-09、D-10、D-12）
- 考慮過的其他選項：直接照 D-09 寫完再上鏈除錯（失敗成本會落在 Demo 前夕）；只做 EOA lane（不符合需求）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.3、spec §5、spec §7、#17、#21、#26

### D-12 `openEvmWindowMsg` 的 window 開在誰身上？範圍怎麼設？和其他交易的先後順序？
- 分支：帳號拓樸與 lane > scoped window
- 回答：
  - sender 是 owner 帳號（qor1）。
  - `allowedTargets = [FlightEscrow 地址]`。
  - `maxTxs = mandate.maxTickets`。
  - `maxValue` 等於「每張票上限加上最大手續費」乘上 `maxTickets`，單位 uqor，無條件進位。
  - `blocks` 取 3,600 和「距離 mandate 到期的區塊數」兩者中較小的值，約 1 小時。
  - 交易順序固定為：link（Cosmos 交易）→ open window（Cosmos 交易）→ `setMandate`（EVM 交易）。原因是開 window 會推進 EVM nonce，EVM 交易必須在開完之後才簽。

  如果 D-11 探測發現 window 管不到 `MsgExecuteEVM`，仍然開 window（需求有指定），但 /mandate 規則表裡「Scoped window · allowedTargets／maxTxs」兩列的說明，要改成它實際管住的東西，不能宣稱它擋住了 agent。
- 依據：【程式碼】`node_modules/.pnpm/@qorechain+evm@0.14.0…/dist/window.d.ts:44-69`（`OpenEvmWindowParams`）；SDK `index.d.ts` 第 3440 行附近（「Opening a window advances the EVM nonce」、「maxValue bounds value PLUS the maximum fee」、「blocks is a block count」）；`src/lib/mandate.ts:203-208`（規則表）
- 信心：中
- 影響程度：高（owner 帳號會送出真的交易）
- 考慮過的其他選項：window 開在 owner 的 EVM signer 身上，只為了放行 `setMandate`（要等 D-11 探測結果才知道需不需要，探測可能改成這個做法）；`blocks` 開到上限 17,280（約 5 小時，範圍太寬）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.4、#17、#20

### D-13 `linkAuthenticatorMsgs` 的支出規則和權限參數要怎麼設？
- 分支：帳號拓樸與 lane > 支出規則
- 回答：
  - `owner` 是 owner 的 qor1，`account` 省略（預設等於 owner）。
  - `scheme` 是 `secp256k1`，`pubkey` 是 agent ETH 地址的 20 bytes。
  - `permissions = ["evm"]`，`expiryUnix` 等於 mandate 的 `expiresAt`，同時帶 `chainId: "qorechain-diana"`，讓 SDK 先在本地驗證擁有證明。
  - 只放一條 `spendingRule`：
    - `perTxLimit` 是票價上限換算成 uqor（D-14）。
    - `dailyLimit` 是 `perTxLimit × maxTickets`。
    - `allowedEvmCalls = ["0x<escrow>/0x<book() selector>"]`，**只放行 `book()`**，絕不包含 `setMandate` 或 `revokeMandate`。
    - `enabled = true`。
  - `MsgUpdateSpendingRules` 會整批取代規則，所以每次都送完整的一份。
- 依據：【程式碼】SDK `index.d.ts` 第 7256-7295 行（`SpendingRule`：`perTxLimit`、`dailyLimit`、`allowedEvmCalls` 的 selector 格式）、第 14821-14863 行（`LinkAuthenticatorMsgsInput`，以及「REPLACES the account's rules wholesale」）
- 信心：中
- 影響程度：高（這組規則決定 agent 金鑰外洩時能造成多少損失）
- 考慮過的其他選項：只放行整個合約 `0x<escrow>`（agent 就能呼叫 `setMandate`，否決）；`permissions = ["all"]`（範圍太大）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.4、#17、#20

### D-14 Live 模式下，US$ 票價要換算成多少 QOR？
- 分支：金額單位與資料對應 > 換算比例
- 回答：Live 模式用 **1 US$ = 0.01 QOR**，可以用伺服器環境變數 `LIVE_QOR_PER_USD` 調整。畫面上仍然顯示 US$389，旁邊加註「≈ 3.89 QOR on diana」。合約裡的 `maxFareWei` 和 `priceWei` 用同一個比例換算。原因：bootstrap 之後 owner 只剩約 60 QOR，水龍頭每 24 小時只給 100 QOR，照 1:1 換算的話，一張 US$389 的票根本付不起。
- 依據：【文件】#2 user story 13、14（owner 分完錢後約剩 60 QOR）；`docs/FLOW.md`「水龍頭」那一列；#7「UI convention is 1 QOR shown as US$1」
- 信心：高
- 影響程度：高（跨功能衝突，而且換算比例會寫進鏈上金額）
- 考慮過的其他選項：沿用 1:1（餘額不夠）；把 Demo 票價改成 US$3.89（畫面會不像真的訂票網站）；多領幾天水龍頭（還是不夠，而且要手動登入）
- 衝突：與 flight-escrow（issue #7 Implementation Decisions「1 QOR shown as US$1」，尚未登錄在 DECISIONS-INDEX）不一致。#7 的慣例只用在它自己的 e2e 腳本，本功能只在 Live 畫面上換算，不改合約
- 狀態：有效
- 影響到：spec §3、spec §4.5、spec §7、#20、#21

### D-15 Demo 的 Offer 和 Mandate 要怎麼對應到合約的 `Quote` 與 `Mandate` 結構？
- 分支：金額單位與資料對應 > 結構對應
- 回答：
  - `offerId` 是 `keccak256(utf8(offer.id))`。
  - `origin`／`destination` 用 mandate 的城市代碼（TPE／TYO），不用機場代碼。
  - `departDay` 是 `offer.date` 的 UTC 午夜除以 86,400。`departFrom`／`departTo` 用同樣的換算方式。
  - `cabin` 的對應：economy 是 0，premium 是 1，business 是 2。
  - `refundable` 直接用 `offer.refundable`。
  - `expiresAt` 是現在時間加 20 分鐘，和 Simulated 的 `validUntil` 一樣。
  - `ticketWindow` 是 600 秒。
  - `merchant` 是商家 bootstrap 帳號的 0x 地址（`pqcKeyStatus` 查得到它）。`agent` 依 D-09／D-10 的路徑填入。
  - `mandateHash` 是現在 `signed.hash`（瀏覽器端算出的 SHA-256，32 bytes）。
  - 鏈上 `maxTickets` 的值依 D-29 計算。
  - 編碼全部走 `src/lib/escrow.ts`，不另外寫一套。
- 依據：【程式碼】`contracts/FlightEscrow.sol:65-93`；`src/lib/escrow.ts:43-55`、`:108-118`；`src/lib/mandate.ts:34-47`；`src/app/checkout/page.tsx:46-55`；#7「city codes, not airport codes」
- 信心：中
- 影響程度：高（這些值直接進鏈上的簽章訊息，對應錯了 `book()` 會 revert）
- 考慮過的其他選項：`ticketWindow` 設 120 秒（Demo 的節奏抓太緊，驗證步驟一卡住就可能過期）；`offerId` 直接塞 ASCII（長度不固定）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.5、#20、#21

### D-16 「Ticketed」情境的 8 道關卡，哪幾道會送真交易？
- 分支：情境對應 > Ticketed
- 回答：
  - `quote`：伺服器用商家金鑰，對鏈上格式的 Quote 做真的 ML-DSA-87 簽章，不送交易。
  - `verify`：對 `0x…0a01` 的 `pqcVerify` 做 `eth_call`，屬於鏈上唯讀查詢，標「Live read」，沒有交易雜湊。
  - `rules`：照舊用 `gate.ts` 在鏈下檢查。
  - `lock`：**真交易**，`MsgExecuteEVM` → `book()`。
  - `order`、`ticket`：照舊模擬 Duffel 與 PNR。
  - `proof`：**真交易**，商家簽 TicketProof，送出 `confirmTicket()`。
  - `release`：不另外送交易，顯示和 `proof` 同一筆雜湊，說明文字是「`Released` event」。

  所以 Ticketed 情境總共 2 筆真交易，加上 /mandate 的 3 筆（D-12）。
- 依據：【程式碼】`src/app/checkout/page.tsx:61-166`；`contracts/FlightEscrow.sol:231-241`（`confirmTicket` 在同一筆交易裡放款）；#14「map the release step … to the Released event」
- 信心：高
- 影響程度：高（決定哪些步驟會送出真交易）
- 考慮過的其他選項：`verify` 也送一筆交易（`pqcVerify` 是 view 函式，送交易沒有意義，還要付手續費）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.6、#21、#22、#23

### D-17 「Fare jumps」在鏈上要呈現什麼？需求說「錢沒動」。
- 分支：情境對應 > Fare jumps
- 回答：商家照樣簽一份 US$428 的 quote，閘門在 `lock` 之前就擋下，**不送任何交易**。現在 Simulated 模式那筆「Backup on-chain check: overspend rejected」的假交易，在 Live 模式改成對 `book()` 做 `eth_call` 模擬：帶入 428 的 quote 與等額 value，從 lane 的 sender 發出，畫面顯示合約回傳 `FareOverCap(maxFareWei, priceWei)`，標「Live read」，不附雜湊。另外在檢查前後各讀一次 owner 的鏈上餘額，畫面顯示「Balance unchanged: x QOR」。不送一筆會 revert 的真交易，因為那樣會花手續費，錢就算動了。
- 依據：【程式碼】`src/app/checkout/page.tsx:82-89`；`contracts/FlightEscrow.sol:202-203`、`:270`（`WrongPayment` 先檢查，接著才是 `FareOverCap`）
- 信心：中
- 影響程度：中（只有讀取，沒有外部副作用）
- 考慮過的其他選項：送一筆會 revert 的 `book()` 拿到 explorer 連結（會花手續費，違反「錢沒動」）；什麼都不查（少了鏈上證據）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.6、#22

### D-18 「Booking fails」在鏈上怎麼退款？用 `refund()` 還是 `cancel()`？
- 分支：情境對應 > Booking fails
- 回答：用 **`cancel()`**。流程：`lock` 真的鎖款 → `order` 模擬 Duffel 失敗 → 商家簽 `CancelProof{bookingId, reasonCode: 1}`（1 代表 offer_no_longer_available）→ 送出 `cancel()` 交易 → 合約發出 `Refunded(Cancelled)`。refund 步驟顯示 `cancel` 交易的雜湊，並讀一次 D-10 的退款地址餘額，確認錢回來了。`refund()` 要等 ticketWindow（至少 60 秒）過期才能呼叫，不適合 Demo 節奏，只留給 D-26 的事後清理。兩種模式的 `STEP_META.refund.msg` 都改成「`FlightEscrow.cancel()`」，因為 Simulated 本來就應該模仿真實流程。
- 依據：【程式碼】`contracts/FlightEscrow.sol:247-264`；`src/lib/booking.ts:12`；`src/app/checkout/page.tsx:101-126`
- 信心：高
- 影響程度：高（會送出真的退款交易）
- 考慮過的其他選項：`refund()` 加上把 ticketWindow 設成 60 秒並等待（Demo 要乾等一分鐘）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.6、#18、#23、#25

### D-19 `confirmTicket()` 和 `cancel()` 由誰送出交易？
- 分支：情境對應 > proof 的提交者
- 回答：合約允許任何人呼叫這兩個函式，權限只來自商家簽章。所以由伺服器用 **agent 的 coin-60 EOA** 送出，這把金鑰和 #13 `evm:check` 規劃的送件角色一致，商家的 EVM signer 不需要另外補款。畫面上的 actor 仍然標「Merchant」，因為簽章是商家的，細節列加註「submitted by agent」。這把 EOA 送 EVM 交易需要哪些前置條件（PQC 註冊、window），由 D-11 的探測確認。
- 依據：【程式碼】`contracts/FlightEscrow.sol:229-254`（兩個函式都沒有檢查 `msg.sender`）；ticket/13 `scripts/evm/check.ts` 的 `SENDING_ROLES = ["owner", "agent"]`
- 信心：中
- 影響程度：高（會送出真交易）
- 考慮過的其他選項：商家自己的 EVM signer 送出（要另外補款，還要處理 window）；透過 `MsgExecuteEVM` 送出（`allowedEvmCalls` 只放行 `book()`，見 D-13）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.3、spec §4.6、#17、#21、#23

### D-20 畫面上的來源標章要怎麼分？需求說真交易的步驟不能再標「Simulated tx」。
- 分支：畫面標籤 > 標章
- 回答：`SourceTag` 從原本的真／假兩種，改成四種：
  - 「Real crypto」：在瀏覽器裡實際算出的簽章或加密。
  - 「Live tx · diana」：已經上鏈的交易，點了會開 explorer。
  - 「Live read」：`eth_call` 或 REST 唯讀查詢的結果。
  - 「Simulated tx」：模擬的交易。

  只有廣播後 code 為 0，而且（authenticator lane 下）執行結果也成功的交易，才能標「Live tx」。失敗的交易顯示鏈上回傳的錯誤碼，不標「Live tx」。
- 依據：【程式碼】`src/components/ui.tsx:37-39`；`src/app/checkout/page.tsx:21`、`:274`
- 信心：中
- 影響程度：中（只影響畫面，但關係到誠實標示）
- 考慮過的其他選項：只拿掉「Simulated tx」不加新標章（評審看不出哪些是真的）
- 衝突：無
- 狀態：有效
- 影響到：spec §1、spec §2、spec §3、spec §4.7、#18

### D-21 除了標章之外，還有哪些寫死的「simulated」文字要跟著模式改？
- 分支：畫面標籤 > 文字
- 回答：
  - `/checkout` 側欄的「Chain txs are simulated in this demo; signatures are real.」
  - `/ticket` Proofs 區塊的說明，以及「Escrow payment」與「Payout」兩列的 `real` 旗標（改成看交易本身是不是 live，「Payout」的說明改成「`Released` event · `confirmTicket()`」）。
  - WalletModal 的標章（D-06）。
  - `/checkout` 側欄的 Escrow 地址（Live 模式顯示 D-02 的地址）。

  `/drill` 不在本功能範圍，Live 模式下仍維持模擬，原本「Transactions are simulated」的說明保留。
- 依據：【程式碼】`grep` 結果：`src/app/checkout/page.tsx:335`、`src/app/ticket/page.tsx:34-36`、`:98`、`src/components/WalletModal.tsx:71`、`src/app/drill/page.tsx:183`
- 信心：高
- 影響程度：低（只改文字）
- 考慮過的其他選項：drill 也一起改成 Live（屬於 FLOW 接上順序的第 4 步，不是本功能）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.7、spec §6、#21

### D-22 `ChainTx` 和 `BookingStep` 的資料形狀要怎麼擴充？
- 分支：畫面標籤 > 資料形狀
- 回答：`ChainTx` 加上 `source: "simulated" | "live"`、`explorerUrl?: string`、`lane?: "cosmos" | "evm"`。`BookingStep` 加上 `source?` 和 `explorerUrl?`；Live read 步驟另外帶 `readResult?: string`。`makeTx()` 保留，只用在 Simulated 模式。Live 的交易紀錄由 API 回應組成。sessionStorage 的 key 維持 `flygate-demo-v1`，新欄位都有預設值，舊資料還原時會由 `initialState()` 補齊。
- 依據：【程式碼】`src/lib/types.ts:79-121`；`src/lib/store.tsx:36`、`:87`
- 信心：高
- 影響程度：低（只存在瀏覽器的 sessionStorage，不是公開格式）
- 考慮過的其他選項：把 key 升到 v2（會讓 presenter 正在進行的 Demo 狀態全部清空，沒有必要）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.7、#18

### D-23 交易的 explorer 連結長什麼樣子？Cosmos 交易和 EVM 交易的雜湊格式不同怎麼辦？
- 分支：畫面標籤 > explorer 連結
- 回答：一律用 `${QORE_EXPLORER_URL}/tx/${hash}`，base URL 由 `/api/live/status` 提供，預設 `https://explore.qore.network`。Cosmos 交易（link、window、`MsgExecuteEVM`）用 Cosmos 交易雜湊；一般 EVM 交易（`setMandate`、`confirmTicket`、`cancel`）用 0x 雜湊。explorer 認不認 0x 雜湊，由 D-11 的探測確認；不認的話，改用該筆 EVM 交易所在 Cosmos 交易的雜湊。`HashText` 有 `explorerUrl` 時變成連結，tooltip 提醒「Explorer: switch to Testnet」。
- 依據：【程式碼】`scripts/bootstrap/report.ts:18-21`（已經實測過 `/tx/{hash}` 路由，也知道要用 cookie 切到測試網）
- 信心：中
- 影響程度：低（連結格式隨時可以改）
- 考慮過的其他選項：用 SDK 的 `explorerTxUrl`（要先在 network 設定裡填 explorerUrl，效果一樣，多一層設定）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.7、#17、#18

### D-24 Live／Simulated 切換鈕放在哪裡？預設哪一個？
- 分支：切換與退回 > 位置與預設
- 回答：放在 Demo 控制台（PresenterPanel）的「Chain」區塊，做成 Simulated／Live 兩段切換，存在 `DemoState.mode`，**預設是 Simulated**。`/api/live/status` 回報不可用時，Live 選項停用，並顯示原因（D-27）。Live 模式下，Header 加一個小標章「Live · diana」，讓評審隨時知道現在是哪個模式。
- 依據：【假設】`src/components/PresenterPanel.tsx` 已經有 scenario 和 speed 兩個 presenter 設定，放在這裡最自然
- 信心：中
- 影響程度：低（只影響畫面）
- 考慮過的其他選項：放在 Header 讓所有人都看得到（會干擾訂票網站的外觀）；用網址參數 `?live=1`（重新整理就不見，容易忘記）
- 衝突：無
- 狀態：有效
- 影響到：spec §2、spec §3、spec §4.8、#19

### D-25 可以在流程中途切換模式嗎？已經簽好的 mandate 怎麼處理？
- 分支：切換與退回 > 切換時機
- 回答：booking 進行中、或簽章視窗打開時，切換鈕鎖住。`SignedMandate` 加上 `mode` 欄位。切換模式之後，`/checkout` 發現 `signed.mode !== state.mode`，就顯示空狀態「Re-sign your mandate in Live mode」，不會拿模擬的 mandate 去送真交易。Reset demo 時保留 mode，和 presenter 的其他設定一樣，避免每次重來都要重新切換。
- 依據：【假設】`src/lib/store.tsx:120-124`（目前的 reset 會把所有狀態清回初始值）
- 信心：中
- 影響程度：中（避免模擬 mandate 和真交易混在一起）
- 考慮過的其他選項：切換時自動補簽 Live mandate（會在 presenter 沒注意時送出交易）；Reset 時也把 mode 重設回 Simulated（presenter 容易忘記切回來）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.4、spec §4.8、#19、#20

### D-26 測試網出問題時，怎麼「切回模擬版，Demo 照常跑完」？錢已經鎖在合約裡的話怎麼辦？
- 分支：切換與退回 > 退回行為
- 回答：**不做無聲的自動退回**。Live 步驟遇到 30 秒逾時、RPC 錯誤或 revert 時，該步驟標成 failed，並顯示鏈上錯誤碼。callout 提供一個按鈕「Finish in Simulated mode」，按下後切到 Simulated，從失敗的那一步接著跑完。之後的步驟標「Simulated tx」，已經上鏈的步驟保留「Live tx」。/mandate 也一樣，失敗時提供「Sign in Simulated mode instead」。如果失敗發生在 `lock` 成功之後，合約裡的錢會停在 Locked 狀態。畫面要顯示 bookingId，並提示「Refunds after the ticket window」。另外新增 `pnpm live:sweep`，找出已經過了期限、還在 Locked 的 booking，逐一呼叫 `refund()`，錢一律退回 owner。
- 依據：【假設】需求只寫了「切回模擬版」，沒有說要自動還是手動。合約 `refund()` 任何人都能呼叫（`contracts/FlightEscrow.sol:258-264`）
- 信心：中
- 影響程度：高（錢可能卡在合約裡，事後清理也要送真交易）
- 考慮過的其他選項：失敗時自動無聲改成模擬（評審會以為後面的步驟也是真的）；失敗就停下來不讓 Demo 繼續（違反需求）
- 衝突：無
- 狀態：有效
- 影響到：spec §1、spec §2、spec §3、spec §4.8、spec §7、#20、#24、#25

### D-27 `/api/live/status` 要檢查哪些東西，才判定 Live 可用？
- 分支：切換與退回 > 可用性檢查
- 回答：
  - `LIVE_MODE=on`。
  - 三組助記詞都在。
  - D-02 的合約地址檢查都通過。
  - EVM chain id 是 9800。
  - 商家的 `pqcKeyStatus` 回傳 registered、algorithmId 為 1、possessionProven 為 true，而且公鑰和商家助記詞推導出來的一致。
  - owner 餘額夠付一張上限票價加手續費。
  - relayer 和會送件的 signer 都有餘額。

  結果快取 30 秒，只回傳公開的地址和失敗原因。讀取時，遇到限流的重試方式沿用 bootstrap 的 `retrying`。
- 依據：【程式碼】ticket/13 `scripts/evm/check.ts`（同一組檢查的先例）；`scripts/bootstrap/chain.ts:46-64`
- 信心：高
- 影響程度：中（只讀不寫）
- 考慮過的其他選項：只檢查合約地址（餘額不夠時，要等到 `book()` 才會失敗）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.8、#19

### D-28 React StrictMode 在開發模式會讓 effect 跑兩次，再加上重新整理、重複點擊，會不會重複廣播？
- 分支：冪等與跨回合 > 重複廣播
- 回答：三道防線。(1) **廣播一律不重試**，只有讀取可以重試，沿用 bootstrap 的規則。(2) 伺服器在記憶體裡用 `(step, bookingId)` 當 key 存冪等表，同一個 key 再進來時，直接回傳上次的結果，不重送。`bookingId` 在送出前就能從 quote 算出來（`escrow.ts` 的 `bookingId()`）。(3) client 把步驟的 running 狀態和 bookingId 存在 sessionStorage。重新整理後，向伺服器查這筆 booking 目前的狀態（從 `Booked`、`Released`、`Refunded` 事件推導），而不是再送一次。
- 依據：【程式碼】`scripts/bootstrap/chain.ts:52-56`（「Never wrap a broadcast」）；`src/app/checkout/page.tsx:181-186`（effect 的 cleanup 只設 `cancelled` 旗標，攔不住已經送出的 fetch）；`src/lib/escrow.ts:130-133`
- 信心：高
- 影響程度：高（重複送出就是重複付款，或被拒絕但照樣扣手續費）
- 考慮過的其他選項：只靠 client 端的旗標（StrictMode 和多個分頁都攔不住）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.9、spec §5、#20、#21、#24

### D-29 合約的 `ticketsUsed` 在重設 mandate 時會保留，也沒有查詢函式。Demo 跑第二輪時，`book()` 會因為 `TicketQuotaExhausted` 失敗，怎麼辦？
- 分支：冪等與跨回合 > 票數額度
- 回答：每次在 Live 模式簽 mandate 時，伺服器用 `eth_getLogs` 從 `FLIGHT_ESCROW_DEPLOY_BLOCK` 開始，查出這個 agent 地址的 `Booked` 事件，減掉已經 `Refunded` 的，算出目前用掉的張數 `used`。鏈上的 `maxTickets` 設成 `used + mandate.maxTickets`，畫面仍顯示「1 ticket」。這樣每一輪 Demo，剛好只能再買 `mandate.maxTickets` 張，「不能買兩次」的說法依然成立。log 查不到時（例如 RPC 限制查詢範圍），Live 簽署直接失敗並說明原因，不要猜一個數字。
- 依據：【假設】`contracts/FlightEscrow.sol:111`（`ticketsUsed` 在重設時保留）、`:126`（`mandates` 是 internal，沒有 getter）、`:216-217`
- 信心：低
- 影響程度：高（會寫入鏈上的 mandate 資料，算錯就會讓 agent 多買或買不到）
- 考慮過的其他選項：請 #7 加一個 `ticketsUsed(agent)` view 函式（要改已經完成測試的合約，屬於跨功能）；每輪 Demo 換一個新的 owner 帳號（要重跑水龍頭）；把鏈上 `maxTickets` 設一個很大的數字（等於讓鏈上的張數限制失效）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.4、spec §7、#20

### D-30 Live 交易要等多久？Demo 的節奏和動畫速度怎麼維持？
- 分支：冪等與跨回合 > 等待與節奏
- 回答：每筆交易都等到上鏈才算完成（SDK 廣播後會等待；diana 約 1 秒出塊）。每個步驟保留原本 `wait()` 的最短動畫時間，畫面節奏和 Simulated 差不多。每一步最多等 30 秒，逾時就進入 D-26 的退回流程。Speed 設定在 Live 模式只影響動畫，不影響鏈上的等待時間。
- 依據：【文件】`docs/FLOW.md`「diana 測試網實測記錄」（出塊約 1.03 秒）；#2 user story 21
- 信心：高
- 影響程度：低（只影響畫面節奏）
- 考慮過的其他選項：不等上鏈，廣播送出就顯示雜湊（交易之後失敗時，畫面會是錯的）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.9、#20、#21、#24

### D-31 需求說要「改寫 `src/lib/chain.ts`，畫面元件盡量不改」，程式結構怎麼切？
- 分支：程式結構 > 模組邊界
- 回答：`src/lib/chain.ts` 只留在瀏覽器也能安全使用的內容：常數、`shortAddr`、模擬用的 helper，再加一個 `ChainPort` 介面，提供 `setupMandate`、`lockFunds`、`confirmTicket`、`cancelBooking`、`checkFareCap`、`status` 這些操作。這個介面有兩份實作：`simulatedChain` 用 `makeTx`；`liveChain` 用 fetch 呼叫 `/api/live/*`。頁面依 `state.mode` 取得對應的實作，`checkout` 和 `mandate` 頁面只改 `switch` 裡跟鏈有關的幾個 case。伺服器端放在 `src/server/live/`（D-07），可以 import `src/lib/escrow.ts` 和 `scripts/bootstrap/chain.ts` 的純函式，但**不能** import `scripts/bootstrap/env.ts`，因為那支會產生並寫入助記詞。
- 依據：【程式碼】`src/lib/chain.ts`；`src/app/checkout/page.tsx:61-166`；`src/app/mandate/page.tsx:40-61`；`scripts/bootstrap/env.ts:58-93`（`loadEnv` 會寫檔）
- 信心：中
- 影響程度：中（決定程式結構，但只在本功能範圍內）
- 考慮過的其他選項：每個頁面直接 fetch 各自的 API（模式判斷會散在各頁）；把整個 SDK 用動態 `import()` 載進瀏覽器（違反 D-05）
- 衝突：無
- 狀態：有效
- 影響到：spec §4.2、spec §4.10、#18、#19

### D-32 商家在 Live 模式用哪一把 ML-DSA-87 金鑰簽 quote 和各種 proof？
- 分支：程式結構 > 商家金鑰
- 回答：用 `derivePqcCanonical(merchantQor1, MERCHANT_MNEMONIC)` 推導出來的金鑰對，也就是 bootstrap 註冊上鏈、`pqcKeyStatus` 查得到的那一把。簽章時直接把它的 secretKey 交給 `src/lib/escrow.ts` 的 `signMessage`，**不用** `merchantKeys(seed)`，那個函式只給 ffi 測試的固定 seed 用。D-11 的探測要確認：noble 的簽章能被鏈上查到的公鑰驗過（呼叫 `verifyMessage`，並對 `pqcVerify` 做 `eth_call`）。
- 依據：【程式碼】`src/lib/escrow.ts:154-169`；`scripts/bootstrap/chain.ts:40-44`；ticket/13 `scripts/evm/check.ts`（比對 `pqcKeyStatus` 的公鑰和 `derivePqcCanonical` 的結果）
- 信心：中
- 影響程度：高（用錯金鑰，所有 `book()` 都會因為 `InvalidSignature` 失敗）
- 考慮過的其他選項：另外設一個 `MERCHANT_MLDSA_SEED`（#13 已經明確取消這個做法）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.3、spec §4.5、#17、#21

### D-33 沒有可以放進 CI 的測試網，要怎麼測？
- 分支：測試與範圍外 > 測試策略
- 回答：
  - (1) 用 `node:test` 搭配 `tsx --test`，沿用 ticket/13 的 `test:scripts` 寫法，測純函式：Offer／Mandate 對應到合約結構、US$ 換算 wei／uqor、情境對應的步驟與呼叫清單、explorer URL。
  - (2) 寫一份 `FakeChain` 實作伺服器端的鏈介面，用來測 route handler 的流程：Ticketed 剛好 2 筆廣播、Fare jumps 0 筆廣播加 1 次讀取、Booking fails 是 `book` 加 `cancel`、同一個冪等 key 送兩次只廣播一次、合約地址缺少時回報不可用。
  - (3) 合約行為交給 #9–#12 的 Foundry 測試，本功能不重複測。
  - (4) `pnpm check:bundle`（D-07）。
  - (5) 手動驗收：一份 diana runbook，三種情境各跑一次，explorer 連結記進 FLOW.md。這是 D-01 的 B 段，不進 CI。
- 依據：【文件】#7 Testing Decisions（只用一個自動化 seam，測試替身只放在邊界）；ticket/13 commit `2cfbfc1` 的 `package.json`（`test:scripts`）
- 信心：中
- 影響程度：中（決定測試的寫法，不影響執行期行為）
- 考慮過的其他選項：在本機起 anvil 測試鏈（沒有 PQC 預編譯，`book()` 跑不起來）；在 CI 打 diana（有限流，而且要水龍頭）
- 衝突：無
- 狀態：有效
- 影響到：spec §3、spec §4.10、spec §5、spec §7、#19、#26

### D-34 哪些事明確不在本功能範圍內？
- 分支：測試與範圍外 > 範圍外
- 回答：
  - `/drill` 的真攻擊交易，以及鏈上撤銷 agent（`revokeMandate`、`MsgRevokeAuthenticator`）。
  - Duffel API、Claude 解析。
  - 真正的 QoreX 錢包整合。
  - 主網。
  - ERC-20。
  - 修改 FlightEscrow 合約。
  - 改用 `refund()` 走逾期退款的 Demo 流程（只做 D-26 的清理腳本）。
- 依據：【文件】`docs/FLOW.md`「接上真實服務的順序」第 3～5 步；`docs/features/live-checkout/request.md`
- 信心：高
- 影響程度：低（只是劃清範圍）
- 考慮過的其他選項：順便把 drill 的撤銷改成真的（會讓範圍變大，而且 revoke 和 relink 的流程要另外設計）
- 衝突：無
- 狀態：有效
- 影響到：spec §6、無對應 ticket（範圍外，見 spec §6）
