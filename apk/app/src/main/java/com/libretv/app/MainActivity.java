package com.libretv.app;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {

    private static final String TAG = "LibreTV";
    private static final int PORT = 8090;
    private static final String LOCAL_HOST = "127.0.0.1";
    private static final String START_URL = "http://" + LOCAL_HOST + ":" + PORT + "/";

    /** 每次更新 assets 里的前端产物时 +1，触发设备端重新解压 */
    private static final int EXTRACT_VERSION = 36;

    private WebView webView;
    private TextView statusText;
    private View splashView;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    /** 网页侧请求的横屏满屏（伪全屏）：返回键优先退出它 */
    private volatile boolean webFullscreen = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean destroyed = false;

    private File appRoot;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appRoot = new File(getFilesDir(), "libretv");
        buildUi();
        Thread boot = new Thread(this::bootSequence, "libretv-boot");
        boot.setDaemon(true);
        boot.start();
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0F1115);

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setBackgroundColor(0xFF0F1115);
        splash.setPadding(48, 48, 48, 48);

        TextView title = new TextView(this);
        title.setText("LibreTV");
        title.setTextColor(Color.WHITE);
        title.setTextSize(30f);
        title.setGravity(Gravity.CENTER);
        splash.addView(title);

        ProgressBar bar = new ProgressBar(this);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barLp.topMargin = 40;
        splash.addView(bar, barLp);

        statusText = new TextView(this);
        statusText.setText("正在准备运行环境…");
        statusText.setTextColor(0xFFB9C0CC);
        statusText.setTextSize(14f);
        statusText.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams stLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stLp.topMargin = 28;
        splash.addView(statusText, stLp);

        splashView = splash;
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    private void configureWebView(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        view.setBackgroundColor(Color.BLACK);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        // 横屏满屏桥：网页起播后调用 setLandscape(true)，本机转横屏并进入沉浸式。
        // 页面只来自本机 Node 服务，不加载第三方站点，注入该接口无外部可见风险。
        view.addJavascriptInterface(new NativeBridge(), "LibreTVAndroid");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (splashView != null && splashView.getVisibility() == View.VISIBLE) {
                    splashView.setVisibility(View.GONE);
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                ViewGroup decor = (ViewGroup) getWindow().getDecorView();
                decor.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                // 网页触发的全屏：竖屏全屏对 16:9 视频没有意义，一并转横屏 + 沉浸
                applyLandscape(true);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
    }

    /** 退出网页触发的全屏播放（不依赖 API 26 的 getWebChromeClient） */
    private void exitFullscreen() {
        if (customView == null) {
            return;
        }
        final View view = customView;
        final WebChromeClient.CustomViewCallback callback = customCallback;
        customView = null;
        customCallback = null;
        ViewGroup decor = (ViewGroup) getWindow().getDecorView();
        decor.removeView(view);
        if (webView != null) {
            webView.setVisibility(View.VISIBLE);
            // 退出网页全屏后 WebView 的合成层要重建：只 setVisibility(VISIBLE)
            // 在部分机型上会停在「有声音、画面全黑」，补一次布局与重绘把它拉回来。
            webView.post(() -> {
                webView.requestLayout();
                webView.invalidate();
            });
        }
        // 若当前是网页请求的横屏满屏（伪全屏），保持横屏；否则恢复竖屏与系统栏
        if (!webFullscreen) {
            applyLandscape(false);
        }
        if (callback != null) {
            callback.onCustomViewHidden();
        }
    }

    // ---------------------------------------------------------------- 横屏满屏

    /** 供网页调用的原生能力（对象名 LibreTVAndroid） */
    private class NativeBridge {
        /**
         * 进入 / 退出横屏满屏。网页那边的布局由 JS 铺满视口，这里只负责屏幕方向与系统栏，
         * 因此不需要 HTML5 Fullscreen API，也就不受「必须有用户手势」的限制。
         */
        /**
         * 应用热更新后重启：先把「重启自己」的闹钟挂上，再杀进程。
         * 直接 finish() 只是关界面，Node 进程还在跑旧代码，更新不会生效。
         */
        @JavascriptInterface
        public void restartApp() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(MainActivity.this, MainActivity.class);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    PendingIntent pending = PendingIntent.getActivity(
                            MainActivity.this, 0, intent,
                            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
                    if (am != null) {
                        am.set(AlarmManager.RTC, System.currentTimeMillis() + 600, pending);
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "schedule restart failed", t);
                }
                finishAffinity();
                Process.killProcess(Process.myPid());
            });
        }

        /** 当前安装包的 versionCode：前端拿它和清单比，决定走热更还是整包更新 */
        @JavascriptInterface
        public int versionCode() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            } catch (Throwable t) {
                return 0;
            }
        }

        /** 把已下载好的 update.apk 交给系统安装器（同签名才能覆盖安装） */
        @JavascriptInterface
        public void installApk() {
            final File apk = new File(appRoot, "update.apk");
            if (!apk.isFile()) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "安装包不存在，请先下载", Toast.LENGTH_SHORT).show());
                return;
            }
            runOnUiThread(() -> {
                try {
                    Uri uri = Uri.parse("content://" + ApkFileProvider.AUTHORITY + "/update.apk");
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, "application/vnd.android.package-archive");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Throwable t) {
                    Log.e(TAG, "install apk failed", t);
                    Toast.makeText(MainActivity.this,
                            "无法调起安装器，请在系统设置里允许「安装未知应用」", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void setLandscape(final boolean on) {
            main.post(() -> applyLandscape(on));
        }
    }

    private void applyLandscape(boolean on) {
        if (destroyed) {
            return;
        }
        webFullscreen = on;
        if (on) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            enterImmersive();
        } else {
            /*
             * 退出时不能只用 UNSPECIFIED：部分机型（实测一加 ColorOS）在系统「自动旋转」
             * 关闭的状态下，UNSPECIFIED 不会把 Activity 转回竖屏，画面就停在横屏内容塞进
             * 竖屏里的状态——表现为播放器撑满整屏、控制条被切掉一半。
             * 手机直接锁竖屏；平板保持跟随系统（平板上横着拿本来就是常态）。
             */
            boolean tablet = getResources().getConfiguration().smallestScreenWidthDp >= 600;
            setRequestedOrientation(tablet
                    ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                    : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            exitImmersive();
        }
    }

    /**
     * 清单里用 configChanges 接管了旋转，Activity 不会重建；WebView 也就不会自动
     * 重新测量。不补这一次布局，旋转后它会保留旧方向的尺寸比例。
     */
    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (webView != null) {
            webView.requestLayout();
            webView.post(() -> {
                if (webView != null) {
                    webView.invalidate();
                }
            });
        }
    }

    /** 沉浸式：隐藏状态栏与导航栏，并从屏幕边缘滑动才临时唤出 */
    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @SuppressWarnings("deprecation")
    private void exitImmersive() {
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }

    private boolean handleUrl(String url) {
        if (url == null) {
            return true;
        }
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (host != null && (host.equals(LOCAL_HOST) || host.equals("localhost"))) {
            return false;
        }
        // 外部链接交给系统浏览器
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Log.w(TAG, "no activity for url: " + url);
        }
        return true;
    }

    private void setStatus(final String text) {
        Log.i(TAG, text);
        main.post(() -> {
            if (statusText != null) {
                statusText.setText(text);
            }
        });
    }

    private void showFailure(final String message) {
        main.post(() -> {
            if (statusText != null) {
                statusText.setText(message);
            }
        });
    }

    // ---------------------------------------------------------------- 启动流程

    private void bootSequence() {
        try {
            setStatus("正在解压运行环境（首次启动较慢）…");
            extractAssetsIfNeeded();
            applyExternalOverrides();

            File bootstrap = new File(appRoot, "bootstrap.js");
            if (!bootstrap.isFile()) {
                showFailure("运行环境不完整：缺少 bootstrap.js");
                return;
            }

            setStatus("正在启动服务…");
            startNodeAsync(bootstrap);

            setStatus("正在等待服务就绪…");
            if (waitForServer(180)) {
                main.post(() -> {
                    if (destroyed) {
                        return;
                    }
                    webView.loadUrl(START_URL);
                });
            } else {
                showFailure("服务启动超时。请用 adb logcat -s LibreTVNode 查看日志");
            }
        } catch (Throwable t) {
            Log.e(TAG, "boot failed", t);
            showFailure("启动失败：" + t.getClass().getSimpleName() + " " + t.getMessage());
        }
    }

    private void startNodeAsync(File bootstrap) {
        Thread nodeThread = new Thread(() -> {
            try {
                String[] args = new String[]{"node", bootstrap.getAbsolutePath()};
                int code = NodeRunner.startNode(args);
                Log.w(TAG, "node runtime exited, code=" + code);
                if (!destroyed) {
                    showFailure("服务进程已退出（code=" + code + "），请查看 logcat");
                }
            } catch (Throwable t) {
                Log.e(TAG, "node start failed", t);
                showFailure("Node 运行时启动失败：" + t.getMessage());
            }
        }, "libretv-node");
        nodeThread.setDaemon(false);
        nodeThread.start();
    }

    private boolean waitForServer(int attempts) {
        for (int i = 0; i < attempts && !destroyed; i++) {
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(LOCAL_HOST, PORT), 400);
                Log.i(TAG, "server ready after " + (i + 1) + " probes");
                return true;
            } catch (IOException ignored) {
                // 还没起来
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- assets 解压

    private void extractAssetsIfNeeded() throws IOException {
        File stamp = new File(appRoot, ".extract_version");
        if (stamp.isFile()) {
            String current = readText(stamp);
            if (String.valueOf(EXTRACT_VERSION).equals(current.trim())
                    && new File(appRoot, "bootstrap.js").isFile()) {
                Log.i(TAG, "assets already extracted, skip");
                return;
            }
        }

        Log.i(TAG, "extracting assets to " + appRoot);
        deleteRecursively(appRoot);
        if (!appRoot.mkdirs() && !appRoot.isDirectory()) {
            throw new IOException("cannot create " + appRoot);
        }

        int count;
        try (InputStream raw = getAssets().open("libretv.zip")) {
            count = unzipTo(raw, appRoot);
        }

        writeText(stamp, String.valueOf(EXTRACT_VERSION));
        Log.i(TAG, "extracted " + count + " files");
    }

    /**
     * 外部覆盖通道（免重装迭代用）：
     * /sdcard/Android/data/com.libretv.app/files/patch.zip 解压覆盖到运行目录，
     * 同目录下 .env 会覆盖内置配置。改了内容后重启应用即可生效。
     */
    private void applyExternalOverrides() {
        File ext = getExternalFilesDir(null);
        if (ext == null) {
            return;
        }

        File envOverride = new File(ext, ".env");
        if (envOverride.isFile()) {
            try {
                copyFile(envOverride, new File(appRoot, ".env"));
                Log.i(TAG, "applied external .env override");
            } catch (IOException e) {
                Log.w(TAG, "apply .env override failed", e);
            }
        }

        File patch = new File(ext, "patch.zip");
        if (!patch.isFile()) {
            return;
        }
        String sig = patch.length() + ":" + patch.lastModified();
        File stamp = new File(appRoot, ".patch_sig");
        if (sig.equals(readText(stamp).trim())) {
            Log.i(TAG, "patch already applied: " + sig);
            return;
        }
        Log.i(TAG, "applying patch " + patch + " (" + patch.length() + " bytes)");
        try (InputStream in = new java.io.FileInputStream(patch)) {
            int n = unzipTo(in, appRoot);
            writeText(stamp, sig);
            Log.i(TAG, "patch applied, " + n + " files");
            // 一次性补丁：应用后即删除，避免后续版本重装时旧文件覆盖新 assets
            if (patch.delete()) {
                Log.i(TAG, "patch.zip removed after apply");
            } else {
                Log.w(TAG, "patch.zip delete failed, will verify by signature next launch");
            }
        } catch (IOException e) {
            Log.e(TAG, "apply patch failed", e);
        }
    }

    private static void copyFile(File src, File dst) throws IOException {
        try (InputStream in = new java.io.FileInputStream(src);
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    /** 解压 zip 流到目标目录（覆盖同名文件），返回写入文件数 */
    private static int unzipTo(InputStream raw, File destDir) throws IOException {
        String destPath = destDir.getCanonicalPath();
        byte[] buffer = new byte[128 * 1024];
        int count = 0;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(raw, 256 * 1024))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                File target = new File(destDir, entry.getName());
                if (!target.getCanonicalPath().startsWith(destPath)) {
                    throw new IOException("zip slip: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.mkdirs();
                } else {
                    File parent = target.getParentFile();
                    if (parent != null) {
                        //noinspection ResultOfMethodCallIgnored
                        parent.mkdirs();
                    }
                    try (OutputStream out = new FileOutputStream(target)) {
                        int n;
                        while ((n = zis.read(buffer)) > 0) {
                            out.write(buffer, 0, n);
                        }
                    }
                    count++;
                }
                zis.closeEntry();
            }
        }
        return count;
    }

    private static String readText(File file) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[(int) Math.min(file.length(), 4096)];
            int n = in.read(buf);
            return n > 0 ? new String(buf, 0, n, "UTF-8") : "";
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File file, String text) {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes("UTF-8"));
        } catch (IOException e) {
            Log.w(TAG, "write " + file + " failed", e);
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
            return;
        }
        // 横屏满屏时，返回键先退出满屏（还原方向与系统栏），不直接回上一页
        if (webFullscreen) {
            webFullscreen = false;
            applyLandscape(false);
            if (webView != null) {
                // 让网页同步还原布局；即使脚本失败，屏幕方向与系统栏也已恢复
                webView.evaluateJavascript(
                        "(function(){try{if(window.__libretvExitFullscreen)window.__libretvExitFullscreen();}catch(e){}})()",
                        null);
            }
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
        // Node 运行时以阻塞方式驻留，随进程一起结束
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
