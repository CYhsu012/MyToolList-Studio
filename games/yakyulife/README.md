# YakyuLife 棒球生涯模擬器 ⚾

> **這是一個分支版本 (Fork)**
> 原作：[leoggcat/yakyulife](https://github.com/leoggcat/yakyulife)（[原版遊玩連結](https://leoggcat.github.io/yakyulife/)）
> 本分支：[CYhsu012/yakyulife_Tomorin](https://github.com/CYhsu012/yakyulife_Tomorin)，由 CYhsu012 修改維護。
> 遊戲原始設計與著作權歸原作者所有，本分支僅作個人修改與整合用途。

這是一款純文字的棒球生涯養成遊戲。玩家將從高中開始，經歷選秀、旅外、國際賽，直到引退，體驗每一次擲骰與選擇帶來的棒球人生。

👉 **[遊玩本分支版本](https://cyhsu012.github.io/MyToolList-Studio/games/yakyulife/index.html)**
（本分支亦內嵌於 [MyToolList Studio](https://cyhsu012.github.io/MyToolList-Studio/) 工具集中）

## 遊戲特色
* **多層級聯賽**：完整模擬高中、大學、業餘成棒、中職、日職與大聯盟的升降級與合約交涉。
* **隱藏屬性系統**：包含天才、鐵人等豐富的隱藏特質。
* **人生隨機事件**：感情選擇、傷病危機、公關事件與國際賽徵召，球場外的每一個決定都會影響生涯走向。
* **細緻的數據運算**：依照球探量表 (20-80) 進行能力養成，並根據不同守備位置與角色定位給予專屬評價。

## 本分支的修改

### 安全性
* **修補分享連結可執行任意程式碼的問題 (XSS)**
  `SEED` 過去直接取用網址的 `?seed=` 參數，未經處理就交給 `innerHTML` 渲染，
  因此 `?seed=<img src=x onerror=...>` 這類連結會在點擊者的瀏覽器上執行程式碼。
  由於本遊戲的玩法本來就鼓勵「把種子網址分享給朋友」，這條路徑風險較高。
  現以白名單限制種子只接受 `A-Z a-z 0-9 - _`、長度上限 24。
* 球員姓名在入口即濾除 HTML 特殊字元，避免經由記分板／引退串等處注入。

### 其他
* 修正標題拼字：`YaKyoLife` → `YakyuLife`。
* 開場畫面加註 fork 來源與原作連結。
