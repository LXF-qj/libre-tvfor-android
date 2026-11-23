package com.libretv.app;

/**
 * JNI 桥接：把控制权交给内嵌的 libnode（nodejs-mobile 运行时）。
 * startNode 是阻塞调用，必须在独立线程中执行。
 */
public final class NodeRunner {

    static {
        System.loadLibrary("nodebridge");
    }

    private NodeRunner() {
    }

    /**
     * @param args 形如 {"node", "/data/.../bootstrap.js"}
     * @return Node 进程退出码
     */
    public static native int startNode(String[] args);
}
