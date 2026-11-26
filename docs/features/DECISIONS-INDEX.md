# 跨功能決策索引

格式：`<slug>/D-xx｜一句話結論｜依據類型｜影響程度｜狀態`

## live-checkout

- live-checkout/D-01｜分兩段交付：現在做轉接層、切換、測試；等 #14 部署後再做 diana 實跑驗收｜文件｜高｜有效
- live-checkout/D-02｜合約地址讀伺服器環境變數 FLIGHT_ESCROW_ADDRESS；缺少或不合法時停用 Live｜假設｜中｜有效
- live-checkout/D-03｜不改 ADDRESSES.escrow；release 和 refund 的說明文字照 #14／#7 的寫法（跨功能衝突：#14 前端範圍重疊）｜文件｜高｜有效
- live-checkout/D-04｜從 feat/flight-escrow 往下長，ticket/13 用 merge 取得；PR 開向 develop，合併順序 #8 → flight-escrow → 本功能｜文件｜中｜有效
- live-checkout/D-05｜所有鏈上簽章都在 Next.js Route Handlers 做，瀏覽器不 import SDK（ADR-0001）｜文件｜高｜有效
- live-checkout/D-06｜Live 模式由伺服器用 OWNER_MNEMONIC 代替 QoreX 簽章，WalletModal 標「Demo owner key (server)」｜假設｜高｜有效
- live-checkout/D-07｜金鑰防外洩：server-only 模組、build 後掃描 bundle、.env* 不進 git｜文件｜高｜有效
- live-checkout/D-08｜Live routes 只在 LIVE_MODE=on 時啟用、只在本機使用；伺服器自己組 calldata｜假設｜高｜有效
- live-checkout/D-09｜book() 走 MsgExecuteEVM authenticator lane：agent 的 coin-60 金鑰簽、agent 的 qor1 當 relayer、錢從 owner 帳號出｜程式碼｜高｜有效
- live-checkout/D-10｜setMandate 由 owner 的 EVM signer 送；agent 欄位填 owner 帳號 0x；退款回 owner 的 EVM signer（ADR-0002）｜假設｜高｜有效
- live-checkout/D-11｜第一張 ticket 是 diana 探測（pnpm live:probe）；保留 lane 設定點，必要時退回 EOA lane｜假設｜高｜有效
- live-checkout/D-12｜window 開在 owner 帳號、只放行 FlightEscrow；交易順序 link → window → setMandate｜程式碼｜高｜有效
- live-checkout/D-13｜支出規則：perTxLimit 等於票價上限，allowedEvmCalls 只放行 escrow 的 book() selector｜程式碼｜高｜有效
- live-checkout/D-14｜Live 換算 1 US$ = 0.01 QOR（跨功能衝突：#7 的 1 QOR = US$1）｜文件｜高｜有效
- live-checkout/D-15｜Offer／Mandate 對應到合約 Quote／Mandate：城市代碼、unix day、ticketWindow 600 秒，統一走 escrow.ts 編碼｜程式碼｜高｜有效
- live-checkout/D-16｜Ticketed 有 2 筆真交易（book、confirmTicket）；release 共用 confirmTicket 的雜湊；verify 用 eth_call｜程式碼｜高｜有效
- live-checkout/D-17｜Fare jumps 不送交易；用 eth_call 模擬 book() 拿到 FareOverCap，前後讀餘額確認沒變｜程式碼｜中｜有效
- live-checkout/D-18｜Booking fails 用 cancel()（商家簽的 CancelProof）立即退款，不用 refund()｜程式碼｜高｜有效
- live-checkout/D-19｜confirmTicket／cancel 由 agent 的 coin-60 EOA 送出，權限來自商家簽章｜程式碼｜高｜有效
- live-checkout/D-20｜SourceTag 分四種：Real crypto／Live tx／Live read／Simulated tx｜程式碼｜中｜有效
- live-checkout/D-21｜checkout、ticket、WalletModal 的 simulated 文字跟著模式改；drill 維持模擬｜程式碼｜低｜有效
- live-checkout/D-22｜ChainTx 和 BookingStep 加 source、explorerUrl；sessionStorage key 不變｜程式碼｜低｜有效
- live-checkout/D-23｜explorer 連結用 {explorer}/tx/{hash}；0x 雜湊能不能查由探測確認｜程式碼｜低｜有效
- live-checkout/D-24｜切換鈕放在 PresenterPanel，預設 Simulated；Live 模式下 Header 顯示標章｜假設｜低｜有效
- live-checkout/D-25｜流程進行中鎖住切換；mandate 記錄自己是哪個模式簽的；Reset 保留模式｜假設｜中｜有效
- live-checkout/D-26｜不做無聲自動退回：提供「Finish in Simulated mode」按鈕，鎖住的錢用 pnpm live:sweep 清理｜假設｜高｜有效
- live-checkout/D-27｜/api/live/status 檢查地址、chain id、商家 PQC 金鑰與各帳號餘額，結果快取 30 秒｜程式碼｜中｜有效
- live-checkout/D-28｜廣播不重試；伺服器用 (step, bookingId) 做冪等；重新整理後查事件推導狀態，不重送｜程式碼｜高｜有效
- live-checkout/D-29｜鏈上 maxTickets = 從 log 算出的已用張數 + mandate.maxTickets｜假設｜高｜有效
- live-checkout/D-30｜等到上鏈才算完成，保留原本的動畫節奏，每步最多等 30 秒｜文件｜低｜有效
- live-checkout/D-31｜chain.ts 加 ChainPort 介面，分成 simulated 與 live 兩份實作；伺服器端放在 src/server/live｜程式碼｜中｜有效
- live-checkout/D-32｜商家用 derivePqcCanonical 推導、已註冊上鏈的金鑰簽章，不用 merchantKeys(seed)｜程式碼｜高｜有效
- live-checkout/D-33｜測試：node:test 測純函式、FakeChain 測流程、bundle 掃描，加上手動 diana runbook｜文件｜中｜有效
- live-checkout/D-34｜範圍外：drill、鏈上撤銷、Duffel、Claude、真錢包、主網、修改合約｜文件｜低｜有效
