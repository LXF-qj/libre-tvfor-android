# LibreTV for Android

把 [LibreTV](https://github.com/LibreSpark/LibreTV) 封装成 Android App：内置 Node 运行时在本地跑起完整服务，再用 WebView 呈现界面，不依赖任何外部服务器。

> **本项目基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 修改而来，遵循 GNU AGPL-3.0 许可证。**
> 原项目版权归其作者所有；本仓库的修改部分同样以 AGPL-3.0 授权。

## 与原项目的差异

原项目是部署在服务器上的网页应用；本仓库把它搬进手机，并做了以下修改：

**Android 外壳（新增）**

- 自建 Node 运行时启动器（nodejs-mobile），App 内起本地 HTTP 服务，WebView 加载 `127.0.0.1`
- 前端资源打包进 APK，首次启动解压到私有目录，按版本号判断是否需要重新解压
- 播放器横屏满屏：走原生方向锁定而不是 WebView 全屏 API（避开了实测会白屏的问题）
- 原生层新增：版本查询、进程自重启、APK 安装调起（自写 `ApkFileProvider`，未引入 AndroidX）

**功能修改**

- 播放页：手机控制条重排；新增选集面板（控制条九宫格），解决竖屏无切集入口的问题
- 弹幕：接入 B站 弹幕（wbi 签名搜索 → 季信息 → 分集 XML），支持片名绑定、时间轴对齐、跨源生效
- 搜索：片名匹配加相似度打分、年份纠偏、衍生词过滤；兼容带空格的剧名
- 在线更新：热更新（patch.zip 覆盖网页与 Node 逻辑，重启生效）与完整 APK 更新两条线

## 目录结构

```
libretv/         Next.js 前端与 Node 服务（原项目的代码 + 修改）
apk/             Android 外壳工程（Java + nodejs-mobile）
android-build/   构建脚本：打包前端产物、生成更新清单
release/         发布产物（热更包、安装包、更新清单）
```

## 构建

需要 JDK 17、Android SDK（platform 34 + NDK 26）、Node 20+。

```bash
# 1. 构建前端产物（standalone 模式）
cd libretv && npm ci && DOCKER_BUILD=1 npx next build

# 2. 把产物打成 APK 内置的 zip
cd .. && python android-build/build_assets.py

# 3. 编译 APK
cd apk && ../android-build/gradle-8.7/bin/gradle assembleRelease
```

**签名**：仓库不包含签名私钥（`*.keystore` 已忽略）。自行构建时请在 `apk/app/build.gradle` 里配置自己的 keystore，或改用 debug 签名。

**Node 运行时**：`apk/app/src/main/jniLibs/arm64-v8a/libnode.so`（59.6MB）由 [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 提供，已包含在仓库中。若需替换版本，取对应 arm64 产物覆盖该目录即可。

**发布产物**：`release/` 下是热更包、安装包与更新清单，与仓库中的源码版本对应。

## 在线更新

App 内「关于 → 软件更新」会读取 `release/manifest.json`：

```json
{
  "version": "2.27.0",
  "apkVersionCode": 28,
  "patch": { "urls": ["..."], "sha256": "...", "size": 10351502 },
  "apk":   { "versionCode": 28, "urls": ["..."], "sha256": "...", "size": 26625026 }
}
```

`apkVersionCode` 大于本机 versionCode 时走完整安装包，否则只下发热更新。更新不会覆盖 `data/` 与 `.env`。

## 免责声明

本项目不存储、不制作、不转码任何视频内容，仅提供第三方公开接口的聚合与播放能力。所有内容的合法性由对应数据源负责。请遵守当地法律法规，仅用于个人学习与技术研究。
