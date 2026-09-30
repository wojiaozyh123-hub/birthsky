# 你来的那晚 · The Night You Arrived

输入生日和出生城市，回到你出生那一刻、那座城市头顶**真实的星空**：银河、月相、行星、星座和中国星官。页面有时光倒流的星轨动画，还有实时合成的宇宙音乐；星空可以"弹奏"成一段旋律，可以生成可打印的高清海报，也可以和朋友做星空合盘。

纯静态站点：没有服务器，不收集任何数据。分享链接里带着重绘一片星空所需的全部信息。

## 功能

- **开场**：当前所在城市此刻的真实星空，远山剪影；星星按亮度依次点亮，模拟眼睛适应黑暗的过程。
- **时光倒流**：星空倒着旋转，留下长曝光星轨；日期倒着翻，经纬度一路过渡到出生地。落地那一刻有低频的绽放音效。
- **那一夜**：
  - 月相与农历（含闰月）、节气
  - 头顶离天顶最近的亮星
  - 当时在地平线以上的行星
  - 肉眼可见的星星数量
  - **光年之星**：今晚看到的哪颗星，它的光正好是你出生那年出发的
- **交互**：
  - 拖动旋转、双指缩放、点星星看它的故事
  - 滑动时间轴看完整个夜晚（也可以自动播放）
  - 「仰望」视角配合手机陀螺仪
  - 西方 88 星座与中国三垣二十八宿一键切换
- **聆听星空**：一道光束扫过星图，每颗亮星按高度、亮度和颜色化成一个音符。
- **海报**：1440×1920，四种风格（夜空 / 宣纸 / 墨 / 暮光），可以改标题和寄语。宣纸款带名字印章。二维码直达"和我合盘"。**免费高清导出。**
- **星空合盘**：两片星空叠在一起。
  - 重合度 = 两人出生时都在地平线上的肉眼可见星 ÷ 至少一人能看见的星
  - 附带牛郎织女检测、月相、出生地距离和光年换算
  - 合盘结果也能生成海报
- **微信适配**：
  - 分享时引导点右上角「···」
  - 动态设置页面标题
  - 海报在微信里长按即可保存
  - iOS 开着静音键也能听到音乐

## 开发

```bash
npm install
npm run dev        # http://127.0.0.1:5178  （src/ 直接运行，ES 模块 + import map）
npm run build      # → dist/（打包压缩，带哈希）
npm run qa -- flow # 无头 Chromium 跑完整流程并截图到 .cache/qa/（需要 Playwright 的 Chromium）
```

数据是预先生成并提交进仓库的（`src/data/`），平时不需要重新跑。如需重建：

```bash
# HYG 星表放到 .cache/hyg/hygdata_v41.csv；GeoNames 文件放到 .cache/geonames/（见 tools/build-cities.mjs 头部说明）
npm run data
```

推送到 `main` 后，GitHub Actions 会自动构建并发布到 GitHub Pages（`.github/workflows/pages.yml`）。

## 结构

```
src/
  index.html, styles/main.css
  js/main.js        应用流程：开场 → 填写 → 时光倒流 → 星空 → 海报 / 合盘 / 分享
  js/renderer.js    WebGL：大气、银河（纹理 + 噪声 + 银心暖色）、星点、星尘、星轨累积缓冲
  js/overlay.js     2D 矢量层：星座线（逐条描绘）、中文名、地平环、月相、行星、扫描光束
  js/camera.js      立体投影相机：「星图」与「仰望」是同一个相机的两个姿态
  js/astro.js       astronomy-engine 封装：旋转矩阵、日月行星、农历、节气、时区
  js/audio.js       Web Audio 生成式音乐：和弦长音、FM 钟声、混响、风声、倒流 / 抵达音效
  js/facts.js       那一夜的文案
  js/hepan.js       合盘算法与动画
  js/poster.js      海报工作室（独立 WebGL 上下文，四种风格，二维码）
  js/share.js       分享链接编解码（紧凑、带版本号）与微信分享引导
  js/cities.js      城市搜索（中文 / 拼音 / 英文）
  js/config.js      广告与统计开关（默认全关）
  data/             stars.bin · sky.json · milkyway.png · cities.json
tools/              数据构建、打包、本地预览服务、无头验收
docs/MONETIZATION.md 变现与广告方案
```

## 数据与许可

- 恒星：[HYG Database v4.1](https://github.com/astronexus/HYG-Database)（CC BY-SA 4.0）
- 星座连线、中文星名、银河轮廓：[d3-celestial](https://github.com/ofrohn/d3-celestial)（BSD-3），银河轮廓来自 J. R. Vieira，中国星官来自 Stellarium skycultures
- 日月行星：[Astronomy Engine](https://github.com/cosinekitty/astronomy)（MIT）
- 城市：[GeoNames](https://www.geonames.org/)（CC BY 4.0）
- 字体：Cormorant Garamond（OFL）
- 二维码：qrcode-generator（MIT）

以上数据都在站内「关于」页面注明了出处。
