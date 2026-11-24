# live-checkout：retro（2026-11-24，PR #27 審查前）

這份 retro 在使用者審查前寫，所以這次功能的推翻數還不存在。這份 retro 只針對**環境**（文件、檢查、工具）提出改善建議。這些建議都還沒有套用，等使用者決定。

## 決策統計（累積，來自 `docs/features/DECISIONS-INDEX.md`）

- 所有功能至今被推翻／已修正的假設：**0**。live-checkout 是第一個走 /ship 的功能，還沒有審查結果。
- 本功能新增決策 34 題：程式碼 16、文件 9、假設 9。
  - 假設 × 高：6 題（D-06、D-08、D-10、D-11、D-26、D-29）
  - 假設 × 中：2 題（D-02、D-25）
  - 假設 × 低：1 題（D-24）
- 跨功能衝突 2 題：D-03、D-14，都與 flight-escrow（#7／#14）有關。
- 假設集中在「diana 鏈上實際行為」這個分支：authenticator lane、退款去向、window 是否管得到 MsgExecuteEVM、手續費、explorer 格式。repo 裡沒有可查的依據，`pnpm live:probe` 也還沒有人跑過。
- 建議補進 repo 文件的規則（讓下次回答者有依據可查）：
  1. **QOR／US$ 換算慣例**：D-14 和 #7 的「1 QOR = US$1」衝突。等使用者裁決後寫成 ADR，並在 GLOSSARY 加詞條。
  2. **diana 實測結果**：probe 跑完後由 `docs/FLOW.md` 的 `live:probe` 區塊記錄，同時把 ADR-0002 從 Proposed 改成 Accepted 或 Rejected。
  3. **用哪把 key 簽什麼**：owner／agent／merchant 三個角色，各自的 qor1 帳號、coin-60 signer、PQC key 分別用在哪。目前散在 D-09～D-13 和 ADR-0001／0002 裡，建議集中成一份 `docs/keys.md`，再從 GLOSSARY 指過去。

## 環境改善候選（依嚴重度）

### 1. 平行 ticket 共用註冊點，造成手動合併和一個真 bug（Automated checks／ticket 拆法）
- **發生什麼**：T#22／T#23／T#24 同時改了同一組註冊行：`CHECKOUT_STEPS`、dispatcher switch、`ChainPort`、`/checkout` 的 runner。我手動解了兩輪衝突，review 又抓到合併後的真 bug（P-2：退款步驟重新整理後卡住，「Finish in Simulated mode」也選錯步驟）。
- **建議**：在 `docs/agents/` 加一條拆 ticket 規則：會改同一個註冊點的 ticket，要嘛設成先後依賴，要嘛先開一張 prefactor ticket 把註冊點改成「一個檔案一個 step」的 registry。
- **再加一個檢查**：在 `checkout.test.ts` 加一個測試，斷言每個 `CHECKOUT_STEPS` 都有 dispatcher case 和 recovery 規則。之後有人漏接，會直接 red。

### 2. 客戶端頁面沒有測試 harness（Automated checks）
- **發生什麼**：T#24 的重新整理恢復和 fallback 邏輯全在 `src/app/checkout/page.tsx`，沒有任何自動測試，P-2 只能靠 review 抓到。
- **建議**：加一個最小的 Playwright（或 React Testing Library）測試，用 Simulated 模式跑完三種情境，再加一個「Live 失敗 → Finish in Simulated mode」的情境（用 mock 的 `/api/live/*` 回應）。

### 3. 沒有 `CODING_STANDARDS.md`，reviewer 只能靠自己的標準（Coding standards）
- **建議**：新增 `CODING_STANDARDS.md`，只放 review 時要強制的規則。這次 review 找到的可以先放進去：
  - 冪等鍵必須保證唯一，不能只靠內容 hash（P-1）。
  - 共用 helper 放在共用模組，不要複製私有函式（S-1）。
  - `src/server/live/**` 一律 `import "server-only"`。
  - 鏈上廣播不重試，只重試讀取。
  - 畫面標籤要依 `source` 顯示，不要寫死。
- `AGENTS.md` 只加一行指標指向這份檔案。

### 4. pnpm 版本：每個 implementer 都重新踩一次（Information access／Tool economy）
- **發生什麼**：全域 pnpm 9.3.0 會拒絕 `pnpm-workspace.yaml`。`package.json` 其實已經釘了 `packageManager: pnpm@10.20.0`，但 corepack 沒有啟用。前 3 個 implementer 各自花步驟才發現，之後我寫進 brief 才解決。
- **建議**：使用者在本機跑一次 `corepack enable`，這是環境修正，不用改文件。

### 5. 鏈上行為沒有依據可查，導致 9 題假設（Information access）
- **發生什麼**：probe 不能由 agent 自己跑，因為會用使用者的帳號廣播。合約也還沒部署（#14）。
- **建議**：
  - 以後做鏈相關功能前，先由人跑 `pnpm live:probe`，再開 /ship，讓 auto-grill 有實測紀錄可查。
  - /ship 啟動時如果依賴功能還沒部署，應在階段 1 就把功能拆成兩段交付（這次的 D-01 是 auto-grill 自己想到的，不是流程規定的）。

### 6. Rate limit 讓兩個子 agent 中斷（Tool economy）
- **發生什麼**：stage 3 和 T#21 都撞到 session limit。實際上沒有遺失工作：stage 3 用 SendMessage 接續完成；T#21 是在 commit 之後才中斷。
- **成本**：單一 implementer 用了 10 萬～25 萬 tokens。成本大多花在重讀 spec、decisions 和前面 ticket 的程式碼。
- **建議**：implement-spec 的 optional exploration 步驟，這次為了省事跳過了。下次對 SDK 較陌生的功能，先讓一個 exploration agent 把 `@qorechain/sdk` 的 API 筆記存到 repo 外的共用路徑。這次「brief 末尾累積前面 ticket 的交接筆記」的做法有效，可以寫進 /ship 的 stage 4 說明。

### 7. `tsc --noEmit` 單獨跑會失敗（Automated checks，低）
- **發生什麼**：`LayoutProps` 是 build 時才產生的型別，implementer 每次都要另外解釋一次。
- **建議**：在 `package.json` 加一個 `typecheck` script，先產生型別再跑 tsc。先查 `node_modules/next/dist/docs/` 確認這版 Next 的 typegen 指令。

## 流程偏差紀錄（/ship 本身）

- to-spec、to-tickets、implement-spec、retro 這四個 Skill 沒有啟用。使用者同意後，直接讀 `~/.claude/plugins/marketplaces/mattpocock/skills/` 底下的 SKILL.md 照著做。
- implement-spec 第 3 步要在一開始開 draft PR、第 8 步再標 ready。這次改成照 /ship 的規定，在階段 5 才開 PR。
- implement-spec 要用 merger subagent 合併各 ticket，這次由協調者直接 cherry-pick，讓每張 ticket 剛好對應一個 commit。衝突由協調者手動解。
- PR #27 的 diff 包含 #8 和 flight-escrow 的程式碼，因為那些都還沒合併。push 時，`feat/flight-escrow` 和 `ticket/13` 的 commit 也第一次出現在 origin 上。
