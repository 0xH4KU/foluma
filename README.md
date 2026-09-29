# Foluma

本機書籍工具。核心將 PDF 轉成固定版面 EPUB；頁面編輯器是首次使用預設安裝的獨立插件，可自行停用或移除。

介面採用傳統桌面工具布局：圖示與文字工具列、側邊導覽、密集頁面表格、書籍資訊與固定狀態列。編輯器可切換列表／縮圖／跨頁縮圖，並排顯示預覽與頁面屬性；版面方向參考 [calibre 的工具列與功能分區](https://manual.calibre-ebook.com/gui.html)。

Tauri + React/TypeScript 負責桌面與工作區，獨立 Python 引擎管理文件、歷史與背景工作。使用者不需要另外安裝 Python。

## 本機試用

- 開啟 `src-tauri/target/release/bundle/macos/Foluma.app`。
- 首次啟動會從隨附套件安裝編輯器，不需連線。停用或移除後，重啟會隱藏「編輯頁面」，後續啟動不會自行重裝。既有插件設定保持不變。
- 既有安裝可在 Plugins → Included packages 更新 Page editor 至 0.3.0，或選擇 `artifacts/org.foluma.editor-0.3.0.mte-plugin` 手動安裝，安裝後重新啟動。
- 介面預設英文。在 Plugins → Included packages 安裝繁體中文語言包，再到 Preferences → Interface language 切換；語言包可立即停用或移除，介面回到英文。書籍的語言代碼是 EPUB 中繼資料，與介面語言分開。
- 頁面可拖曳排序（支援多選、前後落點與邊緣自動捲動），或右鍵開啟頁面操作；鍵盤可用 Shift+F10 開啟相同選單。
- 用 Open folder 匯入漫畫資料夾，或拖入資料夾／多個 PDF，開啟 Series 工作區。直接讀取資料夾內的 PDF（不遞迴子資料夾），依 Vol.1、Vol.2、Vol.10 自然排序，開啟或匯出時才載入內容。
- 每冊的頁序、空白、裁切和人工標記獨立自動保存。切換書籍或重新啟動後可接續編輯；檢查完成後勾選 Reviewed，用 Next unreviewed 接著處理下一冊。
- 在 Series 勾選要處理的冊數，可只共用閱讀方向與封面是否納入正文，或逐本匯出各自的排版，無須排版預設。既有同名輸出會保留，未完成項目可重試；匯出後再修改會標為 Needs re-export。
- 舊有排版預設與 Batch PDFs… 保留在編輯器的 Presets 選單，適用於確定頁面結構相同的文件。
- 先開啟 PDF，再使用「編輯頁面」；也可只使用核心直接匯出。
- 支援 ⌘O 開啟 PDF、⇧⌘O 開啟專案、⌘S 儲存專案、⌘E 匯出 EPUB（Windows/Linux 使用 Ctrl）。
- 跨頁按鈕與左右方向鍵依閱讀方向整組翻頁。用 B／Shift+B 在目前頁面前／後插入空白，用 M 標記待檢查、Shift+M 跳到下一個標記；也可使用預覽旁按鈕或右鍵選單。
- 大預覽與跨頁縮圖使用相同配對，並顯示目前頁碼與原始 PDF 頁碼。大預覽共用高度與縮放，中央無間隔，方便檢查接縫。選頁、捲動、模式與縮放依書籍在本機保存。
- 跨頁預覽中的「模擬首頁前留白」預設開啟，用來模擬部分閱讀器（如 Apple Books）的頁面配對，不會在 EPUB 中新增空白頁。
- 儲存專案會建立 `.mteproj` 資料夾，引用原始 PDF 並內嵌新增／渲染圖片。移動 PDF 後可重新連結內容相同的檔案。
- 系列自動保存使用相同 `.mteproj` 格式，位於應用程式資料目錄的 `series/`；不改寫原始 PDF。需要攜帶到其他電腦時，可另存專案。

這是 macOS Apple Silicon 本機測試版，使用 ad-hoc 簽章，尚未公證。官方目錄的下載與雜湊驗證已實作；repo 目前為私有且尚未發布 release，現階段使用本機插件套件。Windows/Linux 尚未驗證。

## Development

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm install
npm run tauri dev
```

Requires Node.js, Rust and the platform's Tauri prerequisites. End users do not need Python, Node or Rust.

```sh
npm run test:engine
npm test
npm run build
npm run tauri build
```

The editor and Traditional Chinese language packages, plus a release-ready catalog are produced in `artifacts/`. No release is published by these commands. See the [implementation plan](docs/PLAN.md), [plugin API](docs/PLUGIN-API.md), and [validation record](docs/VALIDATION.md).

## Provenance

PDF image stream and EPUB packaging utilities are adapted from HAKU's MIT-licensed `manga-to-epub` at commit `d3888b9`. The application, document model, plugin API and interface are independent of the original GUI.
