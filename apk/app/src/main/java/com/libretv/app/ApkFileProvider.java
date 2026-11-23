package com.libretv.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 只为一件事存在：把 update.apk 交给系统安装器。
 *
 * Android 7 之后不允许用 file:// 把私有文件暴露给其它应用（FileUriExposedException），
 * 必须走 content:// 并临时授权。项目没有引入 AndroidX，所以这里手写一个最小 Provider，
 * 只实现 openFile / query（安装器要读文件名和大小）。
 *
 * 安全上只认白名单文件名，避免被当成任意文件读取通道。
 */
public class ApkFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.libretv.app.apk";
    private static final String APK_NAME = "update.apk";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = resolve(uri);
        if (file == null || !file.isFile()) {
            return null;
        }
        String[] columns = {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(new Object[]{file.getName(), file.length()});
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        if (file == null || !file.isFile()) {
            throw new FileNotFoundException(String.valueOf(uri));
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    /** 只允许读运行目录下的 update.apk */
    private File resolve(Uri uri) {
        if (getContext() == null) {
            return null;
        }
        String name = uri.getLastPathSegment();
        if (!APK_NAME.equals(name)) {
            return null;
        }
        return new File(new File(getContext().getFilesDir(), "libretv"), APK_NAME);
    }
}
