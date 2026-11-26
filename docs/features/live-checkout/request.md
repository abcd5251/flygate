# live-checkout：原始需求（使用者 /ship 輸入，原文）

3. 把 /checkout 接上真的交易

目標： 讓 8 道關卡裡跟鏈有關的步驟送出真的交易，畫面上顯示真的交易雜湊。

要做的事
- 授權階段（/mandate）：
  - 用 linkAuthenticatorMsgs 把 agent 私鑰和支出規則綁到你的帳號
  - 用 openEvmWindowMsg 開一個限範圍的 window
- 通關階段（/checkout）：
  - 鎖款：MsgExecuteEVM → FlightEscrow.book()
  - 開票證明與放款：FlightEscrow.confirmTicket()
  - 退款情境：FlightEscrow.refund()
- 改寫 src/lib/chain.ts，用 SDK 換掉 makeTx() / fakeHash()，但畫面元件盡量不改
- 加「Live / Simulated」切換：測試網出問題時切回模擬版，Demo 照常跑完

完成標準
- 走完一次 Demo，每個鏈上步驟都有可以在區塊瀏覽器查到的交易
- 「Fare jumps」和「Booking fails」兩種情境在鏈上的結果符合預期：前者錢沒動，後者錢退回
- 畫面上的標籤要跟著改：已經是真交易的步驟，不能再標「Simulated tx」

相依關係： 第 3 步需要第 1 步的帳號，也需要第 2 步部署好的合約地址。

## /ship 啟動時查到的實際狀態（2026-11-24）
- 第 1 步（帳號 bootstrap）：PR #8 `chore/diana-bootstrap` 開著、未合併。
- 第 2 步（FlightEscrow 合約）：issue #7 與 tickets #9–#14；分支 `feat/flight-escrow` 只在本機、未推上 origin，另一個 session 正在整合；部署（#14）尚未完成，沒有合約地址。
- 本功能分支 `feat/live-checkout` 從本機 `feat/flight-escrow`（157cab1）開出。
