cmake_minimum_required(VERSION 3.18)
project(nodebridge CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(nodebridge SHARED node-bridge.cpp)

# nodejs-mobile 头文件（node.h / v8.h 等）
include_directories(${CMAKE_SOURCE_DIR}/include/node)

# 预编译的 Node 运行时（由 jniLibs 负责打包进 APK，这里仅用于链接）
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
        IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(nodebridge libnode ${log-lib})
