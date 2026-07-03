---
title: Qt 项目里为什么我把扫描模块做成 C 接口 DLL
published: 2026-07-03
description: '结合 FileScanner 项目，拆解 Qt/C++ 文件扫描模块为什么选择 C 接口 DLL：ABI、opaque handle、回调、宽字符路径和跨 DLL 内存边界。'
image: ''
tags: [Qt, C++, DLL, Win32, 接口设计]
category: 技术笔记
draft: false
lang: zh
---

这个文件扫描器一开始看起来只是一个小工具：给一个目录，扫出下面所有文件，实时通知当前扫到哪一个，结束后把结果交给调用方。真正写起来以后，最先需要决定的不是界面怎么画，而是模块边界怎么切。

我最后把扫描能力放进一个独立 DLL，外面只暴露一组 C 风格函数。Qt 界面只是调用方，不直接依赖扫描引擎的内部类。这个设计在小项目里看起来稍微“绕”一点，但它解决了几个实际问题：ABI 稳定、调用方简单、内部实现可以随时调整。

## C++ 类不直接导出的原因

扫描引擎内部肯定会用 C++：`std::thread`、`std::mutex`、`std::vector`、`std::wstring` 都很合适。但如果直接把 C++ 类导出给 DLL 使用者，就会引出一些没必要的耦合。

比如 C++ 函数名会发生 name mangling，不同编译器、不同版本的 ABI 细节也不完全一样。这个项目目前是 Qt + MinGW，但如果以后要被 C#、Python、另一个 C++ 程序调用，直接导出 C++ 类会让调用成本变高。

所以 DLL 对外只保留 C 接口：

```cpp
extern C {

typedef void* FileScannerHandle;

FILESCANNER_API FileScannerHandle FileScanner_Create(void);
FILESCANNER_API void FileScanner_Destroy(FileScannerHandle handle);

FILESCANNER_API int FileScanner_Start(FileScannerHandle handle,
                                      const wchar_t* rootPath,
                                      FileScanProgressFn progress,
                                      FileScanFinishedFn finished,
                                      void* userData);

FILESCANNER_API void FileScanner_Cancel(FileScannerHandle handle);

}
```

这里最关键的是两点：`extern C` 保证导出符号按 C 规则生成，函数名更稳定；`FileScannerHandle` 用 `void*` 表示，不暴露内部 C++ 类型。

这个写法有点像 Win32 API 的风格。调用方拿到的是句柄，不需要知道句柄背后到底是类、结构体，还是一组资源。

## 句柄背后仍然是 C++ 对象

接口是 C 的，不代表内部实现也要写成 C。实际 DLL 内部包了一层很薄的对象：

```cpp
namespace {

struct ScannerInstance {
    FileScanner::FileScannerEngine engine;
};

}

extern C {

FILESCANNER_API FileScannerHandle FileScanner_Create(void)
{
    try {
        return new ScannerInstance();
    } catch (...) {
        return nullptr;
    }
}

FILESCANNER_API void FileScanner_Destroy(FileScannerHandle handle)
{
    auto* instance = static_cast<ScannerInstance*>(handle);
    delete instance;
}

}
```

这样一来，对外接口保持稳定，内部依然可以用 RAII 管理线程和资源。`FileScannerEngine` 的析构函数里会 `cancel()` 并等待线程退出，调用方只要记得 `Destroy`，资源就能被收回来。

这里我没有让调用方自己传 `new` 出来的 C++ 对象，也没有要求调用方包含内部头文件。这个边界比较干净：创建、启动、取消、查询、销毁，调用方只关心生命周期。

## 回调为什么带一个 userData

扫描过程需要不断通知调用方当前发现的文件。C 接口不能直接接收 C++ 成员函数，所以回调通常设计成普通函数指针：

```cpp
typedef void (*FileScanProgressFn)(const wchar_t* path,
                                   std::int64_t size,
                                   void* userData);
```

