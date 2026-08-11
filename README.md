# 🛠️ MyToolList Studio (個人開發工具集合與專注聲學套件)

> **個人開發者多功能 Web 工具箱與極致專注聲學 Studio**  
> 主介面以 **My Tool List** 為中心，整合 **🍅 PomodoroFlow 番茄鐘**、**🧠 雙耳拍頻 (Binaural Beats)**、**🌙 NREM 慢波深眠引導實驗室** 與未來工具箱。
> 包含任務管理、數據圖表、Web Audio API 原生離線白噪音、雙耳拍頻黃金聲學比例、定時睡眠自動關閉與全螢幕禪模式。

![Version](https://img.shields.io/badge/version-v0.10.1--beta-purple.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![Web Audio API](https://img.shields.io/badge/Web%20Audio%20API-10b981?style=flat)
![100% Offline](https://img.shields.io/badge/100%25-Offline--Ready-indigo)

---

## 🧪 當前版本與未來進版規範 (Versioning Policy)

本專案採用 **[SemVer 2.0.0 (語意化版本號號碼規範)](https://semver.org/lang/zh-TW/)**：

> **當前版本號**：`v0.10.1-beta`（公開開發測試版）  
> **版本狀態**：新增第二個工具模組 **⚾ YakyuLife 棒球人生**（以 git submodule 引入，可獨立更新），採同源 iframe 內嵌，切換到遊戲時番茄鐘與音訊持續在背景執行。

### 📌 版本號遞增規則 (vMAJOR.MINOR.PATCH-STAGE)

| 階段 / 欄位 | 說明與進版條件 | 範例 |
| :--- | :--- | :--- |
| **MAJOR (主版本)** | 當進行重大架構升級、UI 大版本翻新或 PWA 離線快取正式版發布時遞增。 | `v1.0.0` (正式發布版) |
| **MINOR (次版本)** | 當新增全新功能模組或進行資訊架構／核心引擎重構時遞增。 | `v0.10.0` (**當前**) |
| **PATCH (修補號)** | 當進行 Bug 修復、CSS 響應式排版微調、演算法音量參數校正時遞增。 | `v0.10.1` |
| **STAGE (階段標籤)** | `-alpha` (內部實驗版) $\rightarrow$ `-beta` (**當前階段**) $\rightarrow$ `-rc` (準發布版) $\rightarrow$ 正式版。 | `v0.8.5-beta` |

### 📋 v0.10.1-beta 變更摘要

- **修補 YakyuLife 分享連結可執行任意程式碼的問題 (XSS)**（修改於 fork：[CYhsu012/yakyulife_Tomorin](https://github.com/CYhsu012/yakyulife_Tomorin)）。
  遊戲的 `SEED` 直接取用網址 `?seed=` 參數並交給 `innerHTML`，`?seed=<img src=x onerror=...>` 這類分享連結會在對方瀏覽器執行程式碼；
  因遊戲以同源 iframe 內嵌，該程式碼可存取本工具集的 localStorage。已改為白名單限制，並在遊戲入口濾除姓名的 HTML 特殊字元。
- 修正遊戲標題拼字：`YaKyoLife` → `YakyuLife`（含 og/twitter meta 與工具集內所有引用）。
- 遊戲畫面與遊戲 README 加註 fork 來源與原作連結，標明著作權歸原作者所有。

---

### 📋 v0.10.0-beta 變更摘要

**新增工具模組：⚾ YakyuLife 棒球人生**
- 以 **git submodule** 引入 [`CYhsu012/yakyulife_Tomorin`](https://github.com/CYhsu012/yakyulife_Tomorin)，遊戲維持獨立 repo、可單獨更新。
- 採**同源 iframe** 內嵌（`games/yakyulife/index.html`）而非外部連結：切換到遊戲時番茄鐘計時與雙耳拍頻／環境音**持續在背景執行**，不會中斷。
- iframe 首次進入才載入，之後保留實例 —— 離開再回來不會重置遊戲進度。
- 另附「↗️ 新分頁開啟」供全螢幕遊玩。
- 部署流程加上 `submodules: recursive`，否則 GitHub Pages 會部署出空資料夾。

#### 更新遊戲版本

```bash
git submodule update --remote games/yakyulife
git add games/yakyulife && git commit -m "chore: bump yakyulife submodule"
```

---

### 📋 v0.9.1-beta 變更摘要

**音訊修正**
- 音訊輸出不再無條件繞經 `MediaStreamDestination → <audio>`。該路徑讓 AudioContext 時脈與播放裝置時脈相對漂移，播放管線靠重新取樣補償，造成純正弦波上可聽見的週期性音高飄動。現僅在 iOS 保留（鎖屏背景播放必需）。
- 遮罩噪音改為 8 秒緩衝 + 0.25 秒等功率交叉淡化：迴圈接縫跳變由最壞 11.6 倍降至 1.91 倍，消除每 2 秒的低頻悶響。
- 噪音產生後移除直流並正規化，每次啟動音量差異由 2.45 dB 降為 0 dB。
- 兩種模式皆加入 60Hz high-pass，移除對遮蔽 120–400Hz 載波毫無作用、卻佔據最大能量的次低頻。

**新增遮罩模式 A / B（可切換）**
- **A · 氛圍墊底**：維持原始寬頻低通墊底音，拍頻最清晰（音調高出遮罩約 19dB）。
- **B · 去相關包圍**：左右耳各自獨立的噪音（實測兩耳相關係數 ≈ 0.02）搭配跟隨載波的寬帶通，柔化正弦波稜角並拓寬聲場，音調仍高出遮罩約 13dB。

**音量控制**
- 雙耳拍頻分頁：拍頻音量與遮罩音量並列，兩者獨立。
- NREM 助眠面板新增專屬拍頻／遮罩音量滑桿；此前助眠完全沒有音量控制，只能借用另一分頁的設定。兩區設定互不干擾。
- 所有音量調整走即時增益斜坡，播放中拉動不會重建音訊圖或斷音。

**版面**
- 標題列改為任意寬度皆可換行，修補 601–900px 之間的橫向破版（先前的修正只涵蓋 ≤600px）。

---

### 📋 v0.9.0-beta 變更摘要

**資訊架構重構**
- 音效功能由單張長卡片拆為四個分頁（環境音／雙耳拍頻／NREM 助眠／定時關閉）。
- 計時器獨立為專屬卡片並於桌機吸頂，任務與音效工作室共用右欄分頁。
- 雙耳拍頻進階設定（基頻載波、遮罩、聲學數據）預設收合。
- 左下與右下兩個懸浮元件合併為單一迷你控制台，控制鍵改為作用在「實際執行中」的工作階段。

**核心修復**
- 三組計時器（番茄鐘／NREM 助眠／音效定時關閉）改為 `Date.now()` 時間戳錨定，分頁節流或手機鎖屏不再漏秒。
- 匯入備份與 localStorage 一律經過欄位清洗，修補可執行任意程式碼的 XSS 風險。
- 音效定時關閉現在會一併停止 NREM 助眠與 YouTube 音軌。
- 補上從未定義的 `formatTime()`（迷你元件每次更新皆拋錯的主因）。
- 修正跳過首顆番茄會直接進入長休息、儲存設定會清空進行中進度、連續天數顯示過期數字。
- 修正 Delta 腦波卡 `<button>` 標籤未閉合。

**手機端強化**
- 消除橫向捲動（`min-width: 0` 於 flex／grid 容器）。
- 統計圖表改為容器自適應並依 `devicePixelRatio` 繪製。
- 表單欄位統一 16px，避免 iOS 聚焦時整頁縮放。
- 觸控目標放大至 40–44px，並加大編輯／刪除間距。
- 迷你控制台支援 `env(safe-area-inset-bottom)`。

---

## 🌟 核心特色與產品亮點 (Key Features)

### 1. ⏱️ 核心番茄鐘計時器 (Pomodoro Core Timer)
- **3 大模式**：🎯 專注工作 (Work, 25min)、☕ 短暫休息 (Short Break, 5min)、🌴 長時間休息 (Long Break, 15min)。
- **SVG 動態圓環倒數**：圓環進度條與瀏覽器頁面標題（Document Title）動態同步倒數 (如 `(24:59) 🎯 專注 - PomodoroFlow`)。
- **自動化設定**：可選擇自動開始休息、自動開始下一輪專注。

### 2. 🧠 專業雙耳拍頻音訊發聲系統 (Binaural Beats Acoustic Studio)
基於聽覺神經學與物理正弦聲波干涉原理設計（**請務必配戴雙聲道耳機**）：
- **精確聽覺物理演算法**：
  $$\text{左耳頻率 } f_{\text{left}} = f_{\text{base}} - \frac{\Delta f}{2.0}, \quad \text{右耳頻率 } f_{\text{right}} = f_{\text{base}} + \frac{\Delta f}{2.0}$$
  大腦感知音高 $f_{\text{perceived}} = 200\text{ Hz}$，呈現精確 $\Delta f$ Hz 的脈動 (Tremolo) 與頭腦中央相位移動感。
- **⚖️ 2.5 : 7.5 黃金聲學比例 (Acoustic Golden Ratio)**：
  - **純拍頻正弦波：佔 25%**（確保精確腦波同步與誘發效果）。
  - **粉紅噪音遮罩音 (Pink Noise)：佔 75%**（通過 800Hz 溫暖低通濾波器包覆，**長時間聆聽 1~4 小時不耳疲勞、不刺耳**）。
- **硬體獨立聲道隔離 (Hard Channel Separation)**：
  採用 Web Audio API `StereoPannerNode` 與 `ChannelMergerNode(2)` 獨立控制左右耳訊號，確保聲波必須在大腦兩側橄欖體（Superior Olivary Complex）進行相位整合。
- **6 大情境封裝模式**：
  - 🧠 **Alpha (α) 平靜專注 (10 Hz 拍頻 - 預設選取)**：身心平靜、學習狀態、消除焦慮。
  - ⚡ **Beta (β) 高效思考 (20 Hz 拍頻)**：邏輯分析、程式開發、高度警覺。
  - 🚀 **Gamma (γ) 極限記憶 (40 Hz 拍頻)**：記憶整合、敏捷衝刺。
  - 🎨 **Theta (θ) 靈感冥想 (6 Hz 拍頻)**：創意發想、深度冥想。
  - 🧘 **Delta (δ) 靜止慢波 (2 Hz 拍頻)**：身體休養、減壓紓緩。
  - 🌙 **NREM 深層慢波助眠 (20 分鐘動態降頻演算法)**：
    - **策略 1：20 分鐘動態降頻 (Frequency Sliding)**：`0-5m 8Hz (Alpha放鬆)` $\rightarrow$ `5-12m 5Hz (Theta昏眠)` $\rightarrow$ `12-20m 2Hz (Delta鎖定深眠)`。
    - **策略 2：120 Hz 低載波基頻**：低沉安撫，活化副交感神經。
    - **策略 3：80% 棕色深海雷雨音遮罩 (Brown Noise)**：$1/f^2$ 深層音能包覆，阻隔干擾。
    - **策略 4：睡眠定時 3 分鐘指數級淡出 (Exponential Fade-Out)**：保護慢波睡眠週期，避免後半夜干擾。

### 3. ⏳ 音效定時自動關閉倒數計時器 (Sound Auto-Off Sleep Timer)
- **精確到秒**：可自訂分鐘與秒數（如 `0分 30秒`），並附帶 `5分`、`15分`、`30分`、`60分` 快速預設鍵。
- **平滑淡出關閉 (Smooth Audio Auto-Off)**：倒數至 00:00 時，自動停止所有白噪音，並將雙耳拍頻進行 2 秒平滑淡出 (Fade-Out) 關閉，避免突然靜音打斷睡眠或冥想。

### 4. 📋 專注任務與專案管理 (Task Management)
- **預估 vs 實際完成**：設定預估番茄數 🍅，每次專注完成自動累加當前任務計數。
- **專案標籤與優先級**：💻 工作、📚 學習、🎨 設計、🏃 健康/生活，搭配🔴高、🟡中、🟢低優先級。

### 5. 📊 專注數據統計與圖表 (Analytics & Canvas Charts)
- **數據指標**：今日累積專注時間、今日完成番茄數、歷史總完成數與連續專注天數 (🔥 Streak)。
- **極致圖表**：HTML5 Canvas 繪製過去 7 天專注趨勢柱狀圖 (Bar Chart) 與標籤專注佔比圓餅圖 (Donut Chart)。

### 6. 🎨 沉浸體驗與主題 (Focus & Customization)
- **全螢幕禪模式 (Zen Mode)**：隱藏繁雜介面，巨型幾何計時與脈動呼吸燈。
- **4 款現代視覺主題**：
  - 🌌 深邃夜空 (Dark Glass)
  - 🌲 森林靜謐 (Emerald Forest)
  - 🌅 日落橙光 (Sunset Glow)
  - ⚡ 賽博朋克 (Cyberpunk Neon)
- **資料備份**：支援 LocalStorage 持久化儲存與一鍵 JSON 資料匯出/匯入。

---

## 🛠️ 技術棧 (Tech Stack)

- **前端核心**：HTML5 (語意化結構), Vanilla CSS (CSS Variables, Glassmorphism 玻璃擬物, Flexbox/Grid)
- **音訊引擎**：Web Audio API 原生聲音合成（正弦波振盪器、粉紅噪音產生器、立體聲聲道分離器、BiquadFilter 濾波器、Envelope 淡入淡出 GainNode）
- **數據視覺化**：HTML5 Canvas API
- **零依賴**：100% 離線可用，不需下載任何 mp3/wav 外部音訊檔！

---

## 🚀 快速開始與執行方式 (Getting Started)

### 方式 1：直接透過瀏覽器開啟
下載專案後，雙擊開啟 [`index.html`](index.html) 即可直接體驗！

### 方式 2：使用本地 HTTP Server
在專案根目錄執行：
```bash
python -m http.server 3000
```
開啟瀏覽器造訪 `http://localhost:3000` 即可使用。

---

## 📂 檔案結構 (Project Structure)

```
MyToolList-Studio/
├── index.html            # 主頁面結構、三大檢視（工具列表／番茄鐘／遊戲）、Modal 彈窗
├── styles.css            # CSS 設計系統（玻璃擬物、主題變數、響應式佈局）
├── app.js                # 核心邏輯（Web Audio 音訊引擎、Timer 控制器、任務與圖表）
├── games/
│   └── yakyulife/        # git submodule → CYhsu012/yakyulife_Tomorin（獨立更新）
├── .gitmodules           # submodule 設定
└── README.md             # 專案說明文件
```

> ⚠️ Clone 本專案時需一併取得 submodule：
> ```bash
> git clone --recurse-submodules https://github.com/CYhsu012/MyToolList-Studio.git
> ```
> 若已 clone，補拉：`git submodule update --init --recursive`

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 條款授權。歡迎自由使用、修改與擴充！
