#include <jni.h>
#include <android/log.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <pthread.h>
#include <unistd.h>

#include "node.h"

#define LOG_TAG "LibreTVNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

int g_stdout_pipe[2] = {-1, -1};
int g_stderr_pipe[2] = {-1, -1};
pthread_t g_stdout_thread;
pthread_t g_stderr_thread;

void* stdout_pump(void*) {
    char buf[2048];
    ssize_t n;
    while ((n = read(g_stdout_pipe[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = '\0';
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
    }
    return nullptr;
}

void* stderr_pump(void*) {
    char buf[2048];
    ssize_t n;
    while ((n = read(g_stderr_pipe[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = '\0';
        __android_log_write(ANDROID_LOG_ERROR, LOG_TAG, buf);
    }
    return nullptr;
}

/** 把 Node 的 stdout/stderr 转发到 logcat，便于 adb logcat 排查 */
void redirect_stdio_to_logcat() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (pipe(g_stdout_pipe) == 0) {
        dup2(g_stdout_pipe[1], STDOUT_FILENO);
        if (pthread_create(&g_stdout_thread, nullptr, stdout_pump, nullptr) == 0) {
            pthread_detach(g_stdout_thread);
        }
    }

    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(g_stderr_pipe) == 0) {
        dup2(g_stderr_pipe[1], STDERR_FILENO);
        if (pthread_create(&g_stderr_thread, nullptr, stderr_pump, nullptr) == 0) {
            pthread_detach(g_stderr_thread);
        }
    }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_libretv_app_NodeRunner_startNode(JNIEnv* env, jobject /*thiz*/, jobjectArray jargs) {
    jsize argc = env->GetArrayLength(jargs);

    // libuv 要求 argv 全部位于连续内存，这里手工拼一块缓冲区
    std::vector<size_t> lengths(static_cast<size_t>(argc), 0);
    size_t total = 0;
    for (jsize i = 0; i < argc; ++i) {
        jstring js = static_cast<jstring>(env->GetObjectArrayElement(jargs, i));
        const char* c = js ? env->GetStringUTFChars(js, nullptr) : "";
        lengths[static_cast<size_t>(i)] = c ? strlen(c) : 0;
        total += lengths[static_cast<size_t>(i)] + 1;
        if (js && c) env->ReleaseStringUTFChars(js, c);
        if (js) env->DeleteLocalRef(js);
    }

    char* buffer = static_cast<char*>(calloc(total > 0 ? total : 1, sizeof(char)));
    if (buffer == nullptr) {
        LOGE("failed to allocate argv buffer");
        return -1;
    }

    std::vector<char*> argv(static_cast<size_t>(argc) + 1, nullptr);
    char* cursor = buffer;
    for (jsize i = 0; i < argc; ++i) {
        jstring js = static_cast<jstring>(env->GetObjectArrayElement(jargs, i));
        const char* c = js ? env->GetStringUTFChars(js, nullptr) : "";
        if (c) {
            strncpy(cursor, c, lengths[static_cast<size_t>(i)]);
            env->ReleaseStringUTFChars(js, c);
        }
        argv[static_cast<size_t>(i)] = cursor;
        cursor += lengths[static_cast<size_t>(i)] + 1;
        if (js) env->DeleteLocalRef(js);
    }
    argv[static_cast<size_t>(argc)] = nullptr;

    redirect_stdio_to_logcat();

    LOGI("starting node, argc=%d", static_cast<int>(argc));
    for (jsize i = 0; i < argc; ++i) {
        LOGI("  argv[%d] = %s", static_cast<int>(i), argv[static_cast<size_t>(i)]);
    }

    // 阻塞直到 Node 退出
    int code = node::Start(static_cast<int>(argc), argv.data());
    LOGI("node exited with code %d", code);

    free(buffer);
    return code;
}
