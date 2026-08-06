# 🍅 PomodoroFlow & 🧠 Binaural Beats Studio

> **全功能極致現代化 Local Web 番茄鐘與專業雙耳拍頻 (Binaural Beats) 音訊發聲系統**  
> 整合任務管理、數據圖表、Web Audio API 原生離線白噪音、雙耳拍頻黃金聲學比例、定時睡眠自動關閉與全螢幕禪模式。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![Web Audio API](https://img.shields.io/badge/Web%20Audio%20API-10b981?style=flat)
![100% Offline](https://img.shields.io/badge/100%25-Offline--Ready-indigo)

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
- **5 大情境封裝模式**：
  - 🧠 **Alpha (α) 平靜專注 (10 Hz 拍頻 - 預設選取)**：身心平靜、學習狀態、消除焦慮。
  - ⚡ **Beta (β) 高效思考 (20 Hz 拍頻)**：邏輯分析、程式開發、高度警覺。
  - 🚀 **Gamma (γ) 極限記憶 (40 Hz 拍頻)**：記憶整合、敏捷衝刺。
  - 🎨 **Theta (θ) 靈感冥想 (6 Hz 拍頻)**：創意發想、深度冥想。
  - 🧘 **Delta (δ) 睡眠修復 (2 Hz 拍頻)**：減壓紓緩、身體休養、助眠。

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
Binaural-Beats-Tool/
├── index.html        # 主頁面結構、語意化 HTML5、Modal 彈窗、雙耳拍頻面板
├── styles.css        # CSS 設計系統（玻璃擬物、主題變數、響應式佈局）
├── app.js            # 核心邏輯（Web Audio 音訊引擎、Timer 控制器、任務與圖表）
└── README.md         # 專案說明文件
```

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 條款授權。歡迎自由使用、修改與擴充！
