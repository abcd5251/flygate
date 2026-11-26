# live-checkout tickets

> Spec：#16（`docs/features/live-checkout/spec.md`）。所有 ticket 都是 #16 的 sub-issue，相依用 GitHub 原生的 blocked-by 關係設定。
> 每張 ticket 對應一個 commit。/ship stage 4 只實作 A 段（#17～#25）；#26 是 B 段，要等 #14 部署後才能做。

依實作順序排列：

| # | 標題 | 來自 | 相依 | 狀態 |
|---|---|---|---|---|
| #17 | diana 探測腳本 `pnpm live:probe` | D-11、D-04、D-09、D-10、D-12、D-13、D-19、D-23、D-32 | #13 的 EVM 金鑰 helper 程式碼（分支 `ticket/13-evm-keys`，只寫在本文，沒有設原生相依）；PR #8 的帳號 | 現在可做 |
| #18 | prefactor：ChainPort 介面、資料形狀與四種來源標籤 | D-31、D-20、D-22、D-23、D-03、D-18 | 無 | 現在可做 |
| #19 | Live／Simulated 切換、`/api/live/status` 與金鑰防外洩 | D-02、D-04、D-05、D-07、D-08、D-24、D-25、D-27、D-31、D-33 | #18；#13 helper 程式碼 | 現在可做（#18 之後） |
| #20 | /mandate 在 Live 模式送出 link、window、setMandate 三筆真交易 | D-06、D-09、D-10、D-12、D-13、D-14、D-15、D-25、D-26、D-28、D-29、D-30 | #17、#19 | 現在可做（前置完成後） |
| #21 | /checkout Ticketed 情境的 lock 與 proof 真交易 | D-09、D-11、D-14、D-15、D-16、D-19、D-21、D-28、D-30、D-32 | #20 | 現在可做（前置完成後） |
| #22 | Fare jumps 以 eth_call 顯示 FareOverCap，證明錢沒動 | D-17、D-16 | #21 | 現在可做（前置完成後） |
| #23 | Booking fails 真的鎖款後，用 cancel() 立即退款 | D-18、D-19、D-10、D-16 | #21 | 現在可做（前置完成後） |
| #24 | 失敗時 Finish in Simulated mode，重新整理不重送 | D-26、D-28、D-30 | #21 | 現在可做（前置完成後） |
| #25 | `pnpm live:sweep` 退回卡在合約裡的錢 | D-26、D-18、D-10 | #19 | 現在可做（前置完成後） |
| #26 | [BLOCKED on #14] B 段：在 diana 實跑三種情境並驗收 | D-01、D-33、D-11 | #14；#17～#25 | **blocked**（B 段，`ready-for-human`） |

D-34（範圍外）沒有對應的 ticket。

## 這一階段由 agent 自行決定的事（使用者不在場）

- 切分方式與粒度：#18 是先做的 prefactor，Simulated 模式行為不變；Fare jumps、Booking fails、失敗退回、sweep 各自獨立成一張 ticket。
- #13 的 helper 只列為文字相依，不設原生 blocked-by：`ticket/13-evm-keys` 分支已經實作完成，只是還沒併進 `feat/flight-escrow`，不必等 #13 issue 關閉。實作時直接 merge 那個分支（同一批 commit，不複製程式碼），這是我對 D-04 的解讀。
- #19 沒有被 #17 擋住：status 與切換不依賴探測結果。#20 起的 Live 交易路徑才依賴探測。
- #26 用 `ready-for-human`，不用 `ready-for-agent`：它是 spec §5／D-33 (5) 的手動驗收，標題也標了 [BLOCKED on #14]。diana runbook 放在 #26 撰寫。
- `check:bundle` 與 `server-only` 併進 #19：它們是第一個 server-only 模組出現時的防線。