`userData` 是这个接口里非常实用的一笔。Qt 界面启动扫描时，把 `this` 作为 `userData` 传进去：

```cpp
FileScanner_Start(scannerHandle_,
                  widePath.c_str(),
                  &MainWindow::progressCallback,
                  &MainWindow::finishedCallback,
                  this);
```

回调函数是 `static` 的，但它可以通过 `userData` 找回窗口对象：

```cpp
void MainWindow::progressCallback(const wchar_t *path, std::int64_t size, void *userData)
{
    auto *window = static_cast<MainWindow *>(userData);
    if (window == nullptr || path == nullptr) {
        return;
    }

    // 后续再把数据转交给 Qt 主线程
}
```

这种写法比全局变量好很多。多个窗口、多个扫描器实例并存时，每个回调都能回到自己的上下文，不会互相串数据。

## 宽字符路径是 Windows 下更稳的选择

扫描底层用了 Win32 API，所以路径参数统一采用 `wchar_t*` / `std::wstring`。Windows 文件路径天然适合走宽字符版本的 API，比如：

```cpp
const DWORD attrs = GetFileAttributesW(rootPath.c_str());
const HANDLE findHandle = FindFirstFileW(searchPattern.c_str(), &findData);
```

Qt 侧拿到的是 `QString`，转换也比较直接：

```cpp
const std::wstring widePath = path.toStdWString();
```

如果这里为了省事用窄字符路径，中文目录、特殊字符路径很容易出问题。文件扫描工具最怕的就是“在我的测试目录能跑，换个用户目录就乱码”。这类问题前期多写几个 `W` 版本 API，后面会少很多麻烦。

## 结果读取为什么不用回调一次性塞满 UI

扫描中每发现一个文件都会触发 progress 回调，但最终结果不是在回调里逐条塞给 Qt 表格，而是扫描结束后让调用方主动读取：

```cpp
FILESCANNER_API int FileScanner_GetResultCount(FileScannerHandle handle);

FILESCANNER_API int FileScanner_GetResults(FileScannerHandle handle,
                                           wchar_t* pathBuffer,
                                           std::int64_t* sizeBuffer,
                                           int bufferCount,
                                           int pathCharCapacity);
```

这里的思路是把“过程通知”和“结果获取”分开。过程通知只适合做轻量展示，比如当前文件、已发现数量。最终结果可能有成千上万条，如果在扫描线程里不断推动 UI 更新，很容易把界面拖慢，也会让线程安全问题变复杂。

结果读取采用调用方预分配缓冲区的方式：

```cpp
std::vector<wchar_t> pathBuffer(static_cast<std::size_t>(count) * kPathBufferCapacity);
std::vector<std::int64_t> sizeBuffer(static_cast<std::size_t>(count));

const int fetched = FileScanner_GetResults(scannerHandle_,
                                           pathBuffer.data(),
                                           sizeBuffer.data(),
                                           count,
                                           kPathBufferCapacity);
```

这个接口不算最优雅，但它有一个优点：跨 DLL 边界时没有让 DLL 分配内存、调用方释放内存。谁申请谁释放，生命周期清楚，踩内存管理坑的概率低。

## 这个边界带来的实际收益

把 DLL 做成 C 接口后，项目结构会自然分成三层：`FileScannerApi` 是稳定函数边界，`FileScannerEngine` 是真正的扫描、多线程、取消逻辑，`MainWindow` 是 Qt 界面，只负责调用和展示。

这样拆完以后，UI 不需要知道目录队列怎么调度，扫描引擎也不需要知道界面控件是什么。后面想把界面从 `QTableWidget` 换成 model/view，或者想把扫描 DLL 给命令行程序用，核心扫描逻辑都不用改。

小项目里做边界设计，重点不是把架构画得多漂亮，而是让变化发生在该发生的地方。这个文件扫描器里，C 接口 DLL 就承担了这个作用。

> 相关阅读：[FileScanner：多线程文件扫描引擎的设计与实现](/posts/project-file-scanner/)
